const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

(async () => {
    const result = await pool.query(
        "SELECT api_code, COUNT(*)::int AS count FROM services WHERE api_code IN ('ig', 'fu', 'fb') GROUP BY api_code ORDER BY api_code"
    );
    console.log(result.rows);
    await pool.end();
})().catch(async (err) => {
    console.error(err.message);
    try {
        await pool.end();
    } catch {
    }
    process.exit(1);
});
