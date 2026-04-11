require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const createAuthRouter = require('./routes/auth');

const app = express();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const upload = multer({ dest: UPLOAD_DIR });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    console.error('SESSION_SECRET is missing or too short.');
    process.exit(1);
}

const SMSBOWER_API_KEY = process.env.SMSBOWER_API_KEY || 'CHANGE_THIS_API_KEY';
const SMSBOWER_URL = 'https://smsbower.page/stubs/handler_api.php';

const SMSBOWER_WA_SERVICE = 'wa';
const SMSBOWER_FB_SERVICE = 'fb';
const SMSBOWER_IG_SERVICE = 'ig';
const SMSBOWER_SNAPCHAT_SERVICE = 'fu';
const SMSBOWER_GOOGLE_SERVICE = 'go';

const EXPIRED_REFUND_MESSAGE = 'Time expired. Your money has been returned to your wallet.';
const ORDER_COOLDOWN_SECONDS = 30;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = String(process.env.BASE_URL || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/auth/google/callback`;
const APP_BASE_URL = BASE_URL;
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || '';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const PASSWORD_RESET_TOKEN_TTL_MS = 1000 * 60 * 60;

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: IS_PROD ? { rejectUnauthorized: false } : false
});

const mailTransporter = SMTP_HOST && SMTP_FROM
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
    })
    : null;

const paymentRateLimiter = {};

async function removeUploadedFile(fileName) {
    const normalizedName = path.basename(String(fileName || '').trim());
    if (!normalizedName) return;
    const filePath = path.join(UPLOAD_DIR, normalizedName);
    try {
        await fs.promises.unlink(filePath);
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            console.warn(`Could not remove upload ${normalizedName}: ${err.message}`);
        }
    }
}

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.get(['/', '/index.html', '/dashboard'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.use(express.static('public', { index: false }));

app.use(session({
    store: new pgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    name: 'mrf.sid',
    secret: SESSION_SECRET,
    proxy: true,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    unset: 'destroy',
    cookie: {
        secure: 'auto',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));

app.use(passport.initialize());
app.use(passport.session());

function normalizeUser(row) {
    if (!row) return null;
    return {
        ...row,
        balance: Number(row.balance || 0),
        is_admin: Boolean(row.is_admin),
        referralCode: row.referral_code,
        is_active: row.is_active,
        login_attempts: row.login_attempts
    };
}

function normalizeOrderStatus(row) {
    const rawStatus = String(row?.status || row?.order_status || '').toLowerCase();
    if (rawStatus === 'expired_refunded') return 'expired';
    if (rawStatus === 'otp_received') return 'active';
    if (rawStatus === 'retry_requested') return row?.otp_received ? 'active' : 'pending';
    if (rawStatus === 'active' && !row?.otp_received) return 'pending';
    if (rawStatus === 'pending' && row?.otp_received) return 'active';
    if (rawStatus === 'expired' || rawStatus === 'completed' || rawStatus === 'cancelled' || rawStatus === 'pending' || rawStatus === 'active') {
        return rawStatus;
    }
    if (row?.otp_received) return 'active';
    return 'pending';
}

function normalizeOrder(row) {
    if (!row) return null;
    const status = normalizeOrderStatus(row);
    return {
        ...row,
        price: Number(row.price || 0),
        provider_cost_pkr: Number(row.provider_cost_pkr || 0),
        client_balance_left: row.client_balance_left == null ? null : Number(row.client_balance_left),
        profit_pkr: row.profit_pkr == null ? null : Number(row.profit_pkr),
        otp_received: row.otp_received,
        status
    };
}

function isAdminUser(user) {
    return Boolean(user && (user.is_admin || String(user.role || '').toLowerCase() === 'admin'));
}

function normalizeTransaction(row) {
    if (!row) return null;
    return {
        ...row,
        amount: Number(row.amount || 0),
        user_name: row.user_name || '',
        user_email: row.user_email || ''
    };
}

function normalizePaymentRequest(row) {
    if (!row) return null;
    return {
        ...row,
        amount: Number(row.amount || 0),
        user_name: row.user_name || '',
        user_email: row.user_email || ''
    };
}

async function queryOne(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
}

async function queryAll(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows;
}

async function queryRun(sql, params = []) {
    return pool.query(sql, params);
}

function isPasswordHashed(password) {
    return typeof password === 'string' && /^\$2[aby]\$\d{2}\$/.test(password);
}

async function hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(inputPassword, storedPassword) {
    if (!storedPassword || typeof storedPassword !== 'string') {
        return { valid: false, needsUpgrade: false };
    }
    if (isPasswordHashed(storedPassword)) {
        const valid = await bcrypt.compare(inputPassword, storedPassword);
        return { valid, needsUpgrade: false };
    }
    const valid = inputPassword === storedPassword;
    return { valid, needsUpgrade: valid };
}

function sanitizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
    return typeof password === 'string' && password.length >= 6;
}

function randomPassword() {
    return crypto.randomBytes(24).toString('hex');
}

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pkrToUsd(pkr) {
    return parseFloat((pkr / 280).toFixed(3));
}

function formatSafeError(err, fallback = 'Server error') {
    if (!err) return fallback;
    if (typeof err.message === 'string' && err.message.trim()) return err.message;
    return fallback;
}

function isMailConfigured() {
    return Boolean(mailTransporter);
}

function hashToken(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function buildAbsoluteUrl(relativePath) {
    const normalizedPath = `/${String(relativePath || '').replace(/^\/+/, '')}`;
    if (!APP_BASE_URL) {
        return normalizedPath;
    }
    const base = APP_BASE_URL.endsWith('/') ? APP_BASE_URL : `${APP_BASE_URL}/`;
    return new URL(normalizedPath.replace(/^\//, ''), base).toString();
}

async function sendPasswordResetEmail(user, token) {
    if (!mailTransporter) {
        throw new Error('Password reset email is not configured');
    }
    const resetUrl = buildAbsoluteUrl(`/reset-password.html?token=${encodeURIComponent(token)}`);
    const recipientName = String(user.name || 'there').trim();
    await mailTransporter.sendMail({
        from: SMTP_FROM,
        to: user.email,
        subject: 'Reset your MRF SMS password',
        text: `Hello ${recipientName},\n\nUse this link to reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you did not request it, you can safely ignore this email.`,
        html: `
            <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:32px;">
                <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid #e2e8f0;box-shadow:0 16px 40px rgba(15,23,42,0.08);">
                    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#64748b;margin-bottom:10px;">MRF SMS</div>
                    <h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;color:#0f172a;">Reset your password</h1>
                    <p style="margin:0 0 20px;color:#475569;line-height:1.7;">Hello ${recipientName}, we received a request to reset your password. Click the button below to continue.</p>
                    <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:14px;font-weight:700;">Reset Password</a>
                    <p style="margin:20px 0 0;color:#64748b;line-height:1.7;">This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>
                    <p style="margin:20px 0 0;color:#94a3b8;font-size:12px;word-break:break-all;">Direct link: ${resetUrl}</p>
                </div>
            </div>
        `
    });
}

async function initDB() {
    await queryRun(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT,
            balance NUMERIC(12,2) DEFAULT 0,
            role TEXT DEFAULT 'user',
            is_admin BOOLEAN DEFAULT FALSE,
            referral_code TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            login_attempts INTEGER DEFAULT 0,
            last_login TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await queryRun(`
        CREATE TABLE IF NOT EXISTS balance_adjustments (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            amount NUMERIC(12,2) NOT NULL,
            reason TEXT NOT NULL,
            admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await queryRun('CREATE INDEX IF NOT EXISTS idx_balance_adjustments_user_id ON balance_adjustments (user_id, created_at DESC)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_balance_adjustments_admin_id ON balance_adjustments (admin_id, created_at DESC)');

    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_token)');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "googleId" TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "displayName" TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "photo" TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE');
    await queryRun("UPDATE users SET is_admin = TRUE WHERE LOWER(COALESCE(role, 'user')) = 'admin'");
    await queryRun('CREATE UNIQUE INDEX IF NOT EXISTS users_googleId_unique_idx ON users ("googleId") WHERE "googleId" IS NOT NULL');

    await queryRun(`
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            user_email TEXT,
            service_type TEXT,
            service_name TEXT,
            country TEXT,
            country_code TEXT,
            country_id INTEGER,
            price NUMERIC(12,2),
            provider_cost_pkr NUMERIC(12,2) DEFAULT 0,
            payment_method TEXT,
            payment_status TEXT DEFAULT 'pending',
            order_status TEXT DEFAULT 'pending',
            status TEXT DEFAULT 'pending',
            phone_number TEXT,
            activation_id TEXT,
            otp_received BOOLEAN DEFAULT FALSE,
            otp_code TEXT,
            expires_at TIMESTAMPTZ,
            cancel_available_at TIMESTAMPTZ,
            last_purchase_at TIMESTAMPTZ,
            idempotency_key TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ
        )
    `);

    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_cost_pkr NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT \'pending\'');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT');
    await queryRun('UPDATE orders SET last_purchase_at = COALESCE(last_purchase_at, created_at, CURRENT_TIMESTAMP)');
    await queryRun(`
        UPDATE orders
        SET status = CASE
            WHEN LOWER(COALESCE(order_status, '')) = 'completed' THEN 'completed'
            WHEN LOWER(COALESCE(order_status, '')) IN ('expired_refunded', 'expired') THEN 'expired'
            WHEN LOWER(COALESCE(order_status, '')) = 'cancelled' THEN 'cancelled'
            WHEN otp_received = TRUE OR LOWER(COALESCE(order_status, '')) = 'otp_received' THEN 'active'
            WHEN LOWER(COALESCE(order_status, '')) = 'active' THEN 'pending'
            ELSE 'pending'
        END
    `);

    await queryRun(`
        UPDATE orders
        SET
            status = 'completed',
            order_status = 'completed',
            completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
        WHERE created_at <= CURRENT_TIMESTAMP - INTERVAL '1 hour'
          AND (
              COALESCE(otp_received, FALSE) = TRUE
              OR NULLIF(TRIM(COALESCE(otp_code, '')), '') IS NOT NULL
              OR LOWER(COALESCE(order_status, '')) = 'otp_received'
          )
          AND LOWER(COALESCE(status, order_status, 'pending')) NOT IN ('completed', 'cancelled', 'expired', 'expired_refunded')
    `);
    await queryRun('CREATE INDEX IF NOT EXISTS idx_orders_user_service_country_status ON orders (user_id, service_type, country_id, status)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_orders_user_service_last_purchase ON orders (user_id, service_type, last_purchase_at DESC)');
    await queryRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idempotency_key ON orders (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
    await queryRun(`
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
          AND r.rn > 1
    `);
    await queryRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_open_service_country_unique ON orders (user_id, service_type, country_id) WHERE COALESCE(status, order_status, 'pending') IN ('pending', 'active')");

    await queryRun(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            user_email TEXT,
            amount NUMERIC(12,2),
            screenshot TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await queryRun(`
        CREATE TABLE IF NOT EXISTS payment_requests (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            user_email TEXT,
            amount NUMERIC(12,2),
            transaction_id TEXT UNIQUE,
            screenshot TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
        const adminEmail = sanitizeEmail(ADMIN_EMAIL);
        const existingAdmin = normalizeUser(await queryOne('SELECT * FROM users WHERE email = $1', [adminEmail]));
        if (!existingAdmin) {
            const hashedAdminPassword = await hashPassword(ADMIN_PASSWORD);
            await queryRun(
                'INSERT INTO users (email, password, name, role, is_admin, referral_code) VALUES ($1, $2, $3, $4, $5, $6)',
                [adminEmail, hashedAdminPassword, ADMIN_NAME, 'admin', true, 'ADMIN']
            );
            console.log('Admin user created from environment variables');
        } else if (!isAdminUser(existingAdmin)) {
            await queryRun('UPDATE users SET role = $1, is_admin = TRUE WHERE id = $2', ['admin', existingAdmin.id]);
            console.log('Existing admin email promoted to admin privileges');
        }
    } else {
        console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set, skipping admin auto-create');
    }

    await queryRun(`
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='transaction_id') THEN
        ALTER TABLE transactions ADD COLUMN transaction_id TEXT;
    END IF;
END $$;
    `);
    await queryRun('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type TEXT DEFAULT \'deposit\'');
    await queryRun('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT');
    await queryRun('UPDATE transactions SET type = $1 WHERE type IS NULL', ['deposit']);
}

async function findUser(email) {
    return normalizeUser(await queryOne('SELECT * FROM users WHERE email = $1', [sanitizeEmail(email)]));
}

async function findUserById(id) {
    return normalizeUser(await queryOne('SELECT * FROM users WHERE id = $1', [id]));
}

async function createUser(name, email, password) {
    const referralCode = Math.random().toString(36).substring(2, 10).toUpperCase();
    const hashedPassword = await hashPassword(password);
    return queryRun(
        'INSERT INTO users (email, password, name, referral_code) VALUES ($1, $2, $3, $4)',
        [sanitizeEmail(email), hashedPassword, String(name || '').trim(), referralCode]
    );
}

async function updateUserPassword(userId, newPlainPassword) {
    const hashed = await hashPassword(newPlainPassword);
    return queryRun('UPDATE users SET password = $1 WHERE id = $2', [hashed, userId]);
}

async function updateUserPasswordHash(userId, hashedPassword) {
    return queryRun('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
}

async function savePasswordResetToken(userId, tokenHash, expiresAt) {
    return queryRun(
        'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
        [tokenHash, expiresAt, userId]
    );
}

async function clearPasswordResetToken(userId) {
    return queryRun(
        'UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE id = $1',
        [userId]
    );
}

async function findUserByResetToken(token) {
    const tokenHash = hashToken(token);
    return normalizeUser(await queryOne(
        'SELECT * FROM users WHERE reset_token = $1 AND reset_token_expires > CURRENT_TIMESTAMP',
        [tokenHash]
    ));
}

async function getAllPaymentRequests() {
    const rows = await queryAll(`
        SELECT
            pr.*,
            COALESCE(u.name, '') AS user_name,
            COALESCE(u.email, pr.user_email) AS user_email
        FROM payment_requests pr
        LEFT JOIN users u ON u.id = pr.user_id
        ORDER BY pr.id DESC
    `);
    return rows.map(normalizePaymentRequest);
}

async function getPaymentHistoryByUser(userId) {
    const rows = await queryAll(`
        SELECT
            pr.*,
            COALESCE(u.name, '') AS user_name,
            COALESCE(u.email, pr.user_email) AS user_email
        FROM payment_requests pr
        LEFT JOIN users u ON u.id = pr.user_id
        WHERE pr.user_id = $1
        ORDER BY pr.id DESC
    `, [userId]);
    return rows.map(normalizePaymentRequest);
}

async function getPendingTransactions() {
    const rows = await queryAll(`
        SELECT
            t.*,
            COALESCE(u.name, '') AS user_name,
            COALESCE(u.email, t.user_email) AS user_email
        FROM transactions t
        LEFT JOIN users u ON u.id = t.user_id
        WHERE t.status = $1
        ORDER BY t.id DESC
    `, ['pending']);
    return rows.map(normalizeTransaction);
}

async function getTransactionHistory() {
    const rows = await queryAll(`
        SELECT
            t.*,
            COALESCE(u.name, '') AS user_name,
            COALESCE(u.email, t.user_email) AS user_email
        FROM transactions t
        LEFT JOIN users u ON u.id = t.user_id
        WHERE t.status <> $1
        ORDER BY t.id DESC
    `, ['pending']);
    return rows.map(normalizeTransaction);
}

async function approveTransaction(txId) {
    const client = await pool.connect();
    let screenshotToDelete = null;
    try {
        await client.query('BEGIN');
        const txRes = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
        const tx = txRes.rows[0];
        if (!tx) throw new Error('Transaction not found');
        if (tx.status !== 'pending') throw new Error('Only pending transactions can be approved');
        screenshotToDelete = tx.screenshot || null;
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [tx.user_id]);
        const user = userRes.rows[0];
        if (!user) throw new Error('User not found');
        await client.query('UPDATE transactions SET status = $1, type = COALESCE(type, $2), screenshot = NULL WHERE id = $3', ['approved', 'deposit', txId]);
        await client.query(
            'UPDATE users SET balance = $1 WHERE id = $2',
            [Number(user.balance || 0) + Number(tx.amount || 0), tx.user_id]
        );
        await client.query('COMMIT');
        await removeUploadedFile(screenshotToDelete);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function cancelTransaction(txId) {
    const client = await pool.connect();
    let screenshotToDelete = null;
    try {
        await client.query('BEGIN');
        const txRes = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
        const tx = txRes.rows[0];
        if (!tx) throw new Error('Transaction not found');
        if (tx.status !== 'pending') throw new Error('Only pending transactions can be cancelled');
        screenshotToDelete = tx.screenshot || null;
        await client.query('UPDATE transactions SET status = $1, type = COALESCE(type, $2), screenshot = NULL WHERE id = $3', ['cancelled', 'deposit', txId]);
        await client.query('COMMIT');
        await removeUploadedFile(screenshotToDelete);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function getOrdersByUser(userId) {
    const rows = await queryAll(`
        SELECT *
        FROM orders
        WHERE user_id = $1
          AND COALESCE(status, order_status, 'pending') IN ('pending', 'active')
          AND LOWER(COALESCE(status, 'pending')) NOT IN ('completed', 'cancelled', 'expired', 'expired_refunded')
          AND LOWER(COALESCE(order_status, 'pending')) NOT IN ('completed', 'cancelled', 'expired', 'expired_refunded')
        ORDER BY id DESC
    `, [userId]);
    return rows.map(normalizeOrder);
}

async function getAdminUsers() {
    const rows = await queryAll(`
        SELECT id, name, email, balance, role, is_admin, created_at
        FROM users
        ORDER BY id DESC
    `);
    return rows.map(normalizeUser);
}

async function getAllBalanceAdjustments(limit = 300) {
    const rows = await queryAll(`
        SELECT
            ba.*,
            COALESCE(target_user.email, '') AS user_email,
            COALESCE(target_user.name, '') AS user_name,
            COALESCE(admin_user.email, '') AS admin_email,
            COALESCE(admin_user.name, '') AS admin_name
        FROM balance_adjustments ba
        LEFT JOIN users target_user ON target_user.id = ba.user_id
        LEFT JOIN users admin_user ON admin_user.id = ba.admin_id
        ORDER BY ba.created_at DESC
        LIMIT $1
    `, [limit]);
    return rows.map((row) => ({
        ...row,
        amount: Number(row.amount || 0)
    }));
}

async function getUserCombinedHistory(userId, limit = 300) {
    const rows = await queryAll(`
        SELECT *
        FROM (
            SELECT
                'purchase'::text AS entry_type,
                o.id::text AS reference_id,
                -COALESCE(o.price, 0)::numeric AS amount,
                CONCAT(COALESCE(o.service_name, 'Service'), ' • ', COALESCE(o.country, 'Unknown country')) AS details,
                COALESCE(o.status, o.order_status, 'pending') AS status,
                o.created_at AS created_at
            FROM orders o
            WHERE o.user_id = $1

            UNION ALL

            SELECT
                'deposit'::text AS entry_type,
                t.id::text AS reference_id,
                COALESCE(t.amount, 0)::numeric AS amount,
                COALESCE(t.description, 'Wallet deposit approved') AS details,
                COALESCE(t.status, 'approved') AS status,
                t.created_at AS created_at
            FROM transactions t
            WHERE t.user_id = $1
              AND LOWER(COALESCE(t.type, '')) IN ('deposit')

            UNION ALL

            SELECT
                'manual_adjustment'::text AS entry_type,
                ba.id::text AS reference_id,
                COALESCE(ba.amount, 0)::numeric AS amount,
                ba.reason AS details,
                'approved'::text AS status,
                ba.created_at AS created_at
            FROM balance_adjustments ba
            WHERE ba.user_id = $1
        ) ledger
        ORDER BY created_at DESC
        LIMIT $2
    `, [userId, limit]);
    return rows.map((row) => ({
        ...row,
        amount: Number(row.amount || 0)
    }));
}

async function applyAdminBalanceAdjustment({ userId, adminId, amount, reason }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const targetUser = userRes.rows[0];
        if (!targetUser) throw new Error('Target user not found');

        const updatedUserRes = await client.query(
            'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2 RETURNING *',
            [amount, userId]
        );
        const updatedUser = updatedUserRes.rows[0];

        await client.query(
            'INSERT INTO balance_adjustments (user_id, amount, reason, admin_id) VALUES ($1, $2, $3, $4)',
            [userId, amount, reason, adminId]
        );

        await client.query(
            'INSERT INTO transactions (user_id, user_email, amount, type, status, description) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, targetUser.email, amount, 'manual_adjustment', 'approved', `Manual balance adjustment: ${reason}`]
        );

        await client.query('COMMIT');
        return normalizeUser(updatedUser);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function getOrderById(orderId) {
    return normalizeOrder(await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]));
}

async function updateOrder(orderId, updates) {
    const keys = Object.keys(updates);
    if (!keys.length) return;
    const fields = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    const values = keys.map((key) => updates[key]);
    values.push(orderId);
    await queryRun(`UPDATE orders SET ${fields} WHERE id = $${values.length}`, values);
}

async function updateProviderActivationStatus(activationId, status) {
    if (!activationId) return { success: false, skipped: true };
    try {
        const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=setStatus&id=${activationId}&status=${status}`;
        await axios.get(url, { timeout: 15000 });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function expireOrderAndRefund(orderId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
        const order = orderRes.rows[0];
        if (!order) {
            await client.query('ROLLBACK');
            return { found: false, expired: false, refunded: false, order: null };
        }
        if (String(order.status || order.order_status || '').toLowerCase() === 'expired') {
            await client.query('COMMIT');
            return {
                found: true,
                expired: true,
                refunded: true,
                order: normalizeOrder(order),
                message: EXPIRED_REFUND_MESSAGE
            };
        }
        const expiry = order.expires_at ? new Date(order.expires_at) : null;
        const now = new Date();
        if (String(order.status || order.order_status || '').toLowerCase() !== 'pending' || order.otp_received || !expiry || now < expiry) {
            await client.query('COMMIT');
            return {
                found: true,
                expired: false,
                refunded: false,
                order: normalizeOrder(order)
            };
        }
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [order.user_id]);
        const user = userRes.rows[0] || null;
        await updateProviderActivationStatus(order.activation_id, 8);
        if (user) {
            await client.query('UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2', [
                Number(order.price || 0),
                user.id
            ]);
        }
        const updatedRes = await client.query(
            'UPDATE orders SET order_status = $1, status = $2 WHERE id = $3 RETURNING *',
            ['expired', 'expired', order.id]
        );
        await client.query('COMMIT');
        return {
            found: true,
            expired: true,
            refunded: Boolean(user),
            order: normalizeOrder(updatedRes.rows[0]),
            message: EXPIRED_REFUND_MESSAGE
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function reconcileExpiredOrdersForUser(userId) {
    const rows = await queryAll(`
        SELECT id
        FROM orders
        WHERE user_id = $1
          AND COALESCE(status, order_status, 'pending') = 'pending'
          AND otp_received = FALSE
          AND expires_at <= CURRENT_TIMESTAMP
        ORDER BY id DESC
    `, [userId]);
    for (const row of rows) {
        await expireOrderAndRefund(row.id);
    }
}

async function getAllOrders() {
    const rows = await queryAll(`
        SELECT
            o.*,
            COALESCE(u.email, o.user_email) AS user_email,
            COALESCE(u.balance, 0) AS client_balance_left,
            CASE
                WHEN COALESCE(o.provider_cost_pkr, 0) > 0
                    THEN ROUND((COALESCE(o.price, 0) - COALESCE(o.provider_cost_pkr, 0))::numeric, 2)
                ELSE NULL
            END AS profit_pkr
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        ORDER BY o.id DESC
    `);
    return rows.map(normalizeOrder);
}

async function updateUserLoginAttempts(userId, attempts) {
    return queryRun('UPDATE users SET login_attempts = $1 WHERE id = $2', [attempts, userId]);
}

async function updateUserLastLogin(userId) {
    return queryRun('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
}

const whatsappCountries = [
    { name: 'South Africa', code: '+27', price: 170, countryId: 31, flag: '🇿🇦' },
    { name: 'Indonesia', code: '+62', price: 200, countryId: 6, flag: '🇮🇩' },
    { name: 'Canada', code: '+1', price: 210, countryId: 36, flag: '🇨🇦' },
    { name: 'Philippines', code: '+63', price: 210, countryId: 4, flag: '🇵🇭' },
    { name: 'Thailand', code: '+66', price: 300, countryId: 52, flag: '🇹🇭' },
    { name: 'Vietnam', code: '+84', price: 210, countryId: 10, flag: '🇻🇳' },
    { name: 'Colombia', code: '+57', price: 270, countryId: 33, flag: '🇨🇴' },
    { name: 'Saudi Arabia', code: '+966', price: 320, countryId: 53, flag: '🇸🇦' },
    { name: 'Brazil', code: '+55', price: 370, countryId: 73, flag: '🇧🇷' },
    { name: 'USA', code: '+1', price: 400, countryId: 187, flag: '🇺🇸' },
    { name: 'United Kingdom', code: '+44', price: 450, countryId: 16, flag: '🇬🇧' }
];

const facebookCountries = [
    { name: 'Canada', code: '+1', price: 75, countryId: 36, flag: '🇨🇦' },
    
    { name: 'USA', code: '+1', price: 75, countryId: 187, flag: '🇺🇸' },
    { name: 'Indonesia', code: '+62', price: 27, countryId: 6, flag: '🇮🇩' },
    { name: 'Ethiopia', code: '+251', price: 31, countryId: 71, flag: '🇪🇹' },
    { name: 'USA Virtual', code: '+1', price: 70, countryId: 12, flag: '🇺🇸' },
    { name: 'Afghanistan', code: '+93', price: 31, countryId: 74, flag: '🇦🇫' },
    { name: 'Peru', code: '+51', price: 33, countryId: 65, flag: '🇵🇪' },
    { name: 'Egypt', code: '+20', price: 30, countryId: 21, flag: '🇪🇬' },
    { name: 'Georgia', code: '+995', price: 34, countryId: 128, flag: '🇬🇪' },
    { name: 'Finland', code: '+358', price: 29, countryId: 163, flag: '🇫🇮' },
    { name: 'Papua New Guinea', code: '+675', price: 70, countryId: 79, flag: '🇵🇬' },
    { name: "Ivory Coast", code: '+225', price: 32, countryId: 27, flag: '🇨🇮' },
    { name: 'Chad', code: '+235', price: 31, countryId: 42, flag: '🇹🇩' },
    { name: 'Nepal', code: '+977', price: 33, countryId: 81, flag: '🇳🇵' },
    { name: 'Moldova', code: '+373', price: 30, countryId: 85, flag: '🇲🇩' },
    { name: 'Croatia', code: '+385', price: 34, countryId: 45, flag: '🇭🇷' },
    { name: 'Nicaragua', code: '+505', price: 29, countryId: 90, flag: '🇳🇮' },
    { name: 'Cuba', code: '+53', price: 120, countryId: 113, flag: '🇨🇺' },
    { name: 'Mongolia', code: '+976', price: 32, countryId: 72, flag: '🇲🇳' },
    { name: 'Slovenia', code: '+386', price: 31, countryId: 59, flag: '🇸🇮' },
    { name: 'Benin', code: '+229', price: 33, countryId: 120, flag: '🇧🇯' },
    { name: 'Belarus', code: '+375', price: 100, countryId: 51, flag: '🇧🇾' },
    { name: 'Botswana', code: '+267', price: 100, countryId: 123, flag: '🇧🇼' },
    { name: 'DR Congo', code: '+243', price: 30, countryId: 18, flag: '🇨🇩' },
    { name: 'Madagascar', code: '+261', price: 34, countryId: 17, flag: '🇲🇬' },
    { name: 'Algeria', code: '+213', price: 29, countryId: 58, flag: '🇩🇿' },
    { name: 'Austria', code: '+43', price: 32, countryId: 50, flag: '🇦🇹' },
    { name: 'Panama', code: '+507', price: 31, countryId: 112, flag: '🇵🇦' },
    { name: 'Norway', code: '+47', price: 33, countryId: 174, flag: '🇳🇴' },
    { name: 'Ireland', code: '+353', price: 30, countryId: 23, flag: '🇮🇪' },
    { name: 'Mauritius', code: '+230', price: 34, countryId: 157, flag: '🇲🇺' },
    { name: 'Switzerland', code: '+41', price: 29, countryId: 173, flag: '🇨🇭' },
    { name: 'Costa Rica', code: '+506', price: 60, countryId: 93, flag: '🇨🇷' },
    { name: 'Bahrain', code: '+973', price: 90, countryId: 145, flag: '🇧🇭' },
    { name: 'Gambia', code: '+220', price: 32, countryId: 28, flag: '🇬🇲' },
    { name: 'Liberia', code: '+231', price: 31, countryId: 135, flag: '🇱🇷' },
    { name: 'Angola', code: '+244', price: 33, countryId: 76, flag: '🇦🇴' },
    { name: 'Armenia', code: '+374', price: 30, countryId: 148, flag: '🇦🇲' },
    { name: 'Gabon', code: '+241', price: 34, countryId: 154, flag: '🇬🇦' },
    { name: 'Hungary', code: '+36', price: 29, countryId: 84, flag: '🇭🇺' },
    { name: 'Guinea', code: '+224', price: 32, countryId: 68, flag: '🇬🇳' },
    { name: 'Serbia', code: '+381', price: 31, countryId: 29, flag: '🇷🇸' },
    { name: 'Burundi', code: '+257', price: 33, countryId: 119, flag: '🇧🇮' },
    { name: 'South Sudan', code: '+211', price: 30, countryId: 177, flag: '🇸🇸' },
    { name: 'Maldives', code: '+960', price: 200, countryId: 159, flag: '🇲🇻' },
    { name: 'Albania', code: '+355', price: 80, countryId: 155, flag: '🇦🇱' },
    { name: 'Guinea-Bissau', code: '+245', price: 80, countryId: 130, flag: '🇬🇼' },
    { name: 'Sierra Leone', code: '+232', price: 34, countryId: 115, flag: '🇸🇱' },
    { name: 'Azerbaijan', code: '+994', price: 29, countryId: 35, flag: '🇦🇿' },
    { name: 'Slovakia', code: '+421', price: 32, countryId: 141, flag: '🇸🇰' },
    { name: 'North Macedonia', code: '+389', price: 31, countryId: 183, flag: '🇲🇰' },
    { name: 'Togo', code: '+228', price: 33, countryId: 99, flag: '🇹🇬' },
    { name: 'Lebanon', code: '+961', price: 170, countryId: 153, flag: '🇱🇧' },
    { name: 'Hong Kong', code: '+852', price: 30, countryId: 14, flag: '🇭🇰' },
    { name: 'Denmark', code: '+45', price: 33, countryId: 172, flag: '🇩🇰' },
{ name: 'Tunisia', code: '+216', price: 80, countryId: 89, flag: '🇹🇳' },
{ name: 'Kazakhstan', code: '+7', price: 30, countryId: 2, flag: '🇰🇿' },
{ name: 'Latvia', code: '+371', price: 34, countryId: 49, flag: '🇱🇻' },
{ name: 'Uganda', code: '+256', price: 29, countryId: 75, flag: '🇺🇬' },
{ name: 'Greece', code: '+30', price: 32, countryId: 129, flag: '🇬🇷' },
{ name: 'Estonia', code: '+372', price: 31, countryId: 34, flag: '🇪🇪' },
{ name: 'Fiji', code: '+679', price: 70, countryId: 189, flag: '🇫🇯' },
{ name: 'Taiwan', code: '+886', price: 33, countryId: 55, flag: '🇹🇼' },
{ name: 'Kyrgyzstan', code: '+996', price: 30, countryId: 11, flag: '🇰🇬' },
{ name: 'Bolivia', code: '+591', price: 34, countryId: 92, flag: '🇧🇴' },
{ name: 'Haiti', code: '+509', price: 29, countryId: 26, flag: '🇭🇹' },
{ name: 'Myanmar', code: '+95', price: 32, countryId: 5, flag: '🇲🇲' },
{ name: 'Dominican Republic', code: '+1', price: 70, countryId: 109, flag: '🇩🇴' },
{ name: 'Belgium', code: '+32', price: 31, countryId: 82, flag: '🇧🇪' },
{ name: 'Eswatini', code: '+268', price: 33, countryId: 106, flag: '🇸🇿' },
{ name: 'Kuwait', code: '+965', price: 90, countryId: 100, flag: '🇰🇼' },
{ name: 'Laos', code: '+856', price: 30, countryId: 25, flag: '🇱🇦' },
{ name: 'Niger', code: '+227', price: 100, countryId: 139, flag: '🇳🇪' },
{ name: 'Tajikistan', code: '+992', price: 34, countryId: 143, flag: '🇹🇯' },
{ name: 'Qatar', code: '+974', price: 90, countryId: 111, flag: '🇶🇦' },
{ name: 'El Salvador', code: '+503', price: 80, countryId: 101, flag: '🇸🇻' },
{ name: 'New Zealand', code: '+64', price: 80, countryId: 67, flag: '🇳🇿' },
{ name: 'Libya', code: '+218', price: 90, countryId: 102, flag: '🇱🇾' },
{ name: 'Honduras', code: '+504', price: 29, countryId: 88, flag: '🇭🇳' },
{ name: 'United Arab Emirates', code: '+971', price: 60, countryId: 95, flag: '🇦🇪' },
{ name: 'Namibia', code: '+264', price: 60, countryId: 138, flag: '🇳🇦' },
{ name: 'Equatorial Guinea', code: '+240', price: 80, countryId: 167, flag: '🇬🇶' },
{ name: 'Somalia', code: '+252', price: 70, countryId: 149, flag: '🇸🇴' },
{ name: 'Jordan', code: '+962', price: 32, countryId: 116, flag: '🇯🇴' },
{ name: 'Central African Republic', code: '+236', price: 32, countryId: 125, flag: '🇨🇫' },
{ name: 'Zimbabwe', code: '+263', price: 80, countryId: 96, flag: '🇿🇼' },
{ name: 'Turkmenistan', code: '+993', price: 31, countryId: 161, flag: '🇹🇲' },
{ name: 'Rwanda', code: '+250', price: 80, countryId: 140, flag: '🇷🇼' },
{ name: 'Sudan', code: '+249', price: 90, countryId: 1010, flag: '🇸🇩' },
{ name: 'Reunion', code: '+262', price: 60, countryId: 146, flag: '🇷🇪' },
{ name: 'Oman', code: '+968', price: 80, countryId: 107, flag: '🇴🇲' },
{ name: 'Bhutan', code: '+975', price: 33, countryId: 158, flag: '🇧🇹' },
{ name: 'China', code: '+86', price: 30, countryId: 3, flag: '🇨🇳' },
{ name: 'Barbados', code: '+1', price: 34, countryId: 118, flag: '🇧🇧' },
{ name: 'Martinique', code: '+596', price: 29, countryId: 1011, flag: '🇲🇶' },
{ name: 'Puerto Rico', code: '+1', price: 60, countryId: 97, flag: '🇵🇷' },
{ name: 'Guadeloupe', code: '+590', price: 32, countryId: 160, flag: '🇬🇵' },
{ name: 'Luxembourg', code: '+352', price: 31, countryId: 165, flag: '🇱🇺' },
{ name: 'Antigua and Barbuda', code: '+1', price: 33, countryId: 169, flag: '🇦🇬' },
{ name: 'Djibouti', code: '+253', price: 30, countryId: 168, flag: '🇩🇯' },
{ name: 'French Guiana', code: '+594', price: 34, countryId: 162, flag: '🇬🇫' },
{ name: 'Saint Lucia', code: '+1', price: 29, countryId: 164, flag: '🇱🇨' },
{ name: 'Montenegro', code: '+382', price: 80, countryId: 171, flag: '🇲🇪' },
{ name: 'Bahamas', code: '+1', price: 70, countryId: 122, flag: '🇧🇸' },
{ name: 'Grenada', code: '+1', price: 90, countryId: 127, flag: '🇬🇩' },
{ name: 'Brunei', code: '+673', price: 170, countryId: 121, flag: '🇧🇳' },
{ name: 'Cayman Islands', code: '+1', price: 32, countryId: 170, flag: '🇰🇾' },
{ name: 'Saint Vincent', code: '+1', price: 31, countryId: 166, flag: '🇻🇨' },
{ name: 'Saint Kitts and Nevis', code: '+1', price: 33, countryId: 134, flag: '🇰🇳' },
{ name: 'Aruba', code: '+297', price: 30, countryId: 179, flag: '🇦🇼' },
{ name: 'Comoros', code: '+269', price: 80, countryId: 133, flag: '🇰🇲' },
{ name: 'Malta', code: '+356', price: 34, countryId: 199, flag: '🇲🇹' },
{ name: 'Singapore', code: '+65', price: 29, countryId: 196, flag: '🇸🇬' },
{ name: 'Anguilla', code: '+1', price: 80, countryId: 181, flag: '🇦🇮' },
{ name: 'Sao Tome and Principe', code: '+239', price: 32, countryId: 178, flag: '🇸🇹' },
{ name: 'Palestine', code: '+970', price: 31, countryId: 188, flag: '🇵🇸' },
{ name: 'Monaco', code: '+377', price: 33, countryId: 144, flag: '🇲🇨' },
{ name: 'Belize', code: '+501', price: 70, countryId: 124, flag: '🇧🇿' },
{ name: 'New Caledonia', code: '+687', price: 30, countryId: 185, flag: '🇳🇨' },
{ name: 'Seychelles', code: '+248', price: 34, countryId: 184, flag: '🇸🇨' },
{ name: 'Montserrat', code: '+1', price: 29, countryId: 180, flag: '🇲🇸' },
{ name: 'Dominica', code: '+1', price: 32, countryId: 126, flag: '🇩🇲' },
{ name: 'South Korea', code: '+82', price: 31, countryId: 1002, flag: '🇰🇷' },
{ name: 'Macau', code: '+853', price: 120, countryId: 20, flag: '🇲🇴' },
{ name: 'Iceland', code: '+354', price: 100, countryId: 132, flag: '🇮🇸' },
{ name: 'Eritrea', code: '+291', price: 33, countryId: 176, flag: '🇪🇷' },
{ name: 'Kosovo', code: '+383', price: 30, countryId: 1004, flag: '🇽🇰' },
{ name: 'Uzbekistan', code: '+998', price: 34, countryId: 40, flag: '🇺🇿' },
    ];

const instagramCountries = [
    { name: 'Indonesia', code: '+62', price: 30, countryId: 6, flag: '🇮🇩' },
    { name: 'Belgium', code: '+32', price: 20, countryId: 82, flag: '🇧🇪' },
    { name: 'Indonesia', code: '+62', price: 16, countryId: 6, flag: '🇮🇩' },
    { name: 'Colombia', code: '+57', price: 10, countryId: 33, flag: '🇨🇴' },
    { name: 'United States (Virtual)', code: '+1', price: 30, countryId: 12, flag: '🇺🇸' },
    { name: 'Netherlands', code: '+31', price: 18, countryId: 48, flag: '🇳🇱' },
    { name: 'United Kingdom', code: '+44', price: 19, countryId: 16, flag: '🇬🇧' },
    { name: 'South Africa', code: '+27', price: 34, countryId: 31, flag: '🇿🇦' },
    { name: 'Germany', code: '+49', price: 18, countryId: 43, flag: '🇩🇪' },
    { name: 'Philippines', code: '+63', price: 19, countryId: 4, flag: '🇵🇭' },
    { name: 'Thailand', code: '+66', price: 42, countryId: 52, flag: '🇹🇭' },
    { name: 'Brazil', code: '+55', price: 38, countryId: 73, flag: '🇧🇷' },
    { name: 'Kenya', code: '+254', price: 41, countryId: 8, flag: '🇰🇪' },
    { name: 'Cambodia', code: '+855', price: 39, countryId: 24, flag: '🇰🇭' },
    { name: 'Yemen', code: '+967', price: 44, countryId: 30, flag: '🇾🇪' },
    { name: 'Ukraine', code: '+380', price: 37, countryId: 1, flag: '🇺🇦' },
    { name: 'Morocco', code: '+212', price: 43, countryId: 37, flag: '🇲🇦' },
    { name: 'Nigeria', code: '+234', price: 40, countryId: 19, flag: '🇳🇬' },
    { name: 'Uzbekistan', code: '+998', price: 45, countryId: 40, flag: '🇺🇿' },
    { name: 'Sweden', code: '+46', price: 38, countryId: 46, flag: '🇸🇪' },
    { name: 'Tanzania', code: '+255', price: 42, countryId: 9, flag: '🇹🇿' },
    { name: 'Chile', code: '+56', price: 37, countryId: 151, flag: '🇨🇱' },
    { name: 'India', code: '+91', price: 44, countryId: 22, flag: '🇮🇳' },
    { name: 'Mozambique', code: '+258', price: 40, countryId: 80, flag: '🇲🇿' },
    { name: 'Ghana', code: '+233', price: 60, countryId: 38, flag: '🇬🇭' },
    { name: 'Cameroon', code: '+237', price: 41, countryId: 41, flag: '🇨🇲' },
    { name: 'Senegal', code: '+221', price: 39, countryId: 61, flag: '🇸🇳' },
    { name: 'Poland', code: '+48', price: 43, countryId: 15, flag: '🇵🇱' },
    { name: 'Saudi Arabia', code: '+966', price: 38, countryId: 53, flag: '🇸🇦' },
    { name: 'Egypt', code: '+20', price: 45, countryId: 21, flag: '🇪🇬' },
    { name: 'Romania', code: '+40', price: 40, countryId: 32, flag: '🇷🇴' },
    { name: 'Ivory Coast', code: '+225', price: 42, countryId: 27, flag: '🇨🇮' },
    { name: 'Hong Kong', code: '+852', price: 37, countryId: 14, flag: '🇭🇰' },
    { name: 'Jamaica', code: '+1', price: 44, countryId: 103, flag: '🇯🇲' },
    { name: 'France', code: '+33', price: 39, countryId: 78, flag: '🇫🇷' },
    { name: 'DR Congo', code: '+243', price: 43, countryId: 18, flag: '🇨🇩' },
    { name: 'Zambia', code: '+260', price: 38, countryId: 147, flag: '🇿🇲' },
    { name: 'Algeria', code: '+213', price: 45, countryId: 58, flag: '🇩🇿' },
    { name: 'Vietnam', code: '+84', price: 10, countryId: 10, flag: '🇻🇳' },
    { name: 'Angola', code: '+244', price: 41, countryId: 76, flag: '🇦🇴' },
    { name: 'Canada', code: '+1', price: 17, countryId: 36, flag: '🇨🇦' },
    { name: 'Portugal', code: '+351', price: 39, countryId: 117, flag: '🇵🇹' },
    { name: 'Greece', code: '+30', price: 43, countryId: 129, flag: '🇬🇷' },
    { name: 'Moldova', code: '+373', price: 40, countryId: 85, flag: '🇲🇩' },
    { name: 'Madagascar', code: '+261', price: 44, countryId: 17, flag: '🇲🇬' },
    { name: 'Benin', code: '+229', price: 37, countryId: 120, flag: '🇧🇯' },
    { name: 'Afghanistan', code: '+93', price: 42, countryId: 74, flag: '🇦🇫' },
    { name: 'Uganda', code: '+256', price: 39, countryId: 75, flag: '🇺🇬' },
    { name: 'Ecuador', code: '+593', price: 45, countryId: 105, flag: '🇪🇨' },
    { name: 'UAE', code: '+971', price: 38, countryId: 95, flag: '🇦🇪' },
    { name: 'Nepal', code: '+977', price: 43, countryId: 81, flag: '🇳🇵' },
    { name: 'Bulgaria', code: '+359', price: 40, countryId: 83, flag: '🇧🇬' },
    { name: 'Guinea', code: '+224', price: 44, countryId: 68, flag: '🇬🇳' },
    { name: 'Malawi', code: '+265', price: 37, countryId: 137, flag: '🇲🇼' },
    { name: 'Italy', code: '+39', price: 42, countryId: 86, flag: '🇮🇹' },
    { name: 'South Sudan', code: '+211', price: 39, countryId: 177, flag: '🇸🇸' },
    { name: 'Argentina', code: '+54', price: 45, countryId: 39, flag: '🇦🇷' },
    { name: 'Czech Republic', code: '+420', price: 38, countryId: 63, flag: '🇨🇿' },
    { name: 'Peru', code: '+51', price: 43, countryId: 65, flag: '🇵🇪' },
    { name: 'Paraguay', code: '+595', price: 40, countryId: 87, flag: '🇵🇾' },
    { name: 'Spain', code: '+34', price: 60, countryId: 56, flag: '🇪🇸' },
    { name: 'Turkey', code: '+90', price: 44, countryId: 62, flag: '🇹🇷' },
    { name: 'Syria', code: '+963', price: 42, countryId: 1333, flag: '🇸🇾' },
    { name: 'Malaysia', code: '+60', price: 39, countryId: 7, flag: '🇲🇾' },
    { name: 'Bolivia', code: '+591', price: 45, countryId: 92, flag: '🇧🇴' },
    { name: 'Niger', code: '+227', price: 80, countryId: 139, flag: '🇳🇪' },
    { name: 'Denmark', code: '+45', price: 38, countryId: 172, flag: '🇩🇰' },
    { name: 'Uruguay', code: '+598', price: 100, countryId: 156, flag: '🇺🇾' },
    { name: 'Switzerland', code: '+41', price: 43, countryId: 173, flag: '🇨🇭' },
    { name: 'Mexico', code: '+52', price: 40, countryId: 54, flag: '🇲🇽' },
    { name: 'Nicaragua', code: '+505', price: 44, countryId: 90, flag: '🇳🇮' },
    { name: 'Trinidad and Tobago', code: '+1', price: 37, countryId: 104, flag: '🇹🇹' },
    { name: 'Guatemala', code: '+502', price: 90, countryId: 94, flag: '🇬🇹' },
    { name: 'Gambia', code: '+220', price: 42, countryId: 28, flag: '🇬🇲' },
    { name: 'Estonia', code: '+372', price: 39, countryId: 34, flag: '🇪🇪' },
    { name: 'Liberia', code: '+231', price: 45, countryId: 135, flag: '🇱🇷' },
    { name: 'Costa Rica', code: '+506', price: 70, countryId: 93, flag: '🇨🇷' },
    { name: 'Puerto Rico', code: '+1', price: 100, countryId: 97, flag: '🇵🇷' },
    { name: 'Guyana', code: '+592', price: 80, countryId: 131, flag: '🇬🇾' },
    { name: 'Ethiopia', code: '+251', price: 38, countryId: 71, flag: '🇪🇹' },
    { name: 'Papua New Guinea', code: '+675', price: 70, countryId: 79, flag: '🇵🇬' },
    { name: 'Mauritius', code: '+230', price: 43, countryId: 157, flag: '🇲🇺' },
    { name: 'Chad', code: '+235', price: 40, countryId: 42, flag: '🇹🇩' },
    { name: 'Lebanon', code: '+961', price: 60, countryId: 153, flag: '🇱🇧' },
    { name: 'Pakistan', code: '+92', price: 44, countryId: 66, flag: '🇵🇰' },
    { name: 'Sri Lanka', code: '+94', price: 37, countryId: 64, flag: '🇱🇰' },
    { name: 'Libya', code: '+218', price: 42, countryId: 102, flag: '🇱🇾' },
    { name: 'Honduras', code: '+504', price: 39, countryId: 88, flag: '🇭🇳' },
    { name: 'Mauritania', code: '+222', price: 45, countryId: 114, flag: '🇲🇷' },
    { name: 'Burkina Faso', code: '+226', price: 70, countryId: 152, flag: '🇧🇫' },
    { name: 'Macedonia', code: '+389', price: 38, countryId: 183, flag: '🇲🇰' },
    { name: 'Qatar', code: '+974', price: 100, countryId: 111, flag: '🇶🇦' },
    { name: 'Somalia', code: '+252', price: 43, countryId: 149, flag: '🇸🇴' },
    { name: 'Congo', code: '+242', price: 40, countryId: 150, flag: '🇨🇬' },
    { name: 'New Zealand', code: '+64', price: 44, countryId: 67, flag: '🇳🇿' },
    { name: 'Sudan', code: '+249', price: 110, countryId: 1010, flag: '🇸🇩' },
    { name: 'Georgia', code: '+995', price: 37, countryId: 128, flag: '🇬🇪' },
    { name: 'Bahamas', code: '+1', price: 90, countryId: 122, flag: '🇧🇸' },
    { name: 'Taiwan', code: '+886', price: 42, countryId: 55, flag: '🇹🇼' },
    { name: 'El Salvador', code: '+503', price: 110, countryId: 101, flag: '🇸🇻' },
    { name: 'Cuba', code: '+53', price: 100, countryId: 113, flag: '🇨🇺' },
    { name: 'Venezuela', code: '+58', price: 39, countryId: 70, flag: '🇻🇪' },
    { name: 'Mali', code: '+223', price: 45, countryId: 69, flag: '🇲🇱' },
    { name: 'USA', code: '+1', price: 40, countryId: 187, flag: '🇺🇸' },
    { name: 'United Kingdom', code: '+44', price: 40, countryId: 16, flag: '🇬🇧' }
];

const snapchatCountries = [
    { name: 'Indonesia', code: '+62', price: 40, countryId: 6, flag: '🇮🇩' },
    { name: 'USA', code: '+1', price: 40, countryId: 187, flag: '🇺🇸' },
    { name: 'Lesotho', code: '+266', price: 31, countryId: 136, flag: '🇱🇸' },
    { name: 'Ecuador', code: '+593', price: 100, countryId: 105, flag: '🇪🇨' },
    { name: 'El Salvador', code: '+503', price: 90, countryId: 101, flag: '🇸🇻' },
    { name: 'Uganda', code: '+256', price: 33, countryId: 75, flag: '🇺🇬' },
    { name: 'Malawi', code: '+265', price: 29, countryId: 137, flag: '🇲🇼' },
    { name: 'Kenya', code: '+254', price: 34, countryId: 8, flag: '🇰🇪' },
    { name: 'Panama', code: '+507', price: 30, countryId: 112, flag: '🇵🇦' },
    { name: 'Jamaica', code: '+1', price: 90, countryId: 103, flag: '🇯🇲' },
    { name: 'Venezuela', code: '+58', price: 200, countryId: 70, flag: '🇻🇪' },
    { name: 'Kazakhstan', code: '+7', price: 32, countryId: 2, flag: '🇰🇿' },
    { name: 'Paraguay', code: '+595', price: 100, countryId: 87, flag: '🇵🇾' },
    { name: 'Kyrgyzstan', code: '+996', price: 200, countryId: 11, flag: '🇰🇬' },
    { name: 'Jordan', code: '+962', price: 100, countryId: 116, flag: '🇯🇴' },
    { name: 'Cameroon', code: '+237', price: 31, countryId: 41, flag: '🇨🇲' },
    { name: 'Ivory Coast', code: '+225', price: 29, countryId: 27, flag: '🇨🇮' },
    { name: 'Bulgaria', code: '+359', price: 34, countryId: 83, flag: '🇧🇬' },
    { name: 'Libya', code: '+218', price: 80, countryId: 102, flag: '🇱🇾' },
    { name: 'Mauritius', code: '+230', price: 100, countryId: 157, flag: '🇲🇺' },
    { name: 'Mali', code: '+223', price: 30, countryId: 69, flag: '🇲🇱' },
    { name: 'Rwanda', code: '+250', price: 33, countryId: 140, flag: '🇷🇼' },
    { name: 'Gabon', code: '+241', price: 32, countryId: 154, flag: '🇬🇦' },
    { name: 'Nicaragua', code: '+505', price: 29, countryId: 90, flag: '🇳🇮' },
    { name: 'Moldova', code: '+373', price: 31, countryId: 85, flag: '🇲🇩' },
    { name: 'Thailand', code: '+66', price: 34, countryId: 52, flag: '🇹🇭' },
    { name: 'Benin', code: '+229', price: 100, countryId: 120, flag: '🇧🇯' },
    { name: 'Costa Rica', code: '+506', price: 100, countryId: 93, flag: '🇨🇷' },
    { name: 'Burkina Faso', code: '+226', price: 30, countryId: 152, flag: '🇧🇫' },
    { name: 'Qatar', code: '+974', price: 100, countryId: 111, flag: '🇶🇦' },
    { name: 'Reunion', code: '+262', price: 110, countryId: 146, flag: '🇷🇪' },
    { name: 'Oman', code: '+968', price: 110, countryId: 107, flag: '🇴🇲' },
    { name: 'Congo', code: '+242', price: 33, countryId: 150, flag: '🇨🇬' },
    { name: 'Yemen', code: '+967', price: 70, countryId: 30, flag: '🇾🇪' },
    { name: 'Uruguay', code: '+598', price: 32, countryId: 156, flag: '🇺🇾' },
    { name: 'Iraq', code: '+964', price: 100, countryId: 47, flag: '🇮🇶' },
    { name: 'Togo', code: '+228', price: 29, countryId: 99, flag: '🇹🇬' },
    { name: 'Niger', code: '+227', price: 34, countryId: 139, flag: '🇳🇪' },
    { name: 'Bhutan', code: '+975', price: 70, countryId: 158, flag: '🇧🇹' },
    { name: 'Burundi', code: '+257', price: 31, countryId: 119, flag: '🇧🇮' },
    { name: 'Equatorial Guinea', code: '+240', price: 100, countryId: 167, flag: '🇬🇶' },
    { name: 'Trinidad and Tobago', code: '+1', price: 60, countryId: 104, flag: '🇹🇹' },
    { name: 'South Sudan', code: '+211', price: 30, countryId: 177, flag: '🇸🇸' },
    { name: 'Mauritania', code: '+222', price: 100, countryId: 114, flag: '🇲🇷' },
    { name: 'China', code: '+86', price: 130, countryId: 3, flag: '🇨🇳' },
    { name: 'Kuwait', code: '+965', price: 110, countryId: 100, flag: '🇰🇼' },
    { name: 'Guinea-Bissau', code: '+245', price: 110, countryId: 130, flag: '🇬🇼' },
    { name: 'Maldives', code: '+960', price: 100, countryId: 159, flag: '🇲🇻' },
    { name: 'Bosnia and Herzegovina', code: '+387', price: 140, countryId: 108, flag: '🇧🇦' },
    { name: 'Somalia', code: '+252', price: 33, countryId: 149, flag: '🇸🇴' },
    { name: 'Barbados', code: '+1', price: 200, countryId: 118, flag: '🇧🇧' },
    { name: 'Gambia', code: '+220', price: 100, countryId: 28, flag: '🇬🇲' },
    { name: 'Armenia', code: '+374', price: 230, countryId: 148, flag: '🇦🇲' },
    { name: 'Guyana', code: '+592', price: 29, countryId: 131, flag: '🇬🇾' },
    { name: 'Chad', code: '+235', price: 100, countryId: 42, flag: '🇹🇩' },
    { name: 'Switzerland', code: '+41', price: 130, countryId: 173, flag: '🇨🇭' },
    { name: 'Serbia', code: '+381', price: 140, countryId: 29, flag: '🇷🇸' },
    { name: 'Estonia', code: '+372', price: 40, countryId: 34, flag: '🇪🇪' },
    { name: 'Bahrain', code: '+973', price: 32, countryId: 145, flag: '🇧🇭' },
    { name: 'Guadeloupe', code: '+590', price: 100, countryId: 160, flag: '🇬🇵' },
    { name: 'Cyprus', code: '+357', price: 30, countryId: 77, flag: '🇨🇾' },
    { name: 'Luxembourg', code: '+352', price: 140, countryId: 165, flag: '🇱🇺' },
    { name: 'Suriname', code: '+597', price: 34, countryId: 142, flag: '🇸🇷' },
    { name: 'Guatemala', code: '+502', price: 31, countryId: 94, flag: '🇬🇹' },
    { name: 'Madagascar', code: '+261', price: 110, countryId: 17, flag: '🇲🇬' },
    { name: 'Antigua and Barbuda', code: '+1', price: 110, countryId: 169, flag: '🇦🇬' },
    { name: 'Djibouti', code: '+253', price: 110, countryId: 168, flag: '🇩🇯' },
    { name: 'French Guiana', code: '+594', price: 100, countryId: 162, flag: '🇬🇫' },
    { name: 'Saint Lucia', code: '+1', price: 100, countryId: 164, flag: '🇱🇨' },
    { name: 'Montenegro', code: '+382', price: 29, countryId: 171, flag: '🇲🇪' },
    { name: 'Cuba', code: '+53', price: 33, countryId: 113, flag: '🇨🇺' },
    { name: 'Sierra Leone', code: '+232', price: 30, countryId: 115, flag: '🇸🇱' },
    { name: 'Bahamas', code: '+1', price: 100, countryId: 122, flag: '🇧🇸' },
    { name: 'Bolivia', code: '+591', price: 32, countryId: 92, flag: '🇧🇴' },
    { name: 'Grenada', code: '+1', price: 100, countryId: 127, flag: '🇬🇩' },
    { name: 'Latvia', code: '+371', price: 31, countryId: 49, flag: '🇱🇻' },
    { name: 'Tajikistan', code: '+992', price: 34, countryId: 143, flag: '🇹🇯' },
    { name: 'Brunei', code: '+673', price: 29, countryId: 121, flag: '🇧🇳' },
    { name: 'Cayman Islands', code: '+1', price: 170, countryId: 170, flag: '🇰🇾' },
    { name: 'Saint Vincent', code: '+1', price: 120, countryId: 166, flag: '🇻🇨' },
    { name: 'Albania', code: '+355', price: 140, countryId: 155, flag: '🇦🇱' },
    { name: 'Slovenia', code: '+386', price: 30, countryId: 59, flag: '🇸🇮' },
    { name: 'Saint Kitts and Nevis', code: '+1', price: 33, countryId: 134, flag: '🇰🇳' },
    { name: 'Lithuania', code: '+370', price: 200, countryId: 44, flag: '🇱🇹' },
    { name: 'CAF', code: '+236', price: 32, countryId: 125, flag: '🇨🇫' },
    { name: 'Liberia', code: '+231', price: 110, countryId: 135, flag: '🇱🇷' },
    { name: 'Japan', code: '+81', price: 110, countryId: 1001, flag: '🇯🇵' },
    { name: 'Guinea', code: '+224', price: 29, countryId: 68, flag: '🇬🇳' },
    { name: 'Aruba', code: '+297', price: 34, countryId: 179, flag: '🇦🇼' },
    { name: 'Comoros', code: '+269', price: 100, countryId: 133, flag: '🇰🇲' },
    { name: 'Slovakia', code: '+421', price: 110, countryId: 141, flag: '🇸🇰' },
    { name: 'Anguilla', code: '+1', price: 80, countryId: 181, flag: '🇦🇮' },
    { name: 'Sao Tome and Principe', code: '+239', price: 31, countryId: 178, flag: '🇸🇹' },
    { name: 'Croatia', code: '+385', price: 30, countryId: 45, flag: '🇭🇷' },
    { name: 'Cape Verde', code: '+238', price: 33, countryId: 186, flag: '🇨🇻' },
    { name: 'Monaco', code: '+377', price: 100, countryId: 144, flag: '🇲🇨' },
    { name: 'Macedonia', code: '+389', price: 110, countryId: 183, flag: '🇲🇰' },
    { name: 'Belize', code: '+501', price: 29, countryId: 124, flag: '🇧🇿' },
    { name: 'New Caledonia', code: '+687', price: 100, countryId: 185, flag: '🇳🇨' },
    { name: 'New Zealand', code: '+64', price: 78, countryId: 67, flag: '🇳🇿' },
    { name: 'Mongolia', code: '+976', price: 34, countryId: 72, flag: '🇲🇳' },
    { name: 'Seychelles', code: '+248', price: 32, countryId: 184, flag: '🇸🇨' },
    { name: 'Montserrat', code: '+1', price: 100, countryId: 180, flag: '🇲🇸' },
    { name: 'Dominica', code: '+1', price: 70, countryId: 126, flag: '🇩🇲' },
    { name: 'Macau', code: '+853', price: 70, countryId: 20, flag: '🇲🇴' },
    { name: 'Iceland', code: '+354', price: 31, countryId: 132, flag: '🇮🇸' },
    { name: 'Eritrea', code: '+291', price: 100, countryId: 176, flag: '🇪🇷' },
    { name: 'Gibraltar', code: '+350', price: 400, countryId: 201, flag: '🇬🇮' }
];

const googleCountries = [
    { name: 'USA Virtual', code: '+1', price: 90, countryId: 12, flag: '🇺🇸' },
    { name: 'Indonesia', code: '+62', price: 90, countryId: 6, flag: '🇮🇩' },
    { name: 'Brazil', code: '+55', price: 90, countryId: 73, flag: '🇧🇷' },
    { name: 'USA', code: '+1', price: 120, countryId: 187, flag: '🇺🇸' }
];

const serviceCatalog = {
    whatsapp: {
        serviceType: 'whatsapp',
        serviceName: 'WhatsApp Number',
        serviceCode: SMSBOWER_WA_SERVICE,
        countries: whatsappCountries
    },
    facebook: {
        serviceType: 'facebook',
        serviceName: 'Facebook Number',
        serviceCode: SMSBOWER_FB_SERVICE,
        countries: facebookCountries
    },
    instagram: {
        serviceType: 'instagram',
        serviceName: 'Instagram Number',
        serviceCode: SMSBOWER_IG_SERVICE,
        countries: instagramCountries
    },
    snapchat: {
        serviceType: 'snapchat',
        serviceName: 'Snapchat Number',
        serviceCode: SMSBOWER_SNAPCHAT_SERVICE,
        countries: snapchatCountries
    },
    google: {
        serviceType: 'google',
        serviceName: 'Google / Gmail / YouTube Number',
        serviceCode: SMSBOWER_GOOGLE_SERVICE,
        countries: googleCountries
    }
};

function getServiceConfig(serviceType) {
    return serviceCatalog[String(serviceType || '').trim().toLowerCase()] || null;
}

function parseV1NumberResponse(text) {
    const raw = String(text || '').trim();
    if (raw.startsWith('ACCESS_NUMBER:')) {
        const parts = raw.split(':');
        if (parts.length >= 3) {
            return {
                success: true,
                activationId: parts[1],
                phoneNumber: parts[2].startsWith('+') ? parts[2] : `+${parts[2]}`
            };
        }
    }
    return { success: false, error: raw || 'No number available' };
}

function parseNumberResponse(data) {
    if (typeof data === 'string') {
        const trimmed = data.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return parseNumberResponse(JSON.parse(trimmed));
            } catch {
                return parseV1NumberResponse(trimmed);
            }
        }
        return parseV1NumberResponse(trimmed);
    }
    if (data && typeof data === 'object') {
        if (data.activationId && data.phoneNumber) {
            return {
                success: true,
                activationId: String(data.activationId),
                phoneNumber: String(data.phoneNumber).startsWith('+')
                    ? String(data.phoneNumber)
                    : `+${String(data.phoneNumber)}`
            };
        }
    }
    return { success: false, error: 'No number available' };
}

function extractProvidersRecursive(node, bucket = [], seen = new Set()) {
    if (!node || typeof node !== 'object') return bucket;
    if (
        Object.prototype.hasOwnProperty.call(node, 'provider_id') &&
        Object.prototype.hasOwnProperty.call(node, 'price')
    ) {
        const providerId = Number(node.provider_id);
        const providerPrice = Number(node.price);
        if (!Number.isNaN(providerId) && !Number.isNaN(providerPrice)) {
            const key = `${providerId}:${providerPrice}`;
            if (!seen.has(key)) {
                seen.add(key);
                bucket.push({
                    provider_id: providerId,
                    price: providerPrice,
                    count: node.count
                });
            }
        }
    }
    for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
            extractProvidersRecursive(value, bucket, seen);
        }
    }
    return bucket;
}

async function fetchProviderTiers(countryId, serviceCode = 'wa') {
    const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=getPricesV3&service=${serviceCode}&country=${countryId}`;
    const response = await axios.get(url, { timeout: 15000 });
    const data = response.data;
    let providers = [];
    if (data && typeof data === 'object') {
        const countryNode =
            data[String(countryId)] ??
            data[countryId] ??
            (Object.keys(data).length === 1 ? Object.values(data)[0] : null);
        const serviceNode =
            countryNode?.[serviceCode] ??
            (countryNode && Object.keys(countryNode).length === 1 ? Object.values(countryNode)[0] : null);
        providers = extractProvidersRecursive(serviceNode || data);
    }
    providers = providers
        .filter((p) => Number.isFinite(p.provider_id) && Number.isFinite(p.price))
        .sort((a, b) => a.price - b.price);
    return providers;
}

async function buyNumberFromProvider(countryId, provider, serviceCode = 'wa') {
    const url =
        `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}` +
        `&action=getNumberV2` +
        `&service=${serviceCode}` +
        `&country=${countryId}` +
        `&maxPrice=${provider.price}` +
        `&providerIds=${provider.provider_id}`;
    try {
        const response = await axios.get(url, { timeout: 15000 });
        const parsed = parseNumberResponse(response.data);
        if (parsed.success) {
            return {
                ...parsed,
                provider_id: provider.provider_id,
                provider_price: provider.price
            };
        }
        return { success: false, error: parsed.error || 'No number from provider' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function buyNumberByTierStrategy(countryId, clientMaxUsd, serviceCode = 'wa') {
    try {
        const providers = await fetchProviderTiers(countryId, serviceCode);
        const affordableProviders = providers
            .filter((p) => p.price <= clientMaxUsd + 0.000001)
            .slice(0, 5);
        if (!affordableProviders.length) {
            return {
                success: false,
                strategy: 'provider_unavailable',
                error: 'No provider tiers available in your price range'
            };
        }
        for (const provider of affordableProviders) {
            const startedAt = Date.now();
            let lastError = 'No number from provider';
            while (Date.now() - startedAt < 15000) {
                const result = await buyNumberFromProvider(countryId, provider, serviceCode);
                if (result.success) {
                    return {
                        success: true,
                        activationId: result.activationId,
                        phoneNumber: result.phoneNumber,
                        strategy: 'provider',
                        provider_id: result.provider_id,
                        provider_price: result.provider_price
                    };
                }
                lastError = result.error || lastError;
                const elapsed = Date.now() - startedAt;
                const remaining = 15000 - elapsed;
                if (remaining <= 0) break;
                await waitMs(Math.min(5000, remaining));
            }
        }
        return {
            success: false,
            strategy: 'provider_exhausted',
            error: 'No number found in lowest 5 price tiers'
        };
    } catch (err) {
        return {
            success: false,
            strategy: 'provider_unavailable',
            error: err.message
        };
    }
}

async function buyNumberWithRetry(countryId, baseUsdPrice, maxAttempts = 3, serviceCode = 'wa') {
    const priceSteps = [];
    for (let i = 0; i < maxAttempts; i++) {
        priceSteps.push((baseUsdPrice * (1 + i * 0.05)).toFixed(3));
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const maxPriceUSD = priceSteps[attempt - 1];
        try {
            const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=getNumber&service=${serviceCode}&country=${countryId}&maxPrice=${maxPriceUSD}`;
            const response = await axios.get(url, { timeout: 15000 });
            const parsed = parseNumberResponse(response.data);
            if (parsed.success) {
                return {
                    success: true,
                    activationId: parsed.activationId,
                    phoneNumber: parsed.phoneNumber,
                    strategy: 'fallback'
                };
            }
            if (attempt < maxAttempts) {
                await waitMs(8000);
            }
        } catch (err) {
            if (attempt === maxAttempts) {
                return { success: false, error: err.message };
            }
            await waitMs(8000);
        }
    }
    return { success: false, error: 'No number available after all attempts' };
}

async function getBestAvailableNumber(countryId, clientMaxUsd, serviceCode = 'wa') {
    let result = await buyNumberByTierStrategy(countryId, clientMaxUsd, serviceCode);
    if (!result.success && result.strategy === 'provider_unavailable') {
        result = await buyNumberWithRetry(countryId, clientMaxUsd, 3, serviceCode);
    }
    return result;
}

async function checkSmsStatus(activationId) {
    try {
        const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=getStatus&id=${activationId}`;
        const response = await axios.get(url, { timeout: 15000 });
        const resText = String(response.data || '').trim();
        if (resText.startsWith('STATUS_OK:')) {
            return { success: true, code: resText.split(':')[1] };
        }
        if (resText === 'STATUS_WAIT_CODE') {
            return { success: true, waiting: true };
        }
        return { success: false, raw: resText };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function ensureAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).send('Login required');
    next();
}

async function ensureAdmin(req, res, next) {
    try {
        if (!req.session.userId) return res.status(401).send('Login required');
        const user = await findUserById(req.session.userId);
        if (!isAdminUser(user)) return res.status(403).send('Admin only');
        req.user = user;
        next();
    } catch {
        res.status(500).send('Server error');
    }
}

const authRoutes = createAuthRouter({
    passport,
    queryOne,
    queryRun,
    hashPassword,
    randomPassword,
    sanitizeEmail,
    updateUserLastLogin,
    updateUserLoginAttempts,
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: GOOGLE_CLIENT_SECRET,
    googleCallbackUrl: GOOGLE_CALLBACK_URL
});

app.use('/auth', authRoutes);

app.get('/admin', ensureAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/countries', (req, res) => {
    res.json(whatsappCountries);
});

app.get('/api/facebook/countries', (req, res) => {
    res.json(serviceCatalog.facebook.countries);
});

app.get('/api/services/:service/countries', (req, res) => {
    const serviceConfig = getServiceConfig(req.params.service);
    if (!serviceConfig) return res.status(404).send('Service not found');
    res.json(serviceConfig.countries);
});

app.get('/api/auth/google', (req, res) => {
    return res.redirect('/auth/google');
});

app.post('/api/forgot-password', async (req, res) => {
    try {
        if (!isMailConfigured()) {
            return res.status(503).send('Password reset email is not configured');
        }
        const email = sanitizeEmail(req.body.email);
        if (!validateEmail(email)) return res.status(400).send('Valid email is required');
        const user = await findUser(email);
        if (user) {
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS).toISOString();
            await savePasswordResetToken(user.id, hashToken(token), expiresAt);
            await sendPasswordResetEmail(user, token);
        }
        res.json({ success: true, message: 'If an account exists for that email, a reset link has been sent.' });
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Could not send password reset email'));
    }
});

app.get('/api/admin/users', ensureAdmin, async (req, res) => {
    try {
        const users = await getAdminUsers();
        res.json(users);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/admin/balance-adjustments', ensureAdmin, async (req, res) => {
    try {
        const adjustments = await getAllBalanceAdjustments();
        res.json(adjustments);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/admin/users/:userId/adjust-balance', ensureAdmin, async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const amount = Number(req.body.amount);
        const reason = String(req.body.reason || '').trim();

        if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
            return res.status(400).send('Invalid user id');
        }
        if (!Number.isFinite(amount) || amount === 0) {
            return res.status(400).send('Amount must be a non-zero number');
        }
        if (!reason) {
            return res.status(400).send('Reason is required');
        }

        const updatedUser = await applyAdminBalanceAdjustment({
            userId: targetUserId,
            adminId: req.user.id,
            amount,
            reason
        });

        res.json({
            success: true,
            user: {
                id: updatedUser.id,
                email: updatedUser.email,
                name: updatedUser.name,
                balance: updatedUser.balance
            }
        });
    } catch (err) {
        res.status(400).send(formatSafeError(err, 'Balance adjustment failed'));
    }
});

app.get('/api/admin/users/:userId/history', ensureAdmin, async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
            return res.status(400).send('Invalid user id');
        }
        const history = await getUserCombinedHistory(targetUserId);
        res.json(history);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/reset-password', async (req, res) => {
    try {
        const token = String(req.body.token || '').trim();
        const newPassword = req.body.newPassword;
        if (!token) return res.status(400).send('Reset token is required');
        if (!validatePassword(newPassword)) {
            return res.status(400).send('New password must be at least 6 characters');
        }
        const user = await findUserByResetToken(token);
        if (!user) return res.status(400).send('Reset link is invalid or expired');
        await updateUserPassword(user.id, newPassword);
        await clearPasswordResetToken(user.id);
        await updateUserLoginAttempts(user.id, 0);
        await queryRun('UPDATE users SET is_active = TRUE WHERE id = $1', [user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Could not reset password'));
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const email = sanitizeEmail(req.body.email);
        const password = req.body.password;
        if (!name) return res.status(400).send('Name is required');
        if (!validateEmail(email)) return res.status(400).send('Valid email is required');
        if (!validatePassword(password)) return res.status(400).send('Password must be at least 6 characters');
        const existing = await findUser(email);
        if (existing) return res.status(400).send('Email already exists');
        await createUser(name, email, password);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(formatSafeError(err));
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const email = sanitizeEmail(req.body.email);
        const password = req.body.password;
        if (!validateEmail(email)) return res.status(400).send('Valid email is required');
        if (typeof password !== 'string' || !password) return res.status(400).send('Password is required');
        const user = await findUser(email);
        if (!user) {
            return res.status(401).send('Invalid credentials');
        }
        if (!user.is_active) {
            return res.status(401).send('Account blocked');
        }
        const passwordCheck = await verifyPassword(password, user.password);
        if (!passwordCheck.valid) {
            const newAttempts = Number(user.login_attempts || 0) + 1;
            await updateUserLoginAttempts(user.id, newAttempts);
            if (newAttempts >= 5) {
                await queryRun('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);
            }
            return res.status(401).send('Invalid credentials');
        }
        if (passwordCheck.needsUpgrade) {
            const upgradedHash = await hashPassword(password);
            await updateUserPasswordHash(user.id, upgradedHash);
        }
        await updateUserLoginAttempts(user.id, 0);
        await updateUserLastLogin(user.id);
        req.session.regenerate((regenErr) => {
            if (regenErr) {
                console.error('Session regenerate error:', regenErr);
                return res.status(500).send('Login failed');
            }
            req.session.userId = user.id;
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('Session save error:', saveErr);
                    return res.status(500).send('Login failed');
                }
                return res.json({ success: true });
            });
        });
    } catch (err) {
        console.error('Login route error:', err);
        res.status(500).send(formatSafeError(err));
    }
});

app.post('/api/change-password', ensureAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (typeof currentPassword !== 'string' || !currentPassword) {
            return res.status(400).send('Current password is required');
        }
        if (!validatePassword(newPassword)) {
            return res.status(400).send('New password must be at least 6 characters');
        }
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(404).send('User not found');
        const passwordCheck = await verifyPassword(currentPassword, user.password);
        if (!passwordCheck.valid) {
            return res.status(400).send('Current password is incorrect');
        }
        await updateUserPassword(user.id, newPassword);
        res.send('OK');
    } catch (err) {
        res.status(500).send(formatSafeError(err));
    }
});

app.get('/api/me', ensureAuth, async (req, res) => {
    try {
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            balance: user.balance,
            role: user.role,
            isAdmin: isAdminUser(user),
            referralCode: user.referralCode,
            maskedPassword: '********'
        });
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/logout', (req, res) => {
    req.logout(() => {
        req.session.destroy(() => {
            res.clearCookie('mrf.sid');
            res.send('OK');
        });
    });
});

app.post('/api/order', ensureAuth, async (req, res) => {
    const client = await pool.connect();
    let activationToRelease = null;
    try {
        const { countryName, countryId, service } = req.body;
        const idempotencyKey = String(req.body.idempotencyKey || '').trim();
        if (!idempotencyKey || idempotencyKey.length < 8) {
            return res.status(400).send('Idempotency key is required');
        }
        const serviceConfig = getServiceConfig(service || 'whatsapp');
        if (!serviceConfig) return res.status(400).send('Invalid service selected');
        const countryObj = serviceConfig.countries.find((c) => c.name === countryName && Number(c.countryId) === Number(countryId));
        if (!countryObj) return res.status(400).send('Invalid country selected');
        const existingQuickMatch = await queryOne(
            'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
            [req.session.userId, idempotencyKey]
        );
        if (existingQuickMatch) {
            return res.json({ id: existingQuickMatch.id, number: existingQuickMatch.phone_number, duplicate: true });
        }
        const orderPrice = Number(countryObj.price || 0);
        if (orderPrice <= 0) {
            return res.status(400).send('Price not configured for selected service');
        }

        const clientMaxUsd = pkrToUsd(orderPrice);
        const result = await getBestAvailableNumber(countryObj.countryId, clientMaxUsd, serviceConfig.serviceCode);
        if (!result.success) {
            return res.status(500).send('No number available in current low-price tiers. Please try again.');
        }
        activationToRelease = result.activationId || null;

        const providerCostPKR = Number((Number(result.provider_price || 0) * 280).toFixed(2));
        const now = new Date();
        const cooldownMs = ORDER_COOLDOWN_SECONDS * 1000;
        const expiresAt = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
        const cancelAvailableAt = new Date(now.getTime() + 1 * 60 * 1000).toISOString();

        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
        const user = userRes.rows[0];
        if (!user) {
            await client.query('ROLLBACK');
            return res.status(401).send('User not found');
        }

        const existingByIdempotency = await client.query(
            'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
            [user.id, idempotencyKey]
        );
        if (existingByIdempotency.rowCount > 0) {
            await client.query('COMMIT');
            activationToRelease = result.activationId || null;
            return res.json({
                id: existingByIdempotency.rows[0].id,
                number: existingByIdempotency.rows[0].phone_number,
                duplicate: true
            });
        }

        const activeSameServiceCountry = await client.query(
            `
                SELECT id
                FROM orders
                WHERE user_id = $1
                  AND service_type = $2
                  AND country_id = $3
                  AND COALESCE(status, order_status, 'pending') IN ('pending', 'active')
                ORDER BY id DESC
                LIMIT 1
            `,
            [user.id, serviceConfig.serviceType, countryObj.countryId]
        );
        if (activeSameServiceCountry.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).send('You already have an active order for this service and country. Complete it first.');
        }

        const cooldownRow = await client.query(
            `
                SELECT MAX(last_purchase_at) AS last_purchase_at
                FROM orders
                WHERE user_id = $1
                  AND service_type = $2
            `,
            [user.id, serviceConfig.serviceType]
        );
        const lastPurchaseAt = cooldownRow.rows[0]?.last_purchase_at ? new Date(cooldownRow.rows[0].last_purchase_at) : null;
        if (lastPurchaseAt && now.getTime() - lastPurchaseAt.getTime() < cooldownMs) {
            await client.query('ROLLBACK');
            const remaining = Math.max(1, Math.ceil((cooldownMs - (now.getTime() - lastPurchaseAt.getTime())) / 1000));
            return res.status(429).send(`Please wait ${remaining} seconds before buying another ${serviceConfig.serviceName}.`);
        }

        const deductionRes = await client.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
            [orderPrice, user.id]
        );
        if (deductionRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).send('Insufficient balance. Please add funds.');
        }

        const inserted = await client.query(`
            INSERT INTO orders (
                user_id, user_email, service_type, service_name, country, country_code, country_id, price, provider_cost_pkr,
                payment_method, order_status, status, phone_number, activation_id,
                expires_at, cancel_available_at, last_purchase_at, idempotency_key, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            RETURNING id
        `, [
            user.id,
            user.email,
            serviceConfig.serviceType,
            serviceConfig.serviceName,
            countryName,
            countryObj.code,
            countryObj.countryId,
            orderPrice,
            providerCostPKR,
            'balance',
            'pending',
            'pending',
            result.phoneNumber,
            result.activationId,
            expiresAt,
            cancelAvailableAt,
            now.toISOString(),
            idempotencyKey,
            now.toISOString()
        ]);
        await client.query(
            'INSERT INTO transactions (user_id, user_email, amount, type, status, description) VALUES ($1, $2, $3, $4, $5, $6)',
            [user.id, user.email, orderPrice, 'deduction', 'approved', `${serviceConfig.serviceName} • ${countryName}`]
        );
        await client.query('COMMIT');
        activationToRelease = null;
        res.json({ id: inserted.rows[0].id, number: result.phoneNumber });
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
        }
        if (err && err.code === '23505') {
            const dedupedOrder = await queryOne(
                'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
                [req.session.userId, String(req.body.idempotencyKey || '').trim()]
            );
            if (dedupedOrder) {
                return res.json({ id: dedupedOrder.id, number: dedupedOrder.phone_number, duplicate: true });
            }
            if (String(err.constraint || '').toLowerCase() === 'idx_orders_open_service_country_unique') {
                return res.status(409).send('You already have an active order for this service and country. Complete it first.');
            }
        }
        res.status(500).send(formatSafeError(err, 'Order failed. Please try again.'));
    } finally {
        if (activationToRelease) {
            await updateProviderActivationStatus(activationToRelease, 8);
        }
        client.release();
    }
});

app.get('/api/orders/:orderId', ensureAuth, async (req, res) => {
    try {
        let order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        if (order.user_id !== user.id && !isAdminUser(user)) {
            return res.status(403).send('Unauthorized');
        }
        if (String(order.status || order.order_status || '').toLowerCase() === 'pending' && !order.otp_received && order.expires_at && new Date() >= new Date(order.expires_at)) {
            await expireOrderAndRefund(order.id);
            order = await getOrderById(order.id);
        }
        res.json(order);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/orders', ensureAuth, async (req, res) => {
    try {
        await reconcileExpiredOrdersForUser(req.session.userId);
        const userOrders = await getOrdersByUser(req.session.userId);
        res.json(userOrders);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/orders/:orderId/cancel', ensureAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const orderId = Number(req.params.orderId);
        await client.query('BEGIN');
        const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
        const order = orderRes.rows[0];
        if (!order) {
            await client.query('ROLLBACK');
            return res.status(404).send('Order not found');
        }
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
        const user = userRes.rows[0];
        if (!user || order.user_id !== user.id) {
            await client.query('ROLLBACK');
            return res.status(403).send('Unauthorized');
        }
        if (String(order.status || order.order_status || '').toLowerCase() !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).send('Cannot cancel now');
        }
        if (order.otp_received) {
            await client.query('ROLLBACK');
            return res.status(400).send('OTP already received, cannot cancel');
        }
        const now = new Date();
        const expiry = order.expires_at ? new Date(order.expires_at) : null;
        if (expiry && now >= expiry && !order.otp_received && String(order.status || order.order_status || '').toLowerCase() === 'pending') {
            await client.query('ROLLBACK');
            const expireResult = await expireOrderAndRefund(order.id);
            return res.send(expireResult.message || EXPIRED_REFUND_MESSAGE);
        }
        const cancelAvailable = new Date(order.cancel_available_at);
        if (now < cancelAvailable) {
            await client.query('ROLLBACK');
            return res.status(400).send(`Please wait ${Math.ceil((cancelAvailable - now) / 1000)} seconds before cancelling.`);
        }
        try {
            const cancelUrl = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=setStatus&id=${order.activation_id}&status=8`;
            await axios.get(cancelUrl, { timeout: 15000 });
        } catch {}
        await client.query('UPDATE users SET balance = $1 WHERE id = $2', [
            Number(user.balance || 0) + Number(order.price || 0),
            user.id
        ]);
        await client.query('UPDATE orders SET order_status = $1, status = $2 WHERE id = $3', ['cancelled', 'cancelled', order.id]);
        await client.query('COMMIT');
        res.send('OK');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(formatSafeError(err, 'Cancel failed'));
    } finally {
        client.release();
    }
});

app.post('/api/orders/:orderId/complete', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user || order.user_id !== user.id) return res.status(403).send('Unauthorized');
        if (!order.otp_received) return res.status(400).send('Cannot complete without OTP');
        try {
            const completeUrl = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=setStatus&id=${order.activation_id}&status=6`;
            await axios.get(completeUrl, { timeout: 15000 });
        } catch {}
        await updateOrder(order.id, {
            order_status: 'completed',
            status: 'completed',
            completed_at: new Date().toISOString()
        });
        res.send('OK');
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Complete failed'));
    }
});

app.post('/api/orders/:orderId/expire', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        if (order.user_id !== user.id && !isAdminUser(user)) {
            return res.status(403).send('Unauthorized');
        }
        const expireResult = await expireOrderAndRefund(order.id);
        res.json({
            expired: expireResult.expired,
            refunded: expireResult.refunded,
            message: expireResult.expired ? expireResult.message : 'Order is still active.',
            order: expireResult.order
        });
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Expire failed'));
    }
});

app.get('/api/orders/:orderId/otp', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        if (order.user_id !== user.id && !isAdminUser(user)) {
            return res.status(403).send('Unauthorized');
        }
        if (String(order.status || order.order_status || '').toLowerCase() === 'expired') {
            return res.json({ received: false, expired: true, refunded: true, message: EXPIRED_REFUND_MESSAGE });
        }
        if (order.otp_received) {
            return res.json({ received: true, code: order.otp_code });
        }
        if (String(order.status || order.order_status || '').toLowerCase() !== 'pending') {
            return res.json({ received: false, inactive: true, status: order.status || order.order_status });
        }
        if (!order.activation_id) {
            return res.json({ received: false, error: 'No activation ID' });
        }
        const now = new Date();
        const expiry = new Date(order.expires_at);
        if (now >= expiry && !order.otp_received && String(order.status || order.order_status || '').toLowerCase() === 'pending') {
            const expireResult = await expireOrderAndRefund(order.id);
            return res.json({
                received: false,
                expired: true,
                refunded: expireResult.refunded,
                message: expireResult.message || EXPIRED_REFUND_MESSAGE
            });
        }
        if (String(order.status || order.order_status || '').toLowerCase() !== 'pending') {
            return res.json({ received: false, inactive: true, status: order.status || order.order_status });
        }
        const smsResult = await checkSmsStatus(order.activation_id);
        if (smsResult.success && smsResult.code) {
            await updateOrder(order.id, {
                otp_received: true,
                otp_code: smsResult.code,
                order_status: 'active',
                status: 'active'
            });
            return res.json({ received: true, code: smsResult.code });
        }
        if (smsResult.success && smsResult.waiting) {
            return res.json({ received: false, waiting: true });
        }
        return res.json({ received: false, error: true });
    } catch {
        res.status(500).json({ received: false, error: true });
    }
});

app.get('/api/admin/orders', ensureAdmin, async (req, res) => {
    try {
        const allOrders = await getAllOrders();
        res.json(allOrders);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/admin/transactions', ensureAdmin, async (req, res) => {
    try {
        const pending = await getPendingTransactions();
        res.json(pending);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/admin/transactions/history', ensureAdmin, async (req, res) => {
    try {
        const history = await getTransactionHistory();
        res.json(history);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/admin/transactions/:txId/approve', ensureAdmin, async (req, res) => {
    try {
        await approveTransaction(Number(req.params.txId));
        res.send('OK');
    } catch (err) {
        res.status(404).send(formatSafeError(err, 'Transaction not found'));
    }
});

app.post('/api/admin/transactions/:txId/cancel', ensureAdmin, async (req, res) => {
    try {
        await cancelTransaction(Number(req.params.txId));
        res.send('OK');
    } catch (err) {
        res.status(404).send(formatSafeError(err, 'Transaction not found'));
    }
});

app.post('/api/request-payment', ensureAuth, upload.single('screenshot'), async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        if (!amount || amount < 100) return res.status(400).send('Minimum amount 100 PKR');
        if (paymentRateLimiter[req.session.userId] && Date.now() - paymentRateLimiter[req.session.userId] < 60000) {
            return res.status(429).send('Please wait 1 minute between requests');
        }
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        const transaction_id = typeof req.body.transaction_id === 'string' ? req.body.transaction_id.trim() : '';
        const screenshot = req.file ? req.file.filename : null;
        if (!screenshot && !transaction_id) return res.status(400).send('Screenshot or transaction ID is required');
        await queryRun(
            'INSERT INTO payment_requests (user_id, user_email, amount, transaction_id, screenshot, status) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.session.userId, user.email, amount, transaction_id || null, screenshot, 'pending']
        );
        paymentRateLimiter[req.session.userId] = Date.now();
        res.json({ success: true });
    } catch (err) {
        if (err && err.code === '23505') {
            return res.status(400).send('This transaction ID has already been submitted');
        }
        res.status(500).send(formatSafeError(err));
    }
});

app.post('/api/add-funds', ensureAuth, upload.single('screenshot'), async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        if (!amount || amount < 100) return res.status(400).send('Minimum amount 100 PKR');
        if (paymentRateLimiter[req.session.userId] && Date.now() - paymentRateLimiter[req.session.userId] < 60000) {
            return res.status(429).send('Please wait 1 minute between requests');
        }
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        const transaction_id = typeof req.body.transaction_id === 'string' ? req.body.transaction_id.trim() : '';
        const screenshot = req.file ? req.file.filename : null;
        if (!screenshot && !transaction_id) return res.status(400).send('Screenshot or transaction ID is required');
        await queryRun(
            'INSERT INTO payment_requests (user_id, user_email, amount, transaction_id, screenshot, status) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.session.userId, user.email, amount, transaction_id || null, screenshot, 'pending']
        );
        paymentRateLimiter[req.session.userId] = Date.now();
        res.json({ success: true });
    } catch (err) {
        if (err && err.code === '23505') {
            return res.status(400).send('This transaction ID has already been submitted');
        }
        res.status(500).send(formatSafeError(err));
    }
});

app.get('/api/admin/payment-requests', ensureAdmin, async (req, res) => {
    try {
        const requests = await getAllPaymentRequests();
        res.json(requests);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/my-payment-history', ensureAuth, async (req, res) => {
    try {
        const requests = await getPaymentHistoryByUser(req.session.userId);
        res.json(requests);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/admin/payment-requests/:id/approve', ensureAdmin, async (req, res) => {
    const client = await pool.connect();
    let screenshotToDelete = null;
    try {
        await client.query('BEGIN');
        const requestRes = await client.query('SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE', [Number(req.params.id)]);
        const paymentRequest = requestRes.rows[0];
        if (!paymentRequest) throw new Error('Payment request not found');
        if (paymentRequest.status !== 'pending') throw new Error('Only pending payment requests can be approved');
        screenshotToDelete = paymentRequest.screenshot || null;
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [paymentRequest.user_id]);
        const user = userRes.rows[0];
        if (!user) throw new Error('User not found');
        await client.query('UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2', [Number(paymentRequest.amount || 0), paymentRequest.user_id]);
        await client.query(
            'INSERT INTO transactions (user_id, user_email, amount, type, status, description, transaction_id, screenshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [paymentRequest.user_id, paymentRequest.user_email, paymentRequest.amount, 'deposit', 'approved', `Approved payment request #${paymentRequest.id}`, paymentRequest.transaction_id, null]
        );
        await client.query('UPDATE payment_requests SET status = $1, screenshot = NULL WHERE id = $2', ['approved', paymentRequest.id]);
        await client.query('COMMIT');
        await removeUploadedFile(screenshotToDelete);
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).send(formatSafeError(err, 'Payment request approval failed'));
    } finally {
        client.release();
    }
});

app.post('/api/admin/payment-requests/:id/reject', ensureAdmin, async (req, res) => {
    const client = await pool.connect();
    let screenshotToDelete = null;
    try {
        await client.query('BEGIN');
        const requestRes = await client.query('SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE', [Number(req.params.id)]);
        const request = requestRes.rows[0];
        if (!request) {
            await client.query('ROLLBACK');
            return res.status(404).send('Payment request not found');
        }
        if (request.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).send('Only pending payment requests can be cancelled');
        }
        screenshotToDelete = request.screenshot || null;
        await client.query('UPDATE payment_requests SET status = $1, screenshot = NULL WHERE id = $2', ['cancelled', Number(req.params.id)]);
        await client.query('COMMIT');
        await removeUploadedFile(screenshotToDelete);
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).send(formatSafeError(err, 'Payment request cancellation failed'));
    } finally {
        client.release();
    }
});

app.use('/uploads', express.static(UPLOAD_DIR));

initDB()
    .then(() => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on http://0.0.0.0:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('Database initialization failed:', err);
        process.exit(1);
    });
