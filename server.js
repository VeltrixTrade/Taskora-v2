require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const { Pool } = require("pg");
const QRCode = require("qrcode");
const emailService = require("./emailService");

const app = express();
const APP_VERSION = "remove-native-res-json-v7";


// ABSOLUTE_API_JSON_FIX_ROUTES

app.get("/api/diagnostic", (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    message: "API diagnostic route is working",
    next_step: "If the browser shows an API_HTML_RESPONSE box, copy the URL from it."
  });
});

app.get("/api/health", (_req, res) => {
  res.type("application/json").json({ ok: true, api: true, version: APP_VERSION });
});
app.get("/api/version", (_req, res) => {
  res.type("application/json").json({ version: APP_VERSION, updated: true, api: true });
});


// Early API health/version routes for Railway diagnostics.
app.get("/api/health", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json({ ok: true, api: true, version: APP_VERSION });
});
app.get("/api/version", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json({ version: APP_VERSION, updated: true, api: true });
});


app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: APP_VERSION, api: true });
});
app.get("/api/version", (_req, res) => {
  res.json({ version: APP_VERSION, updated: true, api: true, note: "If this is JSON, backend is connected." });
});


app.get("/api/version", (_req, res) => {
  res.json({ version: APP_VERSION, updated: true, fix: "json-parse" });
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DATABASE_URL = process.env.DATABASE_URL;
const MIN_WITHDRAWAL_AMOUNT = Number(process.env.MIN_WITHDRAWAL_AMOUNT || 10);
const DAILY_WITHDRAWAL_LIMIT = Number(process.env.DAILY_WITHDRAWAL_LIMIT || 5000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 15);
const APP_URL = process.env.APP_URL || "";

if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is not set. Add PostgreSQL on Railway and set DATABASE_URL.");
}

let migrationStatus = "pending";
let migrationError = null;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "uploads"));
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Only JPG, PNG, WEBP, or PDF files are allowed."));
    cb(null, true);
  }
});

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 250,
  standardHeaders: true,
  legacyHeaders: false
}));


function normalize(value) {
  return String(value || "").trim();
}

function lower(value) {
  return normalize(value).toLowerCase();
}

function makeReferral(username) {
  const prefix = normalize(username).replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase() || "TASK";
  return `${prefix}${Math.floor(10000 + Math.random() * 89999)}`;
}

function documentHash(type, number) {
  return crypto.createHash("sha256")
    .update(`${lower(type)}:${lower(number)}`)
    .digest("hex");
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function createNotification(clientOrPool, userId, title, body, type = "info") {
  const runner = clientOrPool && typeof clientOrPool.query === "function" ? clientOrPool : pool;
  await runner.query(
    "INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,$4)",
    [userId, title, body, type]
  );
}

async function logAdminAction(clientOrPool, adminId, action, targetType, targetId, details = {}) {
  const runner = clientOrPool && typeof clientOrPool.query === "function" ? clientOrPool : pool;
  await runner.query(
    "INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)",
    [adminId, action, targetType, targetId, JSON.stringify(details || {})]
  );
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function sendMail(to, subject, html) {
  return emailService.sendEmail(to, subject, html);
}




async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      package_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      package_profit NUMERIC(12,2) NOT NULL DEFAULT 0,
      referral_code VARCHAR(50) UNIQUE NOT NULL,
      referred_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      kyc_status VARCHAR(30) NOT NULL DEFAULT 'not_verified',
      bonus_claimed BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS otps (
      id BIGSERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code VARCHAR(6) NOT NULL,
      type VARCHAR(50) NOT NULL,
      attempts INTEGER DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255);`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255);`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;`);

  await query(`
    CREATE TABLE IF NOT EXISTS user_kyc (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_type VARCHAR(30) NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      document_number VARCHAR(120) UNIQUE NOT NULL,
      document_hash VARCHAR(255) UNIQUE NOT NULL,
      front_image TEXT NOT NULL,
      back_image TEXT,
      selfie_image TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS welcome_bonuses (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_hash VARCHAR(255) UNIQUE NOT NULL,
      amount NUMERIC(12,2) NOT NULL DEFAULT 10.00,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      coin VARCHAR(20) NOT NULL,
      txid VARCHAR(255) NOT NULL,
      proof_image TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      coin VARCHAR(20) NOT NULL,
      wallet_address TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      txid VARCHAR(255),
      admin_note TEXT,
      reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(60) NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      description TEXT NOT NULL,
      balance_before NUMERIC(12,2) NOT NULL DEFAULT 0,
      balance_after NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);



  await query(`
    CREATE TABLE IF NOT EXISTS admin_balance_adjustments (
      id BIGSERIAL PRIMARY KEY,
      admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      field VARCHAR(40) NOT NULL,
      action VARCHAR(40) NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      balance_before NUMERIC(12,2) NOT NULL DEFAULT 0,
      balance_after NUMERIC(12,2) NOT NULL DEFAULT 0,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS wallet_addresses (
      id BIGSERIAL PRIMARY KEY,
      coin VARCHAR(20) UNIQUE NOT NULL,
      address TEXT NOT NULL,
      network VARCHAR(80),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    INSERT INTO wallet_addresses (coin, address, network, is_active)
    VALUES
      ('usdt_trc20', 'TRiN4r8FkteWnAKwdgQ6UJXh3VPSL1hbSQ', 'TRC20', true),
      ('usdt_erc20', '0xab3f219c2132edee0203d2d1a365e281a3508021', 'ERC20', true),
      ('btc', 'bc1q245hjxk4836qg0qg5r2w4k0szp66l3r2xp6end44gdh3d4nxft7swh7jwg', 'Bitcoin', true),
      ('sol', 'HpJDweX8pfW2a25rbcExW7b3mhk9FLu4SsThJxzHMJYN', 'Solana', true)
    ON CONFLICT (coin) 
    DO UPDATE SET address = EXCLUDED.address, network = EXCLUDED.network, is_active = true;
  `);

  await query(`
    DELETE FROM wallet_addresses 
    WHERE coin NOT IN ('usdt_trc20', 'usdt_erc20', 'btc', 'sol');
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_packages (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      package_id VARCHAR(50) NOT NULL,
      package_name VARCHAR(120) NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      profit_target NUMERIC(12,2) NOT NULL,
      completed_count INTEGER NOT NULL DEFAULT 0,
      completed_tasks JSONB NOT NULL DEFAULT '[]',
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
  `);

  await query(`ALTER TABLE user_packages ADD COLUMN IF NOT EXISTS original_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await query(`ALTER TABLE user_packages ADD COLUMN IF NOT EXISTS cycle_count INTEGER NOT NULL DEFAULT 0;`);

  await query(`
    CREATE TABLE IF NOT EXISTS golden_tasks (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      reward NUMERIC(12,2) NOT NULL DEFAULT 10,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      sent_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await query(`ALTER TABLE golden_tasks ADD COLUMN IF NOT EXISTS proof_image VARCHAR(255);`);
  await query(`ALTER TABLE golden_tasks ADD COLUMN IF NOT EXISTS user_note TEXT;`);
  await query(`ALTER TABLE golden_tasks ADD COLUMN IF NOT EXISTS admin_note TEXT;`);
  await query(`ALTER TABLE golden_tasks ADD COLUMN IF NOT EXISTS task_link VARCHAR(500);`);



  await query(`CREATE INDEX IF NOT EXISTS transactions_user_created_idx ON transactions (user_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS withdrawals_user_created_idx ON withdrawals (user_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS deposits_user_created_idx ON deposits (user_id, created_at DESC);`);


  await query(`CREATE UNIQUE INDEX IF NOT EXISTS deposits_txid_unique_idx ON deposits (lower(txid));`);


  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      type VARCHAR(40) NOT NULL DEFAULT 'info',
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(120) NOT NULL,
      target_type VARCHAR(80),
      target_id BIGINT,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);



  await query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject VARCHAR(255) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'general',
      message TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      admin_reply TEXT,
      replied_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      replied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets (user_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status);`);

  await query(`
    CREATE TABLE IF NOT EXISTS support_emails (
      id BIGSERIAL PRIMARY KEY,
      sender_email VARCHAR(255) NOT NULL,
      sender_name VARCHAR(255),
      subject VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS support_emails_created_idx ON support_emails (created_at DESC);`);



  await query(`
    CREATE TABLE IF NOT EXISTS admin_user_notes (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS login_activity (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      ip_address VARCHAR(120),
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_locked_until TIMESTAMPTZ;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_withdrawal_wallet TEXT;`);
  await query(`CREATE INDEX IF NOT EXISTS admin_user_notes_user_idx ON admin_user_notes (user_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS login_activity_user_idx ON login_activity (user_id, created_at DESC);`);


  await seedAdmin();
}

async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME || "admin";
  const email = lower(process.env.ADMIN_EMAIL || "admin@taskora.app");
  const phone = normalize(process.env.ADMIN_PHONE || "0000000000");
  const password = process.env.ADMIN_PASSWORD || "Admin12345";

  const exists = await query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (exists.rowCount > 0) return;

  const passwordHash = await bcrypt.hash(password, 12);
  let referral = makeReferral(username);
  await query(`
    INSERT INTO users (username, email, phone, password_hash, role, referral_code, kyc_status, status)
    VALUES ($1,$2,$3,$4,'admin',$5,'verified','active')
  `, [username, email, phone, passwordHash, referral]);

  console.log(`Admin created: ${email} / ${password}`);
}

async function addTransaction(client, userId, type, amount, description) {
  const userRes = await client.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [userId]);
  const before = Number(userRes.rows[0]?.balance || 0);
  const after = before + Number(amount);
  await client.query("UPDATE users SET balance=$1 WHERE id=$2", [after, userId]);
  await client.query(`
    INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [userId, type, amount, description, before, after]);
  return { before, after };
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const altToken = req.headers["x-taskora-token"] || req.query.token || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : (altToken || null);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await query("SELECT * FROM users WHERE id=$1", [payload.id]);
    if (result.rowCount === 0) return res.status(401).json({ error: "Unauthorized" });
    if (result.rows[0].status !== "active") return res.status(403).json({ error: "Account blocked" });
    req.user = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role,
    balance: Number(user.balance),
    package_balance: Number(user.package_balance),
    package_profit: Number(user.package_profit),
    referral_code: user.referral_code,
    kyc_status: user.kyc_status,
    bonus_claimed: user.bonus_claimed,
    email_verified: user.email_verified,
    status: user.status,
    avatar_url: user.avatar_url,
    avatar_updated_at: user.avatar_updated_at,
    withdrawal_locked_until: user.withdrawal_locked_until,
    created_at: user.created_at
  };
}

const PACKAGES = [
  { id: "bronze", name: "البرونزية", price: 10, tasks: 12 },
  { id: "silver", name: "الفضية", price: 25, tasks: 12 },
  { id: "gold", name: "الذهبية", price: 50, tasks: 12 },
  { id: "platinum", name: "البلاتينيوم", price: 100, tasks: 12 },
  { id: "vip", name: "VIP", price: 500, tasks: 12 },
  { id: "diamond", name: "VIP النخبة", price: 1000, tasks: 12 },
  { id: "crown_vip", name: "VIP التاج", price: 2000, tasks: 12 },
  { id: "royal_vip", name: "VIP الملكية", price: 5000, tasks: 12 }
];

const DAILY_TASKS = [
  "محاكاة بيع تذكرة مباراة",
  "محاكاة بيع تذكرة فيلم",
  "محاكاة إكمال طلب سحب",
  "محاكاة تأكيد حجز تذكرة حفل",
  "محاكاة تأكيد طلب تذكرة سفر",
  "محاكاة معالجة طلب استرجاع تذكرة",
  "محاكاة بيع تذكرة مسرح",
  "محاكاة تأكيد طلب تذكرة قطار",
  "محاكاة مراجعة طلب تذكرة VIP",
  "محاكاة إغلاق طلب حجز فعالية",
  "محاكاة تأكيد تذكرة مهرجان",
  "محاكاة مراجعة طلب تذكرة رياضية",
  "محاكاة تأكيد حجز تذكرة طيران",
  "محاكاة معالجة طلب اشتراك برونزي",
  "محاكاة بيع تذكرة عرض كوميدي",
  "محاكاة مراجعة حجز قاعة مؤتمرات"
];

app.get("/health", async (_req, res) => {
  const payload = {
    status: "ok",
    app: "Taskora Real MVP",
    version: APP_VERSION,
    uptime: process.uptime(),
    database: "unchecked",
    migration: migrationStatus,
    migration_error: migrationError,
    frontend_index_exists: fs.existsSync(path.join(__dirname, "public", "index.html")),
    cwd: process.cwd(),
    dirname: __dirname
  };

  try {
    await query("SELECT 1");
    payload.database = "connected";
  } catch (err) {
    payload.database = "disconnected";
    payload.database_error = err && err.message ? err.message : "unknown";
  }

  res.status(200).json(payload);
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = normalize(req.body.username);
    const email = lower(req.body.email);
    const phone = normalize(req.body.phone);
    const password = normalize(req.body.password);
    const referral = normalize(req.body.referral_code);

    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(422).json({ error: "Username must be 3-30 characters: letters, numbers, underscore." });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(422).json({ error: "Invalid email." });
    }
    if (!/^[0-9+()\-\s]{7,25}$/.test(phone)) {
      return res.status(422).json({ error: "Invalid phone number." });
    }
    if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(password)) {
      return res.status(422).json({ error: "Password must be at least 8 characters and contain letters and numbers." });
    }

    const duplicate = await query(
      "SELECT username,email,phone FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($2) OR phone=$3 LIMIT 1",
      [username, email, phone]
    );
    if (duplicate.rowCount > 0) {
      return res.status(409).json({ error: "Username, email, or phone already exists." });
    }

    let referredBy = null;
    if (referral) {
      const refRes = await query("SELECT id FROM users WHERE UPPER(TRIM(referral_code)) = UPPER(TRIM($1))", [referral]);
      if (refRes.rowCount > 0) referredBy = refRes.rows[0].id;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let referralCode = makeReferral(username);
    for (let i = 0; i < 5; i++) {
      const exists = await query("SELECT id FROM users WHERE referral_code=$1", [referralCode]);
      if (exists.rowCount === 0) break;
      referralCode = makeReferral(username);
    }

    const verificationToken = makeToken();
    const result = await query(`
      INSERT INTO users (username, email, phone, password_hash, referral_code, referred_by, email_verification_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [username, email, phone, passwordHash, referralCode, referredBy, verificationToken]);

    const user = result.rows[0];
    await createNotification(pool, user.id, "مرحبًا بك في Taskora", "أكمل توثيق البريد والهوية لتفعيل كامل المزايا.", "welcome");

    // Generate 6-digit OTP for email verification
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    await query(`
      INSERT INTO otps (email, code, type, expires_at)
      VALUES ($1, $2, 'email_verification', NOW() + interval '10 minutes')
    `, [email, otpCode]);

    // Send styled welcome and verification email using Resend
    await emailService.sendOTPEmail(email, username, otpCode, "email_verification");

    res.status(201).json({ token: signToken(user), user: publicUser(user), verification_url: `/api/auth/verify-email/${verificationToken}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const login = lower(req.body.login || req.body.email || req.body.username);
    const password = normalize(req.body.password);
    const result = await query("SELECT * FROM users WHERE lower(email)=lower($1) OR lower(username)=lower($1) LIMIT 1", [login]);
    if (result.rowCount === 0) return res.status(401).json({ error: "Invalid credentials." });
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });
    if (user.status !== "active") return res.status(403).json({ error: "Account blocked." });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed." });
  }
});


app.get("/api/auth/verify-email/:token", async (req, res) => {
  const token = normalize(req.params.token);
  if (!token) return res.status(422).send("Invalid token.");
  const result = await query("UPDATE users SET email_verified=true, email_verification_token=NULL WHERE email_verification_token=$1 RETURNING id", [token]);
  if (result.rowCount === 0) return res.status(404).send("Verification link is invalid or already used.");
  await createNotification(pool, result.rows[0].id, "تم تأكيد البريد", "تم تأكيد بريدك الإلكتروني بنجاح.", "success");
  res.send("تم تأكيد البريد الإلكتروني بنجاح. يمكنك العودة إلى Taskora.");
});

app.post("/api/auth/resend-verification", auth, async (req, res) => {
  if (req.user.email_verified) return res.json({ message: "Email already verified." });
  const token = makeToken();
  await query("UPDATE users SET email_verification_token=$1 WHERE id=$2", [token, req.user.id]);
  const url = `${APP_URL}/api/auth/verify-email/${token}`;
  await sendMail(req.user.email, "رابط تأكيد بريد Taskora", `<p>اضغط الرابط لتأكيد بريدك:</p><p><a href="${url}">تأكيد البريد</a></p>`);
  await createNotification(pool, req.user.id, "رابط تأكيد البريد", "تم إنشاء رابط تأكيد جديد. في النسخة التجريبية يظهر الرابط في الاستجابة وسجلات السيرفر.", "info");
  res.json({ verification_url: `/api/auth/verify-email/${token}` });
});

app.post("/api/auth/change-password", auth, async (req, res) => {
  const currentPassword = normalize(req.body.current_password);
  const newPassword = normalize(req.body.new_password);
  if (!/^(?=.*[A-Za-z])(?=.*\\d)[A-Za-z\\d]{8,}$/.test(newPassword)) {
    return res.status(422).json({ error: "New password must be at least 8 characters and contain letters and numbers." });
  }
  const ok = await bcrypt.compare(currentPassword, req.user.password_hash);
  if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await query("UPDATE users SET password_hash=$1, withdrawal_locked_until=NOW() + interval '24 hours' WHERE id=$2", [passwordHash, req.user.id]);
  await createNotification(pool, req.user.id, "تم تغيير كلمة المرور", "تم تغيير كلمة مرور حسابك بنجاح.", "success");
  res.json({ success: true });
});



app.post("/api/auth/request-password-reset", async (req, res) => {
  try {
    const email = lower(req.body.email);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(422).json({ error: "Valid email is required." });
    }

    const result = await query("SELECT id,email,username FROM users WHERE lower(email)=lower($1) LIMIT 1", [email]);
    // Do not reveal whether the email exists.
    if (result.rowCount === 0) return res.json({ success: true });

    const user = result.rows[0];

    // Anti-spam Cooldown check: 60 seconds
    const lastOtp = await query(`
      SELECT created_at FROM otps 
      WHERE lower(email) = lower($1) AND type = 'password_reset'
      ORDER BY id DESC LIMIT 1
    `, [user.email]);

    if (lastOtp.rowCount > 0) {
      const diffMs = Date.now() - new Date(lastOtp.rows[0].created_at).getTime();
      if (diffMs < 60000) {
        const waitSec = Math.ceil((60000 - diffMs) / 1000);
        return res.status(429).json({ error: `الرجاء الانتظار ${waitSec} ثانية قبل طلب كود جديد.` });
      }
    }

    // Daily limit check: 5 codes per 24 hours
    const dailyCount = await query(`
      SELECT COUNT(*)::int AS count FROM otps 
      WHERE lower(email) = lower($1) AND type = 'password_reset' AND created_at > NOW() - interval '24 hours'
    `, [user.email]);

    if (dailyCount.rows[0].count >= 5) {
      return res.status(429).json({ error: "لقد تجاوزت الحد الأقصى لإرسال الأكواد اليوم (5 أكواد). يرجى المحاولة غداً." });
    }

    // Generate 6-digit OTP code for password reset
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    await query(`
      INSERT INTO otps (email, code, type, expires_at)
      VALUES ($1, $2, 'password_reset', NOW() + interval '10 minutes')
    `, [user.email, otpCode]);

    // Send styled password reset email using Resend
    await emailService.sendOTPEmail(user.email, user.username, otpCode, "password_reset");

    const token = makeToken();
    await query("UPDATE users SET password_reset_token=$1, password_reset_expires=NOW() + interval '30 minutes' WHERE id=$2", [token, user.id]);
    const url = `${APP_URL}/reset-password?token=${token}`;
    await createNotification(pool, user.id, "طلب استعادة كلمة المرور", "تم إنشاء رابط استعادة كلمة مرور لحسابك.", "info");

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to request password reset." });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const token = normalize(req.body.token);
  const newPassword = normalize(req.body.new_password);
  if (!token) return res.status(422).json({ error: "Reset token is required." });
  if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(newPassword)) {
    return res.status(422).json({ error: "New password must be at least 8 characters and contain letters and numbers." });
  }

  const result = await query("SELECT id FROM users WHERE password_reset_token=$1 AND password_reset_expires > NOW() LIMIT 1", [token]);
  if (result.rowCount === 0) return res.status(404).json({ error: "Reset link is invalid or expired." });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await query("UPDATE users SET password_hash=$1, password_reset_token=NULL, password_reset_expires=NULL, failed_login_attempts=0, locked_until=NULL WHERE id=$2", [passwordHash, result.rows[0].id]);
  await createNotification(pool, result.rows[0].id, "تمت استعادة كلمة المرور", "تم تعيين كلمة مرور جديدة لحسابك.", "success");
  res.json({ success: true });
});


// ==========================================
// NEW OTP & EMAIL SERVICE SYSTEM ENDPOINTS
// ==========================================

// 1. Send OTP for Email Verification (Authenticated)
app.post("/api/auth/send-otp", auth, async (req, res) => {
  try {
    const email = req.user.email;
    const username = req.user.username;

    if (req.user.email_verified) {
      return res.status(400).json({ error: "البريد الإلكتروني مؤكد بالفعل." });
    }

    // Cooldown check: 60 seconds
    const lastOtp = await query(`
      SELECT created_at FROM otps 
      WHERE lower(email) = lower($1) AND type = 'email_verification'
      ORDER BY id DESC LIMIT 1
    `, [email]);

    if (lastOtp.rowCount > 0) {
      const diffMs = Date.now() - new Date(lastOtp.rows[0].created_at).getTime();
      if (diffMs < 60000) {
        const waitSec = Math.ceil((60000 - diffMs) / 1000);
        return res.status(429).json({ error: `الرجاء الانتظار ${waitSec} ثانية قبل طلب كود جديد.` });
      }
    }

    // Daily limit check: 5 codes per 24 hours
    const dailyCount = await query(`
      SELECT COUNT(*)::int AS count FROM otps 
      WHERE lower(email) = lower($1) AND type = 'email_verification' AND created_at > NOW() - interval '24 hours'
    `, [email]);

    if (dailyCount.rows[0].count >= 5) {
      return res.status(429).json({ error: "لقد تجاوزت الحد الأقصى لإرسال الأكواد اليوم (5 أكواد). يرجى المحاولة غداً." });
    }

    // Generate 6-digit OTP code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await query(`
      INSERT INTO otps (email, code, type, expires_at)
      VALUES ($1, $2, 'email_verification', NOW() + interval '10 minutes')
    `, [email, code]);

    // Send styled welcome and verification email using Resend
    await emailService.sendOTPEmail(email, username, code, "email_verification");
    await createNotification(pool, req.user.id, "إرسال كود التحقق", "تم إرسال كود تحقق جديد إلى بريدك الإلكتروني.", "info");

    res.json({ success: true, message: "تم إرسال كود تحقق جديد بنجاح." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "فشل إرسال كود التحقق." });
  }
});

// 2. Verify OTP for Email Verification (Authenticated)
app.post("/api/auth/verify-otp", auth, async (req, res) => {
  try {
    const email = req.user.email.toLowerCase().trim();
    const code = String(req.body.code || "").trim();

    if (!/^\d{6}$/.test(code)) {
      return res.status(422).json({ error: "كود التحقق يجب أن يتكون من 6 أرقام." });
    }

    // Check for matching active OTP
    const otpRes = await query(`
      SELECT * FROM otps 
      WHERE lower(email) = lower($1) AND type = 'email_verification' AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1
    `, [email]);

    if (otpRes.rowCount === 0) {
      return res.status(404).json({ error: "كود التحقق غير صالح أو منتهي الصلاحية. يرجى طلب كود جديد." });
    }

    const otp = otpRes.rows[0];

    if (otp.attempts >= 3) {
      await query("DELETE FROM otps WHERE id = $1", [otp.id]);
      return res.status(422).json({ error: "لقد تجاوزت الحد الأقصى للمحاولات الخاطئة (3 محاولات). يرجى طلب كود جديد." });
    }

    if (otp.code !== code) {
      await query("UPDATE otps SET attempts = attempts + 1 WHERE id = $1", [otp.id]);
      const remaining = 3 - (otp.attempts + 1);
      return res.status(400).json({ error: `كود التحقق غير صحيح. المحاولات المتبقية: ${remaining}.` });
    }

    // Valid code! Mark user as verified
    await query("UPDATE users SET email_verified = true, email_verification_token = NULL WHERE id = $1", [req.user.id]);
    await query("DELETE FROM otps WHERE email = $1 AND type = 'email_verification'", [email]);
    await createNotification(pool, req.user.id, "تم تأكيد البريد الإلكتروني", "تم تأكيد بريدك الإلكتروني بنجاح باستخدام كود التحقق.", "success");

    res.json({ success: true, message: "تم تأكيد البريد الإلكتروني بنجاح." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "فشل التحقق من الكود." });
  }
});

// 3. Reset Password using OTP (Public)
app.post("/api/auth/reset-password-otp", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const code = String(req.body.code || "").trim();
    const newPassword = String(req.body.new_password || "").trim();

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(422).json({ error: "يرجى إدخال بريد إلكتروني صالح." });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(422).json({ error: "كود التحقق يجب أن يتكون من 6 أرقام." });
    }
    if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(newPassword)) {
      return res.status(422).json({ error: "كلمة المرور يجب أن تكون من 8 خانات على الأقل وتحتوي على حروف وأرقام." });
    }

    // Find matching user
    const userRes = await query("SELECT id, username FROM users WHERE lower(email) = lower($1) LIMIT 1", [email]);
    if (userRes.rowCount === 0) {
      return res.status(404).json({ error: "كود التحقق غير صالح أو منتهي الصلاحية." });
    }
    const user = userRes.rows[0];

    // Find matching active OTP
    const otpRes = await query(`
      SELECT * FROM otps 
      WHERE lower(email) = lower($1) AND type = 'password_reset' AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1
    `, [email]);

    if (otpRes.rowCount === 0) {
      return res.status(404).json({ error: "كود التحقق غير صالح أو منتهي الصلاحية. يرجى طلب كود جديد." });
    }

    const otp = otpRes.rows[0];

    if (otp.attempts >= 3) {
      await query("DELETE FROM otps WHERE id = $1", [otp.id]);
      return res.status(422).json({ error: "لقد تجاوزت الحد الأقصى للمحاولات الخاطئة (3 محاولات). يرجى طلب كود جديد." });
    }

    if (otp.code !== code) {
      await query("UPDATE otps SET attempts = attempts + 1 WHERE id = $1", [otp.id]);
      const remaining = 3 - (otp.attempts + 1);
      return res.status(400).json({ error: `كود التحقق غير صحيح. المحاولات المتبقية: ${remaining}.` });
    }

    // Valid reset! Update password
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query(`
      UPDATE users 
      SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL, failed_login_attempts = 0, locked_until = NULL, withdrawal_locked_until = NOW() + interval '24 hours'
      WHERE id = $2
    `, [passwordHash, user.id]);

    await query("DELETE FROM otps WHERE email = $1 AND type = 'password_reset'", [email]);
    await createNotification(pool, user.id, "تمت استعادة كلمة المرور", "تم إعادة تعيين كلمة المرور بنجاح باستخدام كود التحقق.", "success");

    res.json({ success: true, message: "تم إعادة تعيين كلمة المرور بنجاح." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "فشل إعادة تعيين كلمة المرور." });
  }
});





app.get("/api/me", auth, async (req, res) => {
  const pkg = await query("SELECT * FROM user_packages WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [req.user.id]);
  const kyc = await query("SELECT id, document_type, full_name, document_number, status, admin_note, created_at, reviewed_at FROM user_kyc WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [req.user.id]);
  const unread = await query("SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1 AND is_read=false", [req.user.id]);
  res.json({ user: publicUser(req.user), package: pkg.rows[0] || null, kyc: kyc.rows[0] || null, unread_notifications: unread.rows[0].count, server_time: new Date().toISOString() });
});


app.post("/api/profile/avatar", auth, upload.single("avatar"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(422).json({ error: "Avatar image is required." });
    if (!(file.mimetype || "").startsWith("image/")) {
      return res.status(422).json({ error: "Avatar must be an image file." });
    }
    const avatarUrl = `/api/public/avatar/${file.filename}`;
    await query("UPDATE users SET avatar_url=$1, avatar_updated_at=NOW() WHERE id=$2", [avatarUrl, req.user.id]);
    res.json({ success: true, avatar_url: avatarUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Avatar upload failed." });
  }
});

app.delete("/api/profile/avatar", auth, async (req, res) => {
  try {
    await query("UPDATE users SET avatar_url=NULL, avatar_updated_at=NOW() WHERE id=$1", [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Avatar delete failed." });
  }
});

app.post("/api/kyc", auth, upload.fields([
  { name: "front_image", maxCount: 1 },
  { name: "back_image", maxCount: 1 },
  { name: "selfie_image", maxCount: 1 }
]), async (req, res) => {
  try {
    const documentType = normalize(req.body.document_type);
    const fullName = normalize(req.body.full_name);
    const documentNumber = normalize(req.body.document_number);
    const front = req.files?.front_image?.[0];

    if (!["id_card", "passport"].includes(documentType)) return res.status(422).json({ error: "Invalid document type." });
    if (!fullName || fullName.length < 3) return res.status(422).json({ error: "Full name is required." });
    if (!documentNumber || documentNumber.length < 4) return res.status(422).json({ error: "Document number is required." });
    if (!front) return res.status(422).json({ error: "Front document image is required." });

    const existingForUser = await query("SELECT id,status FROM user_kyc WHERE user_id=$1 AND status IN ('pending','verified') LIMIT 1", [req.user.id]);
    if (existingForUser.rowCount > 0) {
      return res.status(409).json({ error: "You already have a pending or verified KYC request." });
    }

    const hash = documentHash(documentType, documentNumber);
    const duplicate = await query("SELECT id FROM user_kyc WHERE document_hash=$1 OR document_number=$2 LIMIT 1", [hash, documentNumber]);
    if (duplicate.rowCount > 0) {
      return res.status(409).json({ error: "This identity document has already been used. One identity can receive one account bonus only." });
    }

    const back = req.files?.back_image?.[0];
    const selfie = req.files?.selfie_image?.[0];
    const result = await query(`
      INSERT INTO user_kyc (user_id, document_type, full_name, document_number, document_hash, front_image, back_image, selfie_image)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,status,created_at
    `, [
      req.user.id,
      documentType,
      fullName,
      documentNumber,
      hash,
      `/api/files/${front.filename}`,
      back ? `/api/files/${back.filename}` : null,
      selfie ? `/api/files/${selfie.filename}` : null
    ]);

    await query("UPDATE users SET kyc_status='pending' WHERE id=$1", [req.user.id]);
    res.status(201).json({ kyc: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "KYC submission failed." });
  }
});

app.get("/api/packages", (_req, res) => {
  res.json({ packages: PACKAGES.map(p => ({ ...p, profit: Number((p.price * 0.10).toFixed(2)), per_task: Number(((p.price * 0.10) / 12).toFixed(2)) })) });
});

app.post("/api/packages/:id/buy", auth, async (req, res) => {
  const pkg = PACKAGES.find(p => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: "Package not found." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const active = await client.query("SELECT id FROM user_packages WHERE user_id=$1 AND status='active' LIMIT 1", [req.user.id]);
    if (active.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "You already have an active package." });
    }

    const userRes = await client.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
    const balance = Number(userRes.rows[0].balance);
    if (balance < pkg.price) {
      await client.query("ROLLBACK");
      return res.status(422).json({ error: "Insufficient balance. Deposit first and wait for admin approval." });
    }

    await client.query("UPDATE users SET balance=balance-$1, package_balance=$1, package_profit=0 WHERE id=$2", [pkg.price, req.user.id]);
    await client.query(`
      INSERT INTO user_packages (user_id, package_id, package_name, price, profit_target)
      VALUES ($1,$2,$3,$4,$5)
    `, [req.user.id, pkg.id, pkg.name, pkg.price, pkg.price * 0.10]);
    await client.query(`
      INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
      VALUES ($1,'package_purchase',$2,$3,$4,$5)
    `, [req.user.id, -pkg.price, `شراء باقة ${pkg.name}`, balance, balance - pkg.price]);
    await client.query("COMMIT");

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Package purchase failed." });
  } finally {
    client.release();
  }
});

app.get("/api/dashboard", auth, async (req, res) => {
  const pkg = await query("SELECT * FROM user_packages WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [req.user.id]);
  const transactions = await query("SELECT * FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 20", [req.user.id]);
  const golden = await query("SELECT * FROM golden_tasks WHERE user_id=$1 ORDER BY id DESC", [req.user.id]);
  res.json({
    user: publicUser(req.user),
    package: pkg.rows[0] || null,
    daily_tasks: DAILY_TASKS.map((title, index) => ({ number: index + 1, title })),
    transactions: transactions.rows,
    golden_tasks: golden.rows,
    server_time: new Date().toISOString()
  });
});

app.get("/api/time", (req, res) => {
  res.json({ server_time: new Date().toISOString() });
});

app.post("/api/tasks/daily/:number/complete", auth, async (req, res) => {
  const taskNumber = Number(req.params.number);
  if (!Number.isInteger(taskNumber) || taskNumber < 1 || taskNumber > 12) return res.status(422).json({ error: "Invalid task number." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pkgRes = await client.query("SELECT * FROM user_packages WHERE user_id=$1 AND status='active' ORDER BY id DESC LIMIT 1 FOR UPDATE", [req.user.id]);
    if (pkgRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No active package." });
    }
    const pkg = pkgRes.rows[0];
    const getMidnightGMT3 = (dateObj) => {
      const timeWithOffset = dateObj.getTime() + (3 * 60 * 60 * 1000);
      const shifted = new Date(timeWithOffset);
      return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
    };
    const startedMidnight = getMidnightGMT3(new Date(pkg.started_at));
    const currentMidnight = getMidnightGMT3(new Date());
    const daysElapsed = Math.max(1, Math.floor((currentMidnight - startedMidnight) / (24 * 60 * 60 * 1000)) + 1);
    const allowedMax = Math.min(12, daysElapsed * 3);

    if (taskNumber > allowedMax) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: `هذه المهمة غير متاحة اليوم. يرجى الانتظار حتى منتصف الليل بتوقيت GMT+3 (متاح اليوم حتى المهمة رقم ${allowedMax}).` });
    }

    const completed = Array.isArray(pkg.completed_tasks) ? pkg.completed_tasks : [];
    if (completed.includes(taskNumber)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Task already completed." });
    }

    const reward = Number(pkg.profit_target) / 12;
    const newCompleted = [...completed, taskNumber].sort((a,b) => a-b);
    const newCount = newCompleted.length;

    const isMonthly = false;
    const originalStart = pkg.original_started_at ? new Date(pkg.original_started_at).getTime() : new Date(pkg.started_at).getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const monthlyExpired = isMonthly && (Date.now() - originalStart >= thirtyDays);

    if (newCount >= 12) {
      const userRes = await client.query("SELECT balance, package_balance, package_profit FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
      const user = userRes.rows[0];
      const updatedProfit = Number(user.package_profit) + reward;

      if (isMonthly && !monthlyExpired) {
        const before = Number(user.balance);
        const after = before + updatedProfit;
        
        await client.query("UPDATE users SET balance=$1, package_profit=0 WHERE id=$2", [after, req.user.id]);
        await client.query("UPDATE user_packages SET completed_tasks='[]', completed_count=0, started_at=NOW(), cycle_count=cycle_count+1 WHERE id=$1", [pkg.id]);
        await client.query(`
          INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
          VALUES ($1,'package_cycle_profit',$2,'تحويل ربح دورة الباقة الشهرية إلى الرصيد المتاح بعد إكمال 12 مهمة',$3,$4)
        `, [req.user.id, updatedProfit, before, after]);
        
        await client.query("COMMIT");
        return res.json({ success: true, completed_count: 0, cycle_completed: true });
      } else {
        const unlocked = Number(user.package_balance) + updatedProfit;
        const before = Number(user.balance);
        const after = before + unlocked;

        await client.query("UPDATE users SET balance=$1, package_balance=0, package_profit=0 WHERE id=$2", [after, req.user.id]);
        await client.query("UPDATE user_packages SET completed_tasks=$1, completed_count=12, status='completed', completed_at=NOW() WHERE id=$2", [JSON.stringify(newCompleted), pkg.id]);
        await client.query(`
          INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
          VALUES ($1,'package_unlocked',$2,$3,$4,$5)
        `, [req.user.id, unlocked, isMonthly ? 'انتهاء الباقة الشهرية بالكامل وتحرير رأس المال والأرباح' : 'تحويل رصيد الباقة والربح إلى الرصيد المتاح بعد إكمال 12 مهمة', before, after]);
      }
    } else {
      await client.query("UPDATE users SET package_profit=package_profit+$1 WHERE id=$2", [reward, req.user.id]);
      await client.query("UPDATE user_packages SET completed_tasks=$1, completed_count=$2 WHERE id=$3", [JSON.stringify(newCompleted), newCount, pkg.id]);
      await client.query(`
        INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
        VALUES ($1,'daily_task',$2,$3,(SELECT balance FROM users WHERE id=$1),(SELECT balance FROM users WHERE id=$1))
      `, [req.user.id, reward, `إكمال مهمة يومية رقم ${taskNumber}`]);
    }

    await client.query("COMMIT");
    res.json({ success: true, completed_count: newCount });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Task completion failed." });
  } finally {
    client.release();
  }
});

app.post("/api/golden/:id/complete", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gt = await client.query("SELECT * FROM golden_tasks WHERE id=$1 AND user_id=$2 AND status='active' FOR UPDATE", [req.params.id, req.user.id]);
    if (gt.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Golden task not found." });
    }
    const reward = Number(gt.rows[0].reward);
    await addTransaction(client, req.user.id, "golden_task", reward, "إكمال مهمة ذهبية");
    await client.query("UPDATE golden_tasks SET status='completed', completed_at=NOW() WHERE id=$1", [req.params.id]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Golden task failed." });
  } finally {
    client.release();
  }
});

app.post("/api/golden/:id/complete-instant", auth, async (req, res) => {
  const taskId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // 1. Fetch and lock the custom task
    const gtRes = await client.query(
      "SELECT * FROM golden_tasks WHERE id=$1 AND user_id=$2 AND status IN ('active', 'rejected') FOR UPDATE",
      [taskId, req.user.id]
    );
    if (gtRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المهمة غير موجودة أو تم إكمالها بالفعل." });
    }
    const gt = gtRes.rows[0];
    const taskReward = Number(gt.reward || 0);

    // 2. Mark the task as completed
    await client.query(
      "UPDATE golden_tasks SET status='completed', completed_at=NOW() WHERE id=$1",
      [taskId]
    );

    // 3. Credit the custom task reward to available balance
    if (taskReward > 0) {
      await addTransaction(client, req.user.id, "golden_task_instant", taskReward, `أرباح إكمال مهمة: ${gt.title}`);
    }

    // 4. If they have an active package, progress the package!
    let packageCompleted = false;
    let newCount = 0;
    
    const pkgRes = await client.query(
      "SELECT * FROM user_packages WHERE user_id=$1 AND status='active' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [req.user.id]
    );
    if (pkgRes.rowCount > 0) {
      const pkg = pkgRes.rows[0];
      
      // Enforce Daily Limit (3 tasks per day) in GMT+3 timezone (Iraq & Syria)
      const getMidnightGMT3 = (dateObj) => {
        const timeWithOffset = dateObj.getTime() + (3 * 60 * 60 * 1000);
        const shifted = new Date(timeWithOffset);
        return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
      };
      const startedMidnight = getMidnightGMT3(new Date(pkg.started_at));
      const currentMidnight = getMidnightGMT3(new Date());
      const daysElapsed = Math.max(1, Math.floor((currentMidnight - startedMidnight) / (24 * 60 * 60 * 1000)) + 1);
      const allowedMax = Math.min(12, daysElapsed * 3);

      const completed = Array.isArray(pkg.completed_tasks) ? pkg.completed_tasks : [];
      const nextTaskNumber = completed.length + 1;

      if (nextTaskNumber > allowedMax) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: `عذراً، تجاوزت الحد المسموح به لليوم. متاح لك إكمال حتى المهمة رقم ${allowedMax} فقط اليوم. يرجى الانتظار حتى منتصف الليل بتوقيت العراق وسوريا (GMT+3) لفتح مهام اليوم التالي.` });
      }
      
      if (nextTaskNumber <= 12) {
        const newCompleted = [...completed, nextTaskNumber].sort((a,b) => a-b);
        newCount = newCompleted.length;
        const packageTaskReward = Number(pkg.profit_target) / 12;

        if (newCount >= 12) {
          packageCompleted = true;
          // Package fully completed! Unlock package balance and accumulated profits
          const userRes = await client.query("SELECT balance, package_balance, package_profit FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
          const user = userRes.rows[0];
          const updatedProfit = Number(user.package_profit) + packageTaskReward;
          const unlocked = Number(user.package_balance) + updatedProfit;
          const before = Number(user.balance);
          const after = before + unlocked;

          await client.query("UPDATE users SET balance=$1, package_balance=0, package_profit=0 WHERE id=$2", [after, req.user.id]);
          await client.query(
            "UPDATE user_packages SET completed_tasks=$1, completed_count=12, status='completed', completed_at=NOW() WHERE id=$2",
            [JSON.stringify(newCompleted), pkg.id]
          );
          await client.query(`
            INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
            VALUES ($1, 'package_unlocked', $2, $3, $4, $5)
          `, [req.user.id, unlocked, 'تحويل رصيد الباقة والربح إلى الرصيد المتاح بعد إكمال 12 مهمة حقيقية', before, after]);
        } else {
          // Normal progression: add task reward portion to package_profit
          await client.query("UPDATE users SET package_profit=package_profit+$1 WHERE id=$2", [packageTaskReward, req.user.id]);
          await client.query(
            "UPDATE user_packages SET completed_tasks=$1, completed_count=$2 WHERE id=$3",
            [JSON.stringify(newCompleted), newCount, pkg.id]
          );
        }
      }
    }

    await client.query("COMMIT");
    res.json({
      success: true,
      reward: taskReward,
      package_completed: packageCompleted,
      new_completed_count: newCount,
      message: "تم إكمال المهمة بنجاح وصرف الأرباح فوراً!"
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "فشل إكمال المهمة فورياً." });
  } finally {
    client.release();
  }
});

app.post("/api/deposits", auth, upload.single("proof_image"), async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const coin = lower(req.body.coin);
    const txid = normalize(req.body.txid);
    if (!amount || amount <= 0) return res.status(422).json({ error: "Invalid amount." });
  if (amount < MIN_WITHDRAWAL_AMOUNT) return res.status(422).json({ error: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT}.` });
    if (!["usdt_trc20", "usdt_erc20", "btc", "sol"].includes(coin)) return res.status(422).json({ error: "Invalid coin." });
    if (!txid || txid.length < 4) return res.status(422).json({ error: "TXID is required." });

    const duplicateTx = await query("SELECT id FROM deposits WHERE lower(txid)=lower($1) LIMIT 1", [txid]);
    if (duplicateTx.rowCount > 0) {
      return res.status(409).json({ error: "This TXID has already been submitted." });
    }

    if (!req.file) {
      return res.status(422).json({ error: "إثبات الدفع (لقطة الشاشة) مطلوب وإجباري لإتمام الإيداع." });
    }
    const proof = `/api/files/${req.file.filename}`;
    const result = await query(`
      INSERT INTO deposits (user_id, amount, coin, txid, proof_image)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.user.id, amount, coin, txid, proof]);
    res.status(201).json({ deposit: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Deposit request failed." });
  }
});

app.post("/api/withdrawals", auth, async (req, res) => {
  const amount = Number(req.body.amount);
  const coin = lower(req.body.coin);
  const wallet = normalize(req.body.wallet_address);
  const confirmWallet = normalize(req.body.confirm_wallet_address || req.body.wallet_confirm);

  if (req.user.kyc_status !== "verified") return res.status(403).json({ error: "KYC verification is required before withdrawals." });
  if (!amount || amount <= 0) return res.status(422).json({ error: "Invalid amount." });
  if (!["usdt_trc20", "usdt_erc20", "btc", "sol"].includes(coin)) return res.status(422).json({ error: "Invalid coin." });
  if (!wallet || wallet.length < 10) return res.status(422).json({ error: "Wallet address is required." });
  if (wallet !== confirmWallet) return res.status(422).json({ error: "Wallet confirmation does not match." });

  const daily = await query(`
    SELECT COALESCE(SUM(amount),0)::numeric AS total
    FROM withdrawals
    WHERE user_id=$1 AND status IN ('pending','approved') AND created_at > NOW() - interval '24 hours'
  `, [req.user.id]);
  if (Number(daily.rows[0].total) + amount > DAILY_WITHDRAWAL_LIMIT) {
    return res.status(422).json({ error: `Daily withdrawal limit exceeded. Limit is ${DAILY_WITHDRAWAL_LIMIT}.` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query("SELECT balance, bonus_claimed FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
    const balance = Number(userRes.rows[0].balance);
    const bonusClaimed = !!userRes.rows[0].bonus_claimed;

    if (balance < amount) {
      await client.query("ROLLBACK");
      return res.status(422).json({ error: "Insufficient balance." });
    }

    let withdrawableBalance = balance;
    let isBonusWithdrawal = false;

    if (bonusClaimed) {
      isBonusWithdrawal = true;
      // 50% of the welcome bonus ($5.00) is permanently locked/deleted.
      // The withdrawable balance is their total balance minus $5.00.
      withdrawableBalance = balance - 5.00;
    }

    if (amount > withdrawableBalance) {
      await client.query("ROLLBACK");
      return res.status(422).json({ error: "رصيدك غير متاح للسحب" });
    }

    if (isBonusWithdrawal) {
      // 1. Create withdrawal request for the requested amount
      await client.query(`
        INSERT INTO withdrawals (user_id, amount, coin, wallet_address)
        VALUES ($1,$2,$3,$4)
      `, [req.user.id, amount, coin, wallet]);

      // 2. Deduct both the withdrawal amount AND the $5 locked bonus portion, and clear the bonus_claimed flag (one-time only)
      const newBalance = balance - 5.00 - amount;
      await client.query("UPDATE users SET balance=$1, bonus_claimed=false WHERE id=$2", [newBalance, req.user.id]);

      // 3. Record transaction for the withdrawal hold
      await client.query(`
        INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
        VALUES ($1,'withdrawal_hold',$2,'حجز مبلغ السحب بانتظار مراجعة الأدمن',$3,$4)
      `, [req.user.id, -amount, balance, balance - amount]);

      // 4. Record transaction for the permanent deletion of the $5 locked bonus portion
      await client.query(`
        INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
        VALUES ($1,'bonus_settlement',-5.00,'إلغاء 50% من البونص الترحيبي عند أول عملية سحب',$2,$3)
      `, [req.user.id, balance - amount, newBalance]);

    } else {
      // Normal withdrawal flow
      await client.query("UPDATE users SET balance=balance-$1 WHERE id=$2", [amount, req.user.id]);
      await client.query(`
        INSERT INTO withdrawals (user_id, amount, coin, wallet_address)
        VALUES ($1,$2,$3,$4)
      `, [req.user.id, amount, coin, wallet]);
      await client.query(`
        INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
        VALUES ($1,'withdrawal_hold',$2,'حجز مبلغ السحب بانتظار مراجعة الأدمن',$3,$4)
      `, [req.user.id, -amount, balance, balance - amount]);
    }

    await client.query("COMMIT");
    res.status(201).json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Withdrawal request failed." });
  } finally {
    client.release();
  }
});



app.get("/api/user/summary", auth, async (req, res) => {
  const [txDaily, withdrawals, deposits, packages] = await Promise.all([
    query(`
      SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(amount),0)::numeric AS total
      FROM transactions
      WHERE user_id=$1 AND created_at > NOW() - interval '30 days'
      GROUP BY created_at::date
      ORDER BY day
    `, [req.user.id]),
    query("SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS total FROM withdrawals WHERE user_id=$1 GROUP BY status", [req.user.id]),
    query("SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS total FROM deposits WHERE user_id=$1 GROUP BY status", [req.user.id]),
    query("SELECT status, COUNT(*)::int AS count FROM user_packages WHERE user_id=$1 GROUP BY status", [req.user.id])
  ]);
  res.json({
    tx_daily: txDaily.rows.map(r => ({ ...r, total: Number(r.total) })),
    withdrawals: withdrawals.rows.map(r => ({ ...r, total: Number(r.total) })),
    deposits: deposits.rows.map(r => ({ ...r, total: Number(r.total) })),
    packages: packages.rows
  });
});

app.get("/api/admin/reports", auth, adminOnly, async (_req, res) => {
  const [dailyUsers, dailyDeposits, dailyWithdrawals, kycStatuses, packageStatuses] = await Promise.all([
    query(`
      SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
      FROM users
      WHERE role='user' AND created_at > NOW() - interval '30 days'
      GROUP BY created_at::date
      ORDER BY day
    `),
    query(`
      SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS count
      FROM deposits
      WHERE created_at > NOW() - interval '30 days'
      GROUP BY created_at::date
      ORDER BY day
    `),
    query(`
      SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS count
      FROM withdrawals
      WHERE created_at > NOW() - interval '30 days'
      GROUP BY created_at::date
      ORDER BY day
    `),
    query("SELECT kyc_status AS status, COUNT(*)::int AS count FROM users WHERE role='user' GROUP BY kyc_status"),
    query("SELECT status, COUNT(*)::int AS count FROM user_packages GROUP BY status")
  ]);
  res.json({
    daily_users: dailyUsers.rows,
    daily_deposits: dailyDeposits.rows.map(r => ({ ...r, total: Number(r.total) })),
    daily_withdrawals: dailyWithdrawals.rows.map(r => ({ ...r, total: Number(r.total) })),
    kyc_statuses: kycStatuses.rows,
    package_statuses: packageStatuses.rows
  });
});

app.get("/api/admin/export/users.csv", auth, adminOnly, async (_req, res) => {
  const result = await query("SELECT id, username, email, phone, balance, package_balance, package_profit, kyc_status, bonus_claimed, status, created_at FROM users ORDER BY id DESC");
  const headers = ["id","username","email","phone","balance","package_balance","package_profit","kyc_status","bonus_claimed","status","created_at"];
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.join(","), ...result.rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=taskora-users.csv");
  res.send(csv);
});



app.get("/api/support/tickets", auth, async (req, res) => {
  const result = await query("SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY id DESC", [req.user.id]);
  res.json({ tickets: result.rows });
});

app.post("/api/support/tickets", auth, async (req, res) => {
  const subject = normalize(req.body.subject);
  const category = normalize(req.body.category || "general");
  const message = normalize(req.body.message);
  if (!subject || subject.length < 4) return res.status(422).json({ error: "Subject is required." });
  if (!message || message.length < 10) return res.status(422).json({ error: "Message must be at least 10 characters." });

  const result = await query(`
    INSERT INTO support_tickets (user_id, subject, category, message)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [req.user.id, subject, category, message]);

  await createNotification(pool, req.user.id, "تم إنشاء تذكرة دعم", "تم إرسال تذكرتك إلى فريق الدعم.", "info");

  // Send support email notification safely
  try {
    await emailService.sendSupportTicketNotificationEmail(req.user.username, req.user.email, subject, category, message);
  } catch (emailErr) {
    console.error("[Support Ticket Email Notification Error]:", emailErr);
  }

  res.status(201).json({ ticket: result.rows[0] });
});

app.get("/api/admin/support/tickets", auth, adminOnly, async (_req, res) => {
  const result = await query(`
    SELECT t.*, u.username, u.email
    FROM support_tickets t
    JOIN users u ON u.id=t.user_id
    ORDER BY t.id DESC
  `);
  res.json({ tickets: result.rows });
});

app.post("/api/admin/support/tickets/:id/reply", auth, adminOnly, async (req, res) => {
  const reply = normalize(req.body.reply);
  const status = normalize(req.body.status || "answered");
  if (!reply || reply.length < 2) return res.status(422).json({ error: "Reply is required." });
  if (!["open","answered","closed"].includes(status)) return res.status(422).json({ error: "Invalid ticket status." });

  const ticketRes = await query("SELECT user_id, subject FROM support_tickets WHERE id=$1", [req.params.id]);
  if (ticketRes.rowCount === 0) return res.status(404).json({ error: "Ticket not found." });

  await query(`
    UPDATE support_tickets
    SET admin_reply=$1, status=$2, replied_by=$3, replied_at=NOW()
    WHERE id=$4
  `, [reply, status, req.user.id, req.params.id]);

  await createNotification(pool, ticketRes.rows[0].user_id, "تم الرد على تذكرة الدعم", `تم الرد على تذكرتك: ${ticketRes.rows[0].subject}`, "success");
  await logAdminAction(pool, req.user.id, "reply_support_ticket", "support_ticket", Number(req.params.id), { status });
  res.json({ success: true });
});


app.get("/api/notifications", auth, async (req, res) => {
  const result = await query("SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100", [req.user.id]);
  res.json({ notifications: result.rows });
});

app.post("/api/notifications/read", auth, async (req, res) => {
  await query("UPDATE notifications SET is_read=true WHERE user_id=$1", [req.user.id]);
  res.json({ success: true });
});


app.get("/api/transactions", auth, async (req, res) => {
  const result = await query("SELECT * FROM transactions WHERE user_id=$1 ORDER BY id DESC", [req.user.id]);
  res.json({ transactions: result.rows });
});




app.get("/api/public/avatar/:filename", async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(uploadDir, filename);
    if (!filePath.toLowerCase().startsWith(uploadDir.toLowerCase()) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Avatar file not found." });
    }
    return res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Avatar access failed." });
  }
});

app.get("/api/files/:filename", auth, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(uploadDir, filename);
    if (!filePath.toLowerCase().startsWith(uploadDir.toLowerCase()) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found." });
    }

    if (req.user.role !== "admin") {
      const apiPath = `/api/files/${filename}`;
      const allowed = await query(`
        SELECT id FROM user_kyc WHERE user_id=$1 AND (front_image=$2 OR back_image=$2 OR selfie_image=$2)
        UNION
        SELECT id FROM deposits WHERE user_id=$1 AND proof_image=$2
        LIMIT 1
      `, [req.user.id, apiPath]);
      if (allowed.rowCount === 0) return res.status(403).json({ error: "Forbidden file." });
    }

    return res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "File access failed." });
  }
});

app.get("/api/wallets", async (_req, res) => {
  const result = await query("SELECT coin, address, network FROM wallet_addresses WHERE is_active=true ORDER BY coin");
  const wallets = await Promise.all(result.rows.map(async (w) => ({
    ...w,
    qr: await QRCode.toDataURL(w.address || `${w.coin}:${w.network || ""}`)
  })));
  res.json({ wallets });
});

/* Admin */

app.get("/api/admin/diagnose-files", auth, adminOnly, async (req, res) => {
  try {
    const kyc = await query("SELECT id, user_id, front_image, back_image, selfie_image FROM user_kyc");
    const deposits = await query("SELECT id, user_id, proof_image FROM deposits");
    const results = [];
    
    for (const row of kyc.rows) {
      if (row.front_image) {
        const frontName = path.basename(row.front_image);
        const frontPath = path.join(uploadDir, frontName);
        results.push({
          type: 'kyc_front',
          id: row.id,
          user_id: row.user_id,
          db_value: row.front_image,
          resolved_path: frontPath,
          exists: fs.existsSync(frontPath)
        });
      }
      if (row.back_image) {
        const backName = path.basename(row.back_image);
        const backPath = path.join(uploadDir, backName);
        results.push({
          type: 'kyc_back',
          id: row.id,
          user_id: row.user_id,
          db_value: row.back_image,
          resolved_path: backPath,
          exists: fs.existsSync(backPath)
        });
      }
    }

    for (const row of deposits.rows) {
      if (row.proof_image) {
        const proofName = path.basename(row.proof_image);
        const proofPath = path.join(uploadDir, proofName);
        results.push({
          type: 'deposit_proof',
          id: row.id,
          user_id: row.user_id,
          db_value: row.proof_image,
          resolved_path: proofPath,
          exists: fs.existsSync(proofPath)
        });
      }
    }

    res.json({
      upload_dir: uploadDir,
      upload_dir_exists: fs.existsSync(uploadDir),
      total_checked: results.length,
      files: results
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/stats", auth, adminOnly, async (_req, res) => {
  const [users, pendingKyc, pendingDeposits, pendingWithdrawals, balances, deposits, withdrawals] = await Promise.all([
    query("SELECT COUNT(*)::int AS count FROM users WHERE role='user'"),
    query("SELECT COUNT(*)::int AS count FROM user_kyc WHERE status='pending'"),
    query("SELECT COUNT(*)::int AS count FROM deposits WHERE status='pending'"),
    query("SELECT COUNT(*)::int AS count FROM withdrawals WHERE status='pending'"),
    query("SELECT COALESCE(SUM(balance),0)::numeric AS total FROM users"),
    query("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM deposits WHERE status='approved'"),
    query("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM withdrawals WHERE status='approved'")
  ]);
  res.json({ stats: {
    users: users.rows[0].count,
    pending_kyc: pendingKyc.rows[0].count,
    pending_deposits: pendingDeposits.rows[0].count,
    pending_withdrawals: pendingWithdrawals.rows[0].count,
    total_user_balances: Number(balances.rows[0].total),
    approved_deposits: Number(deposits.rows[0].total),
    approved_withdrawals: Number(withdrawals.rows[0].total)
  }});
});

app.get("/api/admin/wallets", auth, adminOnly, async (_req, res) => {
  const result = await query("SELECT * FROM wallet_addresses ORDER BY coin");
  res.json({ wallets: result.rows });
});

app.post("/api/admin/wallets", auth, adminOnly, async (req, res) => {
  const coin = lower(req.body.coin);
  const address = normalize(req.body.address);
  const network = normalize(req.body.network);
  if (!["usdt_trc20","usdt_erc20","btc","sol"].includes(coin)) return res.status(422).json({ error: "Invalid coin." });
  if (!address || address.length < 6) return res.status(422).json({ error: "Wallet address is required." });
  const result = await query(`
    INSERT INTO wallet_addresses (coin, address, network, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (coin)
    DO UPDATE SET address=EXCLUDED.address, network=EXCLUDED.network, updated_at=NOW()
    RETURNING *
  `, [coin, address, network]);
  res.json({ wallet: result.rows[0] });
});

app.delete("/api/admin/wallets/:coin", auth, adminOnly, async (req, res) => {
  try {
    const coin = lower(req.params.coin);
    await query("DELETE FROM wallet_addresses WHERE coin=$1", [coin]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete wallet." });
  }
});



app.get("/api/admin/users/:id/detail", auth, adminOnly, async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) return res.status(422).json({ error: "Invalid user." });

  const [user, kyc, deposits, withdrawals, packages, transactions, adjustments, golden, notes, loginActivity] = await Promise.all([
    query("SELECT id,username,email,phone,role,balance,package_balance,package_profit,referral_code,kyc_status,bonus_claimed,status,created_at FROM users WHERE id=$1", [userId]),
    query("SELECT id,document_type,full_name,document_number,front_image,back_image,selfie_image,status,admin_note,reviewed_at,created_at FROM user_kyc WHERE user_id=$1 ORDER BY id DESC", [userId]),
    query("SELECT * FROM deposits WHERE user_id=$1 ORDER BY id DESC", [userId]),
    query("SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC", [userId]),
    query("SELECT * FROM user_packages WHERE user_id=$1 ORDER BY id DESC", [userId]),
    query("SELECT * FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 100", [userId]),
    query("SELECT * FROM admin_balance_adjustments WHERE user_id=$1 ORDER BY id DESC LIMIT 100", [userId]),
    query("SELECT * FROM golden_tasks WHERE user_id=$1 ORDER BY id DESC", [userId]),
    query("SELECT n.*, a.username AS admin_username FROM admin_user_notes n LEFT JOIN users a ON a.id=n.admin_id WHERE n.user_id=$1 ORDER BY n.id DESC LIMIT 100", [userId]),
    query("SELECT * FROM login_activity WHERE user_id=$1 ORDER BY id DESC LIMIT 50", [userId])
  ]);

  if (user.rowCount === 0) return res.status(404).json({ error: "User not found." });
  res.json({
    user: user.rows[0],
    kyc: kyc.rows,
    deposits: deposits.rows,
    withdrawals: withdrawals.rows,
    packages: packages.rows,
    transactions: transactions.rows,
    adjustments: adjustments.rows,
    golden_tasks: golden.rows,
    notes: notes.rows,
    login_activity: loginActivity.rows
  });
});



app.post("/api/admin/users/:id/notes", auth, adminOnly, async (req, res) => {
  const userId = Number(req.params.id);
  const note = normalize(req.body.note);
  if (!userId) return res.status(422).json({ error: "Invalid user." });
  if (!note || note.length < 2) return res.status(422).json({ error: "Note is required." });

  const exists = await query("SELECT id FROM users WHERE id=$1 AND role!='admin'", [userId]);
  if (exists.rowCount === 0) return res.status(404).json({ error: "User not found." });

  const result = await query(`
    INSERT INTO admin_user_notes (user_id, admin_id, note)
    VALUES ($1,$2,$3)
    RETURNING *
  `, [userId, req.user.id, note]);

  await logAdminAction(pool, req.user.id, "add_admin_note", "user", userId, { note });
  res.status(201).json({ note: result.rows[0] });
});

app.get("/api/account/status", auth, async (req, res) => {
  const pkg = await query("SELECT * FROM user_packages WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [req.user.id]);
  const pendingWithdrawals = await query("SELECT COUNT(*)::int AS count FROM withdrawals WHERE user_id=$1 AND status='pending'", [req.user.id]);
  const approvedDeposits = await query("SELECT COUNT(*)::int AS count FROM deposits WHERE user_id=$1 AND status='approved'", [req.user.id]);
  const completedPackages = await query("SELECT COUNT(*)::int AS count FROM user_packages WHERE user_id=$1 AND status='completed'", [req.user.id]);
  const completedTasks = await query("SELECT COALESCE(SUM(completed_count),0)::int AS count FROM user_packages WHERE user_id=$1", [req.user.id]);
  const referrals = await query("SELECT COUNT(*)::int AS count FROM users WHERE referred_by=$1", [req.user.id]);

  const activePackage = pkg.rows[0] || null;
  const checks = [
    { key: "email", label: "البريد مؤكد", ok: !!req.user.email_verified },
    { key: "kyc", label: "الحساب موثق", ok: req.user.kyc_status === "verified" },
    { key: "package", label: "الباقة نشطة أو مكتملة", ok: !!activePackage },
    { key: "withdrawals", label: "لا توجد سحوبات معلقة", ok: pendingWithdrawals.rows[0].count === 0 },
    { key: "status", label: "الحساب غير محظور", ok: req.user.status === "active" }
  ];

  const missing = [];
  if (!req.user.email_verified) missing.push("أكد بريدك الإلكتروني");
  if (req.user.kyc_status !== "verified") missing.push("أكمل توثيق الحساب");
  if (!activePackage) missing.push("اختر باقة مناسبة");
  if (activePackage && Number(activePackage.completed_count || 0) < 12) missing.push("أكمل مهام الباقة");
  if (Number(req.user.balance || 0) <= 0) missing.push("اجعل لديك رصيد متاح قبل السحب");

  const completedTasksCount = Number(completedTasks.rows[0].count || 0);
  const completedPackagesCount = Number(completedPackages.rows[0].count || 0);
  const approvedDepositsCount = Number(approvedDeposits.rows[0].count || 0);
  const referralCount = Number(referrals.rows[0].count || 0);
  const score = completedTasksCount + completedPackagesCount * 12 + approvedDepositsCount * 8 + referralCount * 4;

  let level = "Beginner";
  if (score >= 160) level = "VIP";
  else if (score >= 95) level = "Elite";
  else if (score >= 50) level = "Pro";
  else if (score >= 15) level = "Active";

  res.json({
    checks,
    missing,
    level,
    score,
    stats: {
      completed_tasks: completedTasksCount,
      completed_packages: completedPackagesCount,
      approved_deposits: approvedDepositsCount,
      referral_count: referralCount
    }
  });
});

app.get("/api/referrals", auth, async (req, res) => {
  const invited = await query(`
    SELECT u.id, u.username, u.email, u.created_at,
      COALESCE((SELECT SUM(amount) FROM deposits d WHERE d.user_id=u.id AND d.status='approved'),0)::numeric AS approved_deposits
    FROM users u
    WHERE u.referred_by=$1
    ORDER BY u.id DESC
  `, [req.user.id]);

  const bonus = await query(`
    SELECT COALESCE(SUM(amount),0)::numeric AS total
    FROM transactions
    WHERE user_id=$1 AND type LIKE '%referral%'
  `, [req.user.id]);

  res.json({
    referral_code: req.user.referral_code,
    invited: invited.rows.map(r => ({ ...r, approved_deposits: Number(r.approved_deposits) })),
    total_bonus: Number(bonus.rows[0].total || 0)
  });
});


app.post("/api/admin/users/:id/balance", auth, adminOnly, async (req, res) => {
  const userId = Number(req.params.id);
  const field = normalize(req.body.field || "balance");
  const action = normalize(req.body.action || "add");
  const amount = Number(req.body.amount);
  const note = normalize(req.body.note || "تعديل رصيد من الأدمن");

  if (!userId) return res.status(422).json({ error: "Invalid user." });
  if (!["balance", "package_balance", "package_profit"].includes(field)) {
    return res.status(422).json({ error: "Invalid balance field." });
  }
  if (!["add", "subtract", "set"].includes(action)) {
    return res.status(422).json({ error: "Invalid action." });
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(422).json({ error: "Invalid amount." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query(`SELECT id, username, role, ${field} AS value FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User not found." });
    }
    if (userRes.rows[0].role === "admin") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Cannot modify admin balance from this panel." });
    }

    const before = Number(userRes.rows[0].value || 0);
    let after = before;
    if (action === "add") after = before + amount;
    if (action === "subtract") after = Math.max(0, before - amount);
    if (action === "set") after = amount;

    await client.query(`UPDATE users SET ${field}=$1 WHERE id=$2`, [after, userId]);
    await createNotification(client, userId, "تعديل رصيد", `تم تعديل ${field}. القيمة السابقة: ${before}، القيمة الجديدة: ${after}.`, "info");
    await logAdminAction(client, req.user.id, "balance_adjustment", "user", userId, { field, action, amount, before, after, note });
    await client.query(`
      INSERT INTO admin_balance_adjustments (admin_id, user_id, field, action, amount, balance_before, balance_after, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [req.user.id, userId, field, action, amount, before, after, note]);

    if (field === "balance") {
      await client.query(`
        INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
        VALUES ($1,'admin_balance_adjustment',$2,$3,$4,$5)
      `, [userId, after - before, note, before, after]);
    }

    await client.query("COMMIT");
    res.json({ success: true, before, after });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Balance update failed." });
  } finally {
    client.release();
  }
});

app.post("/api/admin/users/:id/status", auth, adminOnly, async (req, res) => {
  const status = normalize(req.body.status);
  if (!["active", "blocked"].includes(status)) return res.status(422).json({ error: "Invalid status." });
  await query("UPDATE users SET status=$1 WHERE id=$2 AND role!='admin'", [status, req.params.id]);
  res.json({ success: true });
});

app.get("/api/admin/balance-adjustments", auth, adminOnly, async (_req, res) => {
  const result = await query(`
    SELECT a.*, u.username, u.email, admin.username AS admin_username
    FROM admin_balance_adjustments a
    JOIN users u ON u.id=a.user_id
    LEFT JOIN users admin ON admin.id=a.admin_id
    ORDER BY a.id DESC
    LIMIT 300
  `);
  res.json({ adjustments: result.rows });
});



app.get("/api/admin/audit-logs", auth, adminOnly, async (_req, res) => {
  const result = await query(`
    SELECT l.*, u.username AS admin_username
    FROM admin_audit_logs l
    LEFT JOIN users u ON u.id=l.admin_id
    ORDER BY l.id DESC
    LIMIT 300
  `);
  res.json({ logs: result.rows });
});


app.get("/api/admin/transactions", auth, adminOnly, async (_req, res) => {
  const result = await query(`
    SELECT t.*, u.username, u.email
    FROM transactions t JOIN users u ON u.id=t.user_id
    ORDER BY t.id DESC
    LIMIT 300
  `);
  res.json({ transactions: result.rows });
});

app.get("/api/admin/users", auth, adminOnly, async (_req, res) => {
  const result = await query("SELECT id,username,email,phone,role,balance,package_balance,package_profit,kyc_status,bonus_claimed,status,created_at FROM users ORDER BY id DESC");
  res.json({ users: result.rows });
});

app.delete("/api/admin/users/all", auth, adminOnly, async (req, res) => {
  try {
    // 1. Clear referral references for non-admins to prevent foreign key issues
    await query("UPDATE users SET referred_by = NULL WHERE role != 'admin'");

    // 2. Safely delete all non-admin users (all child rows will cascade delete)
    const deleteRes = await query("DELETE FROM users WHERE role != 'admin'");

    // 3. Log this major administrative action
    await logAdminAction(pool, req.user.id, "delete_all_users", "users", null, {
      deleted_count: deleteRes.rowCount,
      deleted_by_username: req.user.username
    });

    res.json({ 
      success: true, 
      message: `تم حذف ${deleteRes.rowCount} مستخدم بنجاح (باستثناء حسابات الأدمن).` 
    });
  } catch (err) {
    console.error("Error deleting all users:", err);
    res.status(500).json({ error: "فشل حذف المستخدمين من قاعدة البيانات." });
  }
});

app.delete("/api/admin/users/:id", auth, adminOnly, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Check if the user is an admin to prevent deleting administrators
    const checkRes = await query("SELECT role, username FROM users WHERE id=$1", [userId]);
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: "المستخدم غير موجود." });
    }
    if (checkRes.rows[0].role === "admin") {
      return res.status(403).json({ error: "لا يمكن حذف حسابات المسؤولين (الأدمن)." });
    }

    // 1. Clear referral references where this user is the referrer to prevent FK issues
    await query("UPDATE users SET referred_by = NULL WHERE referred_by = $1", [userId]);

    // 2. Perform cascading deletion of the user
    await query("DELETE FROM users WHERE id=$1", [userId]);

    // 3. Log the administrative action
    await logAdminAction(pool, req.user.id, "delete_user", "users", userId, {
      deleted_username: checkRes.rows[0].username,
      deleted_by_username: req.user.username
    });

    res.json({ success: true, message: `تم حذف حساب المستخدم ${checkRes.rows[0].username} بنجاح.` });
  } catch (err) {
    console.error("Error deleting individual user:", err);
    res.status(500).json({ error: "فشل حذف حساب المستخدم من قاعدة البيانات." });
  }
});

app.get("/api/admin/support-emails", auth, adminOnly, async (_req, res) => {
  try {
    const result = await query("SELECT * FROM support_emails ORDER BY id DESC LIMIT 500");
    res.json({ emails: result.rows });
  } catch (err) {
    console.error("Error fetching support emails:", err);
    res.status(500).json({ error: "فشل تحميل الرسائل الواردة." });
  }
});

app.delete("/api/admin/support-emails/:id", auth, adminOnly, async (req, res) => {
  try {
    await query("DELETE FROM support_emails WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "تم حذف الرسالة بنجاح." });
  } catch (err) {
    console.error("Error deleting support email:", err);
    res.status(500).json({ error: "فشل حذف الرسالة." });
  }
});

app.post("/api/support/incoming-email", async (req, res) => {
  try {
    const fromVal = req.body.from || req.body.sender_email || req.body.sender || "";
    const nameVal = req.body.name || req.body.sender_name || "";
    const subjectVal = req.body.subject || "بدون عنوان";
    const messageVal = req.body.message || req.body.text || req.body.html || "";

    let email = String(fromVal).trim();
    let name = String(nameVal).trim();
    const emailMatch = email.match(/([^<]+)<([^>]+)>/);
    if (emailMatch) {
      name = name || emailMatch[1].trim();
      email = emailMatch[2].trim();
    }

    if (!email) {
      return res.status(422).json({ error: "البريد الإلكتروني للمرسل مطلوب." });
    }
    if (!messageVal) {
      return res.status(422).json({ error: "نص الرسالة مطلوب." });
    }

    await query(`
      INSERT INTO support_emails (sender_email, sender_name, subject, message)
      VALUES ($1, $2, $3, $4)
    `, [email, name || null, subjectVal, messageVal]);

    res.json({ success: true, message: "تم استقبال الرسالة وحفظها بنجاح." });
  } catch (err) {
    console.error("Error receiving incoming email:", err);
    res.status(500).json({ error: "فشل حفظ الرسالة الواردة." });
  }
});

app.get("/api/admin/kyc", auth, adminOnly, async (_req, res) => {
  const result = await query(`
    SELECT k.*, u.username, u.email, u.phone
    FROM user_kyc k JOIN users u ON u.id=k.user_id
    ORDER BY k.id DESC
  `);
  res.json({ kyc: result.rows });
});

app.post("/api/admin/kyc/:id/approve", auth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const kycRes = await client.query(`
      SELECT k.*, u.username, u.email
      FROM user_kyc k
      JOIN users u ON u.id = k.user_id
      WHERE k.id = $1 FOR UPDATE
    `, [req.params.id]);

    if (kycRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "KYC not found." });
    }
    const kyc = kycRes.rows[0];

    await createNotification(client, kyc.user_id, "تم قبول التوثيق", "تم قبول توثيق حسابك. يمكنك الآن استخدام السحب عند توفر الرصيد.", "success");
    await logAdminAction(client, req.user.id, "approve_kyc", "kyc", kyc.id, { user_id: kyc.user_id });
    await client.query("UPDATE user_kyc SET status='verified', reviewed_by=$1, reviewed_at=NOW(), admin_note=$2 WHERE id=$3", [req.user.id, normalize(req.body.note), kyc.id]);
    await client.query("UPDATE users SET kyc_status='verified' WHERE id=$1", [kyc.user_id]);

    const bonusExists = await client.query("SELECT id FROM welcome_bonuses WHERE document_hash=$1 LIMIT 1", [kyc.document_hash]);
    const userRes = await client.query("SELECT username, email, bonus_claimed FROM users WHERE id=$1 FOR UPDATE", [kyc.user_id]);
    if (bonusExists.rowCount === 0 && !userRes.rows[0].bonus_claimed) {
      await client.query("INSERT INTO welcome_bonuses (user_id, document_hash, amount, status) VALUES ($1,$2,10,'active')", [kyc.user_id, kyc.document_hash]);
      await addTransaction(client, kyc.user_id, "welcome_bonus", 10, "بونص ترحيبي بعد قبول التوثيق");
      await client.query("UPDATE users SET bonus_claimed=true WHERE id=$1", [kyc.user_id]);
    }

    await client.query("COMMIT");

    // Send KYC Approved Email via Resend safely
    try {
      await emailService.sendKYCStatusEmail(kyc.email, kyc.username, true);
    } catch (emailErr) {
      console.error("[KYC Approval Email Error]:", emailErr);
    }

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "KYC approval failed." });
  } finally {
    client.release();
  }
});

app.post("/api/admin/kyc/:id/reject", auth, adminOnly, async (req, res) => {
  const kycRes = await query(`
    SELECT k.*, u.username, u.email
    FROM user_kyc k
    JOIN users u ON u.id = k.user_id
    WHERE k.id = $1
  `, [req.params.id]);

  if (kycRes.rowCount === 0) return res.status(404).json({ error: "KYC not found." });
  const kyc = kycRes.rows[0];

  const note = normalize(req.body.note);

  await createNotification(pool, kyc.user_id, "تم رفض التوثيق", note || "تم رفض التوثيق. يمكنك إعادة المحاولة بملفات أوضح.", "error");
  await logAdminAction(pool, req.user.id, "reject_kyc", "kyc", Number(req.params.id), { note });
  await query("UPDATE user_kyc SET status='rejected', reviewed_by=$1, reviewed_at=NOW(), admin_note=$2 WHERE id=$3", [req.user.id, note, req.params.id]);
  await query("UPDATE users SET kyc_status='rejected' WHERE id=$1", [kyc.user_id]);

  // Send KYC Rejected Email via Resend safely
  try {
    await emailService.sendKYCStatusEmail(kyc.email, kyc.username, false, note);
  } catch (emailErr) {
    console.error("[KYC Rejection Email Error]:", emailErr);
  }

  res.json({ success: true });
});

app.get("/api/admin/deposits", auth, adminOnly, async (_req, res) => {
  const result = await query(`
    SELECT d.*, u.username, u.email
    FROM deposits d JOIN users u ON u.id=d.user_id
    ORDER BY d.id DESC
  `);
  res.json({ deposits: result.rows });
});

app.post("/api/admin/deposits/:id/approve", auth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const depRes = await client.query("SELECT * FROM deposits WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (depRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deposit not found." });
    }
    const dep = depRes.rows[0];
    if (dep.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Deposit already reviewed." });
    }
    await createNotification(client, dep.user_id, "تم قبول الإيداع", `تم قبول إيداعك بقيمة ${dep.amount} ${String(dep.coin).toUpperCase()}.`, "success");
    await logAdminAction(client, req.user.id, "approve_deposit", "deposit", dep.id, { amount: dep.amount, coin: dep.coin });
    await client.query("UPDATE deposits SET status='approved', reviewed_by=$1, reviewed_at=NOW(), admin_note=$2 WHERE id=$3", [req.user.id, normalize(req.body.note), dep.id]);
    await addTransaction(client, dep.user_id, "deposit", Number(dep.amount), `إيداع مقبول ${String(dep.coin).toUpperCase()}`);

    // Referral 5% Commission logic
    const userRes = await client.query("SELECT username, referred_by FROM users WHERE id=$1", [dep.user_id]);
    if (userRes.rowCount > 0 && userRes.rows[0].referred_by) {
      const referrerId = userRes.rows[0].referred_by;
      const commission = Number((Number(dep.amount) * 0.05).toFixed(2));
      if (commission > 0) {
        // Credit the referrer with 5% commission of this deposit
        await addTransaction(client, referrerId, "referral_bonus", commission, `عمولة إحالة 5% من إيداع ${userRes.rows[0].username} بقيمة ${dep.amount}`);
        
        // Notify the referrer
        await createNotification(client, referrerId, "عمولة إحالة جديدة 🎁", `لقد حصلت على عمولة إحالة بقيمة $${commission.toFixed(2)} (5%) من إيداع صديقك ${userRes.rows[0].username}.`, "success");
      }
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Deposit approval failed." });
  } finally {
    client.release();
  }
});

app.post("/api/admin/deposits/:id/reject", auth, adminOnly, async (req, res) => {
  const depReject = await query("SELECT user_id, amount, coin FROM deposits WHERE id=$1", [req.params.id]);
  if (depReject.rowCount) await createNotification(pool, depReject.rows[0].user_id, "تم رفض الإيداع", normalize(req.body.note) || "تم رفض طلب الإيداع. يرجى مراجعة السبب أو التواصل مع الدعم.", "error");
  await logAdminAction(pool, req.user.id, "reject_deposit", "deposit", Number(req.params.id), { note: normalize(req.body.note) });
  await query("UPDATE deposits SET status='rejected', reviewed_by=$1, reviewed_at=NOW(), admin_note=$2 WHERE id=$3 AND status='pending'", [req.user.id, normalize(req.body.note), req.params.id]);
  res.json({ success: true });
});

app.get("/api/admin/withdrawals", auth, adminOnly, async (_req, res) => {
  const result = await query(`
    SELECT w.*, u.username, u.email, u.kyc_status
    FROM withdrawals w JOIN users u ON u.id=w.user_id
    ORDER BY w.id DESC
  `);
  res.json({ withdrawals: result.rows });
});

app.post("/api/admin/withdrawals/:id/approve", auth, adminOnly, async (req, res) => {
  const wdApprove = await query(`
    SELECT w.user_id, w.amount, w.coin, w.wallet_address, u.username, u.email
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    WHERE w.id = $1
  `, [req.params.id]);

  if (wdApprove.rowCount === 0) return res.status(404).json({ error: "Withdrawal not found." });
  const w = wdApprove.rows[0];

  const txid = normalize(req.body.txid);
  const note = normalize(req.body.note);

  await createNotification(pool, w.user_id, "تم قبول السحب", `تم قبول طلب السحب بقيمة ${w.amount} ${String(w.coin).toUpperCase()}.`, "success");
  await logAdminAction(pool, req.user.id, "approve_withdrawal", "withdrawal", Number(req.params.id), { txid, note });
  await query("UPDATE withdrawals SET status='approved', txid=$1, reviewed_by=$2, reviewed_at=NOW(), admin_note=$3 WHERE id=$4 AND status='pending'", [txid, req.user.id, note, req.params.id]);

  // Send Withdrawal Approved Email via Resend safely
  try {
    await emailService.sendWithdrawalStatusEmail(w.email, w.username, true, w.amount, w.coin, w.wallet_address, { txid });
  } catch (emailErr) {
    console.error("[Withdrawal Approval Email Error]:", emailErr);
  }

  res.json({ success: true });
});

app.post("/api/admin/withdrawals/:id/reject", auth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wRes = await client.query(`
      SELECT w.*, u.username, u.email
      FROM withdrawals w
      JOIN users u ON u.id = w.user_id
      WHERE w.id = $1 AND w.status = 'pending' FOR UPDATE
    `, [req.params.id]);

    if (wRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pending withdrawal not found." });
    }
    const w = wRes.rows[0];
    const note = normalize(req.body.note);

    await createNotification(client, w.user_id, "تم رفض السحب", note || "تم رفض طلب السحب وتم إرجاع المبلغ إلى رصيدك.", "error");
    await logAdminAction(client, req.user.id, "reject_withdrawal", "withdrawal", w.id, { amount: w.amount, note });
    await client.query("UPDATE withdrawals SET status='rejected', reviewed_by=$1, reviewed_at=NOW(), admin_note=$2 WHERE id=$3", [req.user.id, note, w.id]);
    await addTransaction(client, w.user_id, "withdrawal_refund", Number(w.amount), "إرجاع مبلغ سحب مرفوض");
    await client.query("COMMIT");

    // Send Withdrawal Rejected Email via Resend safely
    try {
      await emailService.sendWithdrawalStatusEmail(w.email, w.username, false, w.amount, w.coin, w.wallet_address, { reason: note });
    } catch (emailErr) {
      console.error("[Withdrawal Rejection Email Error]:", emailErr);
    }

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Withdrawal rejection failed." });
  } finally {
    client.release();
  }
});


app.get("/api/admin/golden", auth, adminOnly, async (_req, res) => {
  const result = await query(`
    SELECT g.*, u.username, u.email
    FROM golden_tasks g JOIN users u ON u.id=g.user_id
    ORDER BY g.id DESC
  `);
  res.json({ golden_tasks: result.rows });
});

app.post("/api/admin/golden", auth, adminOnly, async (req, res) => {
  const userId = req.body.user_id; // Can be a number, a string "all", or an array of numbers
  const title = normalize(req.body.title || "المهمة الذهبية الأسبوعية");
  const description = normalize(req.body.description || "مهمة ذهبية خاصة مرسلة من الأدمن.");
  const reward = Number(req.body.reward || 10);
  const taskLink = normalize(req.body.task_link || "");
  
  if (!userId || reward <= 0) return res.status(422).json({ error: "Invalid request." });
  
  let targetUserIds = [];
  
  if (userId === "all") {
    // Send to all users except admins!
    const usersRes = await query("SELECT id FROM users WHERE role != 'admin'");
    targetUserIds = usersRes.rows.map(r => r.id);
  } else if (Array.isArray(userId)) {
    targetUserIds = userId.map(Number).filter(id => !isNaN(id));
  } else {
    const singleId = Number(userId);
    if (!isNaN(singleId)) {
      targetUserIds = [singleId];
    }
  }

  if (targetUserIds.length === 0) {
    return res.status(422).json({ error: "No target users found." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const uid of targetUserIds) {
      await createNotification(client, uid, "مهمة خاصة جديدة 🌟", title, "golden");
      await client.query(`
        INSERT INTO golden_tasks (user_id, title, description, reward, sent_by, task_link)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [uid, title, description, reward, req.user.id, taskLink]);
    }
    await logAdminAction(client, req.user.id, "send_golden_task_multiple", "users", null, { title, reward, task_link: taskLink, count: targetUserIds.length });
    await client.query("COMMIT");
    res.status(201).json({ success: true, message: `تم إرسال المهمة لـ ${targetUserIds.length} مستخدم بنجاح.` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "فشل إرسال المهمة الجماعية." });
  } finally {
    client.release();
  }
});

app.post("/api/golden/:id/submit-proof", auth, upload.single("proof_image"), async (req, res) => {
  try {
    const userNote = normalize(req.body.user_note || "");
    const taskId = Number(req.params.id);
    if (!req.file) {
      return res.status(422).json({ error: "صورة الإثبات (لقطة الشاشة) مطلوبة ومهمة للتأكيد." });
    }
    const proofUrl = `/api/files/${req.file.filename}`;
    const result = await query(`
      UPDATE golden_tasks 
      SET status='pending_review', proof_image=$1, user_note=$2, completed_at=NULL
      WHERE id=$3 AND user_id=$4 AND status IN ('active', 'rejected')
      RETURNING *
    `, [proofUrl, userNote, taskId, req.user.id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "المهمة غير صالحة أو تم إرسالها بالفعل." });
    }
    
    res.json({ success: true, golden_task: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "فشل إرسال إثبات المهمة." });
  }
});

app.post("/api/admin/golden/:id/approve", auth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gtRes = await client.query("SELECT * FROM golden_tasks WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (gtRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المهمة الخاصة غير موجودة." });
    }
    const gt = gtRes.rows[0];
    if (gt.status !== "pending_review") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "المهمة ليست قيد المراجعة حاليًا." });
    }
    
    const reward = Number(gt.reward);
    await addTransaction(client, gt.user_id, "golden_task", reward, `أرباح المهمة الخاصة: ${gt.title}`);
    await client.query("UPDATE golden_tasks SET status='completed', completed_at=NOW() WHERE id=$1", [gt.id]);
    await createNotification(client, gt.user_id, "تم قبول إثبات المهمة 🎉", `تم اعتماد إثبات مهمة "${gt.title}" وحصلت على $${reward} كأرباح!`, "success");
    await logAdminAction(client, req.user.id, "approve_golden_task", "golden_task", gt.id, { user_id: gt.user_id, reward });
    
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "فشل قبول المهمة." });
  } finally {
    client.release();
  }
});

app.post("/api/admin/golden/:id/reject", auth, adminOnly, async (req, res) => {
  try {
    const adminNote = normalize(req.body.note || "لم يتم استيفاء شروط المهمة بشكل صحيح.");
    const gtRes = await query("SELECT * FROM golden_tasks WHERE id=$1", [req.params.id]);
    if (gtRes.rowCount === 0) {
      return res.status(404).json({ error: "المهمة غير موجودة." });
    }
    const gt = gtRes.rows[0];
    if (gt.status !== "pending_review") {
      return res.status(409).json({ error: "المهمة ليست قيد المراجعة." });
    }
    
    await query("UPDATE golden_tasks SET status='rejected', admin_note=$1 WHERE id=$2", [adminNote, gt.id]);
    await createNotification(pool, gt.user_id, "تم رفض إثبات المهمة ❌", `تم رفض إثبات مهمة "${gt.title}". السبب: ${adminNote}`, "error");
    await logAdminAction(pool, req.user.id, "reject_golden_task", "golden_task", gt.id, { user_id: gt.user_id, note: adminNote });
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "فشل رفض المهمة." });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err && err.message) return res.status(400).json({ error: err.message });
  return res.status(500).json({ error: "Unexpected server error." });
});




// -----------------------------
// Railway frontend hard fix
// -----------------------------
const publicDir = path.join(__dirname, "public");
const indexFile = path.join(publicDir, "index.html");

app.get("/__debug", (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    cwd: process.cwd(),
    dirname: __dirname,
    publicDir,
    indexFile,
    indexExists: fs.existsSync(indexFile),
    files: fs.existsSync(publicDir) ? fs.readdirSync(publicDir).slice(0, 50) : []
  });
});


// Hard API guard: API routes must never return index.html.
app.use("/api", (req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});


// Do not let static frontend answer API requests.
app.use((req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  next();
});

app.get("/sw.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.type("application/javascript").sendFile(path.join(publicDir, "sw.js"));
});

app.use(express.static(publicDir, {
  index: false,
  fallthrough: true,
  maxAge: "1h"
}));

function sendFrontend(req, res) {
  if (!fs.existsSync(indexFile)) {
    return res.status(500).send("Frontend file missing: public/index.html");
  }
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(indexFile);
}

app.get("/", sendFrontend);
app.get("/index.html", sendFrontend);


// API routes must never return frontend HTML.
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  next();
});


// Final API JSON 404. Must appear before any frontend fallback.
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found",
    path: req.originalUrl,
    version: APP_VERSION
  });
});


// Strong API JSON 404 before SPA fallback.
app.use("/api", (req, res, next) => {
  if (res.headersSent) return next();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(404).json({
    error: "API route not found",
    path: req.originalUrl,
    version: APP_VERSION
  });
});


// ABSOLUTE_API_JSON_FINAL_404
app.use("/api", (req, res) => {
  res.type("application/json").status(404).json({
    error: "API_ROUTE_NOT_FOUND",
    path: req.originalUrl,
    version: APP_VERSION
  });
});

// SPA fallback: serve frontend for all non-API routes.
app.get("*", (req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    return res.type("application/json").status(404).json({
      error: "API_ROUTE_NOT_FOUND",
      path: req.originalUrl,
      version: APP_VERSION
    });
  }
  if (req.path === "/health" || req.path === "/__debug") {
    return next();
  }
  return sendFrontend(req, res);
});

// Final API 404 only.
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
    version: APP_VERSION
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Taskora Real MVP running on ${PORT}`);
  migrate()
    .then(() => {
      migrationStatus = "completed";
      migrationError = null;
      console.log("Database migration completed.");
    })
    .catch((err) => {
      migrationStatus = "failed";
      migrationError = err && err.message ? err.message : String(err);
      console.error("Migration failed:", err);
    });
});
