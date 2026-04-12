const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const sqlFileArg = process.argv[2];
if (!sqlFileArg) {
    console.error('Usage: node scripts/run_sql_file.cjs <relative-sql-file>');
    process.exit(1);
}

const sqlPath = path.isAbsolute(sqlFileArg)
    ? sqlFileArg
    : path.join(process.cwd(), sqlFileArg);

if (!fs.existsSync(sqlPath)) {
    console.error(`SQL file not found: ${sqlPath}`);
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWithRetry(sql, retries = 5, delayMs = 3000) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            await pool.query(sql);
            return;
        } catch (err) {
            lastError = err;
            const isTransientDnsError = err && (err.code === 'EAI_AGAIN' || /EAI_AGAIN/i.test(String(err.message || '')));
            if (!isTransientDnsError || attempt === retries) {
                throw err;
            }
            console.warn(`Transient DNS error on attempt ${attempt}/${retries}. Retrying in ${delayMs}ms...`);
            await sleep(delayMs);
        }
    }
    throw lastError;
}

(async () => {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await executeWithRetry(sql);
    console.log(`Executed SQL file successfully: ${sqlPath}`);
    await pool.end();
})().catch(async (err) => {
    console.error('SQL execution failed:', err.message);
    try {
        await pool.end();
    } catch {
    }
    process.exit(1);
});
