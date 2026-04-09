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
        referralCode: row.referral_code,
        is_active: row.is_active,
        login_attempts: row.login_attempts
    };
}

function normalizeOrder(row) {
    if (!row) return null;
    return {
        ...row,
        price: Number(row.price || 0),
        provider_cost_pkr: Number(row.provider_cost_pkr || 0),
        client_balance_left: row.client_balance_left == null ? null : Number(row.client_balance_left),
        profit_pkr: row.profit_pkr == null ? null : Number(row.profit_pkr),
        otp_received: row.otp_received
    };
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
            referral_code TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            login_attempts INTEGER DEFAULT 0,
            last_login TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_token)');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "googleId" TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "displayName" TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "photo" TEXT');
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
            phone_number TEXT,
            activation_id TEXT,
            otp_received BOOLEAN DEFAULT FALSE,
            otp_code TEXT,
            expires_at TIMESTAMPTZ,
            cancel_available_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ
        )
    `);

    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_cost_pkr NUMERIC(12,2) DEFAULT 0');

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
                'INSERT INTO users (email, password, name, role, referral_code) VALUES ($1, $2, $3, $4, $5)',
                [adminEmail, hashedAdminPassword, ADMIN_NAME, 'admin', 'ADMIN']
            );
            console.log('Admin user created from environment variables');
        } else if (existingAdmin.role !== 'admin') {
            await queryRun('UPDATE users SET role = $1 WHERE id = $2', ['admin', existingAdmin.id]);
            console.log('Existing admin email promoted to admin role');
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
    const rows = await queryAll('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [userId]);
    return rows.map(normalizeOrder);
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
        if (order.order_status === 'expired_refunded') {
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
        if (!['active', 'retry_requested'].includes(String(order.order_status || '').toLowerCase()) || order.otp_received || !expiry || now < expiry) {
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
        const updatedRes = await client.query('UPDATE orders SET order_status = $1 WHERE id = $2 RETURNING *', [
            'expired_refunded',
            order.id
        ]);
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
          AND order_status IN ('active', 'retry_requested')
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
    { name: 'USA Virtual', code: '+1', price: 70, countryId: 12, flag: '🇺🇸' },
    { name: 'United Kingdom', code: '+44', price: 70, countryId: 16, flag: '🇬🇧' }
];

const instagramCountries = [
    { name: 'Indonesia', code: '+62', price: 30, countryId: 6, flag: '🇮🇩' },
    { name: 'USA', code: '+1', price: 40, countryId: 187, flag: '🇺🇸' },
    { name: 'United Kingdom', code: '+44', price: 40, countryId: 16, flag: '🇬🇧' }
];

const snapchatCountries = [
    { name: 'Indonesia', code: '+62', price: 40, countryId: 6, flag: '🇮🇩' },
    { name: 'USA', code: '+1', price: 40, countryId: 187, flag: '🇺🇸' }
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
        if (!user || user.role !== 'admin') return res.status(403).send('Admin only');
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
    try {
        const { countryName, countryId, service } = req.body;
        const serviceConfig = getServiceConfig(service || 'whatsapp');
        if (!serviceConfig) return res.status(400).send('Invalid service selected');
        const countryObj = serviceConfig.countries.find((c) => c.name === countryName && Number(c.countryId) === Number(countryId));
        if (!countryObj) return res.status(400).send('Invalid country selected');
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
        const user = userRes.rows[0];
        if (!user) {
            await client.query('ROLLBACK');
            return res.status(401).send('User not found');
        }
        const orderPrice = Number(countryObj.price || 0);
        if (orderPrice <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).send('Price not configured for selected service');
        }
        if (Number(user.balance) < orderPrice) {
            await client.query('ROLLBACK');
            return res.status(400).send('Insufficient balance. Please add funds.');
        }
        const clientMaxUsd = pkrToUsd(orderPrice);
        const result = await getBestAvailableNumber(countryObj.countryId, clientMaxUsd, serviceConfig.serviceCode);
        if (!result.success) {
            await client.query('ROLLBACK');
            return res.status(500).send('No number available in current low-price tiers. Please try again.');
        }
        const providerCostPKR = Number((Number(result.provider_price || 0) * 280).toFixed(2));
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
        const cancelAvailableAt = new Date(now.getTime() + 1 * 60 * 1000).toISOString();
        await client.query('UPDATE users SET balance = $1 WHERE id = $2', [
            Number(user.balance) - orderPrice,
            user.id
        ]);
        const inserted = await client.query(`
            INSERT INTO orders (
                user_id, user_email, service_type, service_name, country, country_code, country_id, price, provider_cost_pkr,
                payment_method, order_status, phone_number, activation_id,
                expires_at, cancel_available_at, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
            'active',
            result.phoneNumber,
            result.activationId,
            expiresAt,
            cancelAvailableAt,
            now.toISOString()
        ]);
        await client.query(
            'INSERT INTO transactions (user_id, user_email, amount, type, status, description) VALUES ($1, $2, $3, $4, $5, $6)',
            [user.id, user.email, orderPrice, 'deduction', 'approved', `${serviceConfig.serviceName} • ${countryName}`]
        );
        await client.query('COMMIT');
        res.json({ id: inserted.rows[0].id, number: result.phoneNumber });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(formatSafeError(err, 'Order failed. Please try again.'));
    } finally {
        client.release();
    }
});

app.get('/api/orders/:orderId', ensureAuth, async (req, res) => {
    try {
        let order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        if (order.user_id !== user.id && user.role !== 'admin') {
            return res.status(403).send('Unauthorized');
        }
        if (['active', 'retry_requested'].includes(String(order.order_status || '').toLowerCase()) && !order.otp_received && order.expires_at && new Date() >= new Date(order.expires_at)) {
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

app.post('/api/orders/:orderId/replace', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user || order.user_id !== user.id) return res.status(403).send('Unauthorized');
        if (order.order_status !== 'active') return res.status(400).send('Cannot replace number now');
        if (order.otp_received) return res.status(400).send('OTP already received, cannot replace');
        try {
            const cancelUrl = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=setStatus&id=${order.activation_id}&status=8`;
            await axios.get(cancelUrl, { timeout: 15000 });
        } catch {}
        const clientMaxUsd = pkrToUsd(order.price);
        const serviceConfig = getServiceConfig(order.service_type) || serviceCatalog.whatsapp;
        const result = await getBestAvailableNumber(order.country_id, clientMaxUsd, serviceConfig.serviceCode);
        if (!result.success) return res.status(500).send('No replacement number available right now');
        const providerCostPKR = Number((Number(result.provider_price || 0) * 280).toFixed(2));
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
        const cancelAvailableAt = new Date(now.getTime() + 1 * 60 * 1000).toISOString();
        await updateOrder(order.id, {
            phone_number: result.phoneNumber,
            activation_id: result.activationId,
            provider_cost_pkr: providerCostPKR,
            otp_received: false,
            otp_code: null,
            order_status: 'active',
            created_at: now.toISOString(),
            expires_at: expiresAt,
            cancel_available_at: cancelAvailableAt
        });
        res.send('OK');
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Replace failed'));
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
        if (order.order_status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(400).send('Cannot cancel now');
        }
        if (order.otp_received) {
            await client.query('ROLLBACK');
            return res.status(400).send('OTP already received, cannot cancel');
        }
        const now = new Date();
        const expiry = order.expires_at ? new Date(order.expires_at) : null;
        if (expiry && now >= expiry && !order.otp_received && order.order_status === 'active') {
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
        await client.query('UPDATE orders SET order_status = $1 WHERE id = $2', ['cancelled', order.id]);
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
            completed_at: new Date().toISOString()
        });
        res.send('OK');
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Complete failed'));
    }
});

app.post('/api/orders/:orderId/resend', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user || order.user_id !== user.id) return res.status(403).send('Unauthorized');
        if (!order.activation_id) return res.status(400).send('Activation is not ready yet');
        if (!order.otp_received && String(order.order_status || '').toLowerCase() !== 'otp_received') {
            return res.status(400).send('Again OTP is available only after the first OTP arrives');
        }
        if (['completed', 'cancelled', 'expired_refunded'].includes(String(order.order_status || '').toLowerCase())) {
            return res.status(400).send('This order is already closed');
        }
        const providerUpdate = await updateProviderActivationStatus(order.activation_id, 3);
        if (!providerUpdate.success && !providerUpdate.skipped) {
            return res.status(502).send('Could not request another OTP right now');
        }
        await updateOrder(order.id, {
            otp_received: false,
            otp_code: null,
            order_status: 'retry_requested'
        });
        res.send('OK');
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Again OTP failed'));
    }
});

app.post('/api/orders/:orderId/expire', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        if (order.user_id !== user.id && user.role !== 'admin') {
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
        if (order.user_id !== user.id && user.role !== 'admin') {
            return res.status(403).send('Unauthorized');
        }
        if (order.order_status === 'expired_refunded') {
            return res.json({ received: false, expired: true, refunded: true, message: EXPIRED_REFUND_MESSAGE });
        }
        if (order.otp_received) {
            return res.json({ received: true, code: order.otp_code });
        }
        if (!['active', 'retry_requested'].includes(String(order.order_status || '').toLowerCase())) {
            return res.json({ received: false, inactive: true, status: order.order_status });
        }
        if (!order.activation_id) {
            return res.json({ received: false, error: 'No activation ID' });
        }
        const now = new Date();
        const expiry = new Date(order.expires_at);
        if (now >= expiry && !order.otp_received && ['active', 'retry_requested'].includes(String(order.order_status || '').toLowerCase())) {
            const expireResult = await expireOrderAndRefund(order.id);
            return res.json({
                received: false,
                expired: true,
                refunded: expireResult.refunded,
                message: expireResult.message || EXPIRED_REFUND_MESSAGE
            });
        }
        if (!['active', 'retry_requested'].includes(String(order.order_status || '').toLowerCase())) {
            return res.json({ received: false, inactive: true, status: order.order_status });
        }
        const smsResult = await checkSmsStatus(order.activation_id);
        if (smsResult.success && smsResult.code) {
            await updateOrder(order.id, {
                otp_received: true,
                otp_code: smsResult.code,
                order_status: 'otp_received'
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
