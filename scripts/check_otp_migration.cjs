const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

(async () => {
    const checks = await Promise.all([
        pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_admin'"),
        pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name IN ('status','last_purchase_at','idempotency_key') ORDER BY column_name"),
        pool.query("SELECT to_regclass('public.balance_adjustments') AS table_name"),
        pool.query("SELECT to_regclass('public.idx_orders_open_service_country_unique') AS index_name")
    ]);

    console.log({
        users_is_admin_column: checks[0].rowCount > 0,
        orders_columns: checks[1].rows.map((row) => row.column_name),
        balance_adjustments_table: checks[2].rows[0]?.table_name,
        open_order_unique_index: checks[3].rows[0]?.index_name
    });

    await pool.end();
})().catch(async (err) => {
    console.error(err.message);
    try {
        await pool.end();
    } catch {
    }
    process.exit(1);
});
