-- 1) Users with multiple completed orders for same service/country within 5 minutes
WITH completed_orders AS (
    SELECT
        o.user_id,
        COALESCE(u.email, o.user_email, '') AS user_email,
        COALESCE(o.service_type, '') AS service_type,
        COALESCE(o.country, '') AS country,
        o.created_at,
        LAG(o.created_at) OVER (
            PARTITION BY o.user_id, COALESCE(o.service_type, ''), COALESCE(o.country, '')
            ORDER BY o.created_at
        ) AS previous_created_at
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE COALESCE(o.status, o.order_status, 'pending') = 'completed'
)
SELECT
    user_id,
    user_email,
    service_type,
    country,
    created_at,
    previous_created_at,
    EXTRACT(EPOCH FROM (created_at - previous_created_at))::int AS seconds_since_previous
FROM completed_orders
WHERE previous_created_at IS NOT NULL
  AND (created_at - previous_created_at) <= INTERVAL '5 minutes'
ORDER BY created_at DESC;

-- 2) Users whose order count is higher than approved deposits count
WITH per_user AS (
    SELECT
        u.id AS user_id,
        u.email,
        COUNT(o.id) FILTER (WHERE COALESCE(o.status, o.order_status, 'pending') IN ('pending', 'active', 'completed', 'expired', 'cancelled')) AS total_orders,
        COUNT(t.id) FILTER (WHERE LOWER(COALESCE(t.type, '')) = 'deposit' AND LOWER(COALESCE(t.status, 'pending')) = 'approved') AS approved_deposits,
        COALESCE(SUM(t.amount) FILTER (WHERE LOWER(COALESCE(t.type, '')) = 'deposit' AND LOWER(COALESCE(t.status, 'pending')) = 'approved'), 0) AS deposited_amount,
        COALESCE(SUM(o.price), 0) AS total_order_amount
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    LEFT JOIN transactions t ON t.user_id = u.id
    GROUP BY u.id, u.email
)
SELECT
    user_id,
    email,
    total_orders,
    approved_deposits,
    deposited_amount,
    total_order_amount,
    (total_orders - approved_deposits) AS suspicious_gap
FROM per_user
WHERE total_orders > approved_deposits
ORDER BY suspicious_gap DESC, total_orders DESC;
