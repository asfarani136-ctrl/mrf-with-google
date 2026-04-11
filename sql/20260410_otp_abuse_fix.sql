BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
UPDATE users
SET is_admin = TRUE
WHERE LOWER(COALESCE(role, 'user')) = 'admin';

CREATE TABLE IF NOT EXISTS balance_adjustments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL,
    reason TEXT NOT NULL,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_balance_adjustments_user_id ON balance_adjustments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_adjustments_admin_id ON balance_adjustments (admin_id, created_at DESC);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

UPDATE orders
SET last_purchase_at = COALESCE(last_purchase_at, created_at, CURRENT_TIMESTAMP);

UPDATE orders
SET status = CASE
    WHEN LOWER(COALESCE(order_status, '')) = 'completed' THEN 'completed'
    WHEN LOWER(COALESCE(order_status, '')) IN ('expired_refunded', 'expired') THEN 'expired'
    WHEN LOWER(COALESCE(order_status, '')) = 'cancelled' THEN 'cancelled'
    WHEN otp_received = TRUE OR LOWER(COALESCE(order_status, '')) = 'otp_received' THEN 'active'
    WHEN LOWER(COALESCE(order_status, '')) = 'active' THEN 'pending'
    ELSE 'pending'
END;

CREATE INDEX IF NOT EXISTS idx_orders_user_service_country_status ON orders (user_id, service_type, country_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_user_service_last_purchase ON orders (user_id, service_type, last_purchase_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idempotency_key ON orders (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

WITH ranked_open_orders AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY user_id, service_type, country_id
            ORDER BY created_at DESC, id DESC
        ) AS rn
    FROM orders
    WHERE COALESCE(status, order_status, 'pending') IN ('pending', 'active')
)
UPDATE orders o
SET
    status = 'expired',
    order_status = 'expired',
    completed_at = COALESCE(o.completed_at, CURRENT_TIMESTAMP)
FROM ranked_open_orders r
WHERE o.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_open_service_country_unique
    ON orders (user_id, service_type, country_id)
    WHERE COALESCE(status, order_status, 'pending') IN ('pending', 'active');

COMMIT;
