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

const app = express();
const APP_VERSION = "v10.9-hard-route-fix";
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

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
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
  if (!process.env.RESEND_API_KEY) {
    console.log(`MAIL DEV MODE -> ${to} | ${subject} | ${html}`);
    return { dev: true };
  }

  const from = process.env.MAIL_FROM || "Taskora <noreply@taskora.app>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to, subject, html })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("Email send failed:", text);
    throw new Error("Email provider failed.");
  }
  return response.json().catch(() => ({}));
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
    INSERT INTO wallet_addresses (coin, address, network)
    VALUES
      ('usdt', 'USDT_TRC20_WALLET_ADDRESS_HERE', 'TRC20'),
      ('bnb', 'BNB_BEP20_WALLET_ADDRESS_HERE', 'BEP20'),
      ('eth', 'ETH_ERC20_WALLET_ADDRESS_HERE', 'ERC20'),
      ('btc', 'BTC_WALLET_ADDRESS_HERE', 'BTC')
    ON CONFLICT (coin) DO NOTHING;
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
    );
  `);



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
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
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
  { id: "diamond", name: "الماسية", price: 1000, tasks: 12 }
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
  "محاكاة مراجعة طلب تذكرة رياضية"
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
      const refRes = await query("SELECT id FROM users WHERE referral_code=$1", [referral]);
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
    await sendMail(email, "تأكيد بريد Taskora", `<p>مرحبًا ${username}</p><p>اضغط الرابط لتأكيد بريدك:</p><p><a href="${APP_URL}/api/auth/verify-email/${verificationToken}">تأكيد البريد</a></p>`);
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
  const email = lower(req.body.email);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(422).json({ error: "Valid email is required." });
  }

  const result = await query("SELECT id,email,username FROM users WHERE lower(email)=lower($1) LIMIT 1", [email]);
  // Do not reveal whether the email exists.
  if (result.rowCount === 0) return res.json({ success: true });

  const user = result.rows[0];
  const token = makeToken();
  await query("UPDATE users SET password_reset_token=$1, password_reset_expires=NOW() + interval '30 minutes' WHERE id=$2", [token, user.id]);
  const url = `${APP_URL}/reset-password?token=${token}`;
  await sendMail(user.email, "استعادة كلمة مرور Taskora", `<p>مرحبًا ${user.username}</p><p>اضغط الرابط لتعيين كلمة مرور جديدة. الرابط صالح لمدة 30 دقيقة:</p><p><a href="${url}">استعادة كلمة المرور</a></p>`);
  await createNotification(pool, user.id, "طلب استعادة كلمة المرور", "تم إنشاء رابط استعادة كلمة مرور لحسابك.", "info");
  res.json({ success: true, reset_url: `/reset-password?token=${token}` });
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


app.get("/api/me", auth, async (req, res) => {
  const pkg = await query("SELECT * FROM user_packages WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [req.user.id]);
  const kyc = await query("SELECT id, document_type, full_name, document_number, status, admin_note, created_at, reviewed_at FROM user_kyc WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [req.user.id]);
  const unread = await query("SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1 AND is_read=false", [req.user.id]);
  res.json({ user: publicUser(req.user), package: pkg.rows[0] || null, kyc: kyc.rows[0] || null, unread_notifications: unread.rows[0].count });
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
    notes: notes.rows,
    login_activity: loginActivity.rows
  });
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
    const started = new Date(pkg.started_at).getTime();
    const daysElapsed = Math.max(1, Math.floor((Date.now() - started) / (24 * 60 * 60 * 1000)) + 1);
    const allowedMax = Math.min(12, daysElapsed * 3);

    if (taskNumber > allowedMax) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: `This task is not available yet. You can complete up to task ${allowedMax} today.` });
    }

    const completed = Array.isArray(pkg.completed_tasks) ? pkg.completed_tasks : [];
    if (completed.includes(taskNumber)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Task already completed." });
    }

    const reward = Number(pkg.profit_target) / 12;
    const newCompleted = [...completed, taskNumber].sort((a,b) => a-b);
    const newCount = newCompleted.length;

    if (newCount >= 12) {
      const userRes = await client.query("SELECT balance, package_balance, package_profit FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
      const user = userRes.rows[0];
      const updatedProfit = Number(user.package_profit) + reward;
      const unlocked = Number(user.package_balance) + updatedProfit;
      const before = Number(user.balance);
      const after = before + unlocked;

      await client.query("UPDATE users SET balance=$1, package_balance=0, package_profit=0 WHERE id=$2", [after, req.user.id]);
      await client.query("UPDATE user_packages SET completed_tasks=$1, completed_count=12, status='completed', completed_at=NOW() WHERE id=$2", [JSON.stringify(newCompleted), pkg.id]);
      await client.query(`
        INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
        VALUES ($1,'package_unlocked',$2,'تحويل رصيد الباقة والربح إلى الرصيد المتاح بعد إكمال 12 مهمة',$3,$4)
      `, [req.user.id, unlocked, before, after]);
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

app.post("/api/deposits", auth, upload.single("proof_image"), async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const coin = lower(req.body.coin);
    const txid = normalize(req.body.txid);
    if (!amount || amount <= 0) return res.status(422).json({ error: "Invalid amount." });
  if (amount < MIN_WITHDRAWAL_AMOUNT) return res.status(422).json({ error: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT}.` });
    if (!["usdt", "bnb", "eth", "btc"].includes(coin)) return res.status(422).json({ error: "Invalid coin." });
    if (!txid || txid.length < 4) return res.status(422).json({ error: "TXID is required." });

    const duplicateTx = await query("SELECT id FROM deposits WHERE lower(txid)=lower($1) LIMIT 1", [txid]);
    if (duplicateTx.rowCount > 0) {
      return res.status(409).json({ error: "This TXID has already been submitted." });
    }

    const proof = req.file ? `/api/files/${req.file.filename}` : null;
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
  if (!["usdt", "bnb", "eth", "btc"].includes(coin)) return res.status(422).json({ error: "Invalid coin." });
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
    const userRes = await client.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [req.user.id]);
    const balance = Number(userRes.rows[0].balance);
    if (balance < amount) {
      await client.query("ROLLBACK");
      return res.status(422).json({ error: "Insufficient balance." });
    }
    await client.query("UPDATE users SET balance=balance-$1 WHERE id=$2", [amount, req.user.id]);
    await client.query(`
      INSERT INTO withdrawals (user_id, amount, coin, wallet_address)
      VALUES ($1,$2,$3,$4)
    `, [req.user.id, amount, coin, wallet]);
    await client.query(`
      INSERT INTO transactions (user_id, type, amount, description, balance_before, balance_after)
      VALUES ($1,'withdrawal_hold',$2,'حجز مبلغ السحب بانتظار مراجعة الأدمن',$3,$4)
    `, [req.user.id, -amount, balance, balance - amount]);
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
    const apiPath = `/api/public/avatar/${filename}`;
    const exists = await query("SELECT id FROM users WHERE avatar_url=$1 LIMIT 1", [apiPath]);
    if (exists.rowCount === 0) return res.status(404).json({ error: "Avatar not found." });
    const filePath = path.join(uploadDir, filename);
    if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
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
    if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
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
  if (!["usdt","bnb","eth","btc"].includes(coin)) return res.status(422).json({ error: "Invalid coin." });
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
    const kycRes = await client.query("SELECT * FROM user_kyc WHERE id=$1 FOR UPDATE", [req.params.id]);
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
    const userRes = await client.query("SELECT bonus_claimed FROM users WHERE id=$1 FOR UPDATE", [kyc.user_id]);
    if (bonusExists.rowCount === 0 && !userRes.rows[0].bonus_claimed) {
      await client.query("INSERT INTO welcome_bonuses (user_id, document_hash, amount, status) VALUES ($1,$2,10,'active')", [kyc.user_id, kyc.document_hash]);
      await addTransaction(client, kyc.user_id, "welcome_bonus", 10, "بونص ترحيبي بعد قبول التوثيق");
      await client.query("UPDATE users SET bonus_claimed=true WHERE id=$1", [kyc.user_id]);
    }

    await client.query("COMMIT");
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
  const kycRes = await query("SELECT user_id FROM user_kyc WHERE id=$1", [req.params.id]);
  if (kycRes.rowCount === 0) return res.status(404).json({ error: "KYC not found." });
  await createNotification(pool, kycRes.rows[0].user_id, "تم رفض التوثيق", normalize(req.body.note) || "تم رفض التوثيق. يمكنك إعادة المحاولة بملفات أوضح.", "error");
  await logAdminAction(pool, req.user.id, "reject_kyc", "kyc", Number(req.params.id), { note: normalize(req.body.note) });
  await query("UPDATE user_kyc SET status='rejected', reviewed_by=$1, reviewed_at=NOW(), admin_note=$2 WHERE id=$3", [req.user.id, normalize(req.body.note), req.params.id]);
  await query("UPDATE users SET kyc_status='rejected' WHERE id=$1", [kycRes.rows[0].user_id]);
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
  const wdApprove = await query("SELECT user_id, amount, coin FROM withdrawals WHERE id=$1", [req.params.id]);
  if (wdApprove.rowCount) await createNotification(pool, wdApprove.rows[0].user_id, "تم قبول السحب", `تم قبول طلب السحب بقيمة ${wdApprove.rows[0].amount} ${String(wdApprove.rows[0].coin).toUpperCase()}.`, "success");
  await logAdminAction(pool, req.user.id, "approve_withdrawal", "withdrawal", Number(req.params.id), { txid: normalize(req.body.txid), note: normalize(req.body.note) });
  await query("UPDATE withdrawals SET status='approved', txid=$1, reviewed_by=$2, reviewed_at=NOW(), admin_note=$3 WHERE id=$4 AND status='pending'", [normalize(req.body.txid), req.user.id, normalize(req.body.note), req.params.id]);
  res.json({ success: true });
});

app.post("/api/admin/withdrawals/:id/reject", auth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wRes = await client.query("SELECT * FROM withdrawals WHERE id=$1 AND status='pending' FOR UPDATE", [req.params.id]);
    if (wRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pending withdrawal not found." });
    }
    const w = wRes.rows[0];
    await createNotification(client, w.user_id, "تم رفض السحب", normalize(req.body.note) || "تم رفض طلب السحب وتم إرجاع المبلغ إلى رصيدك.", "error");
    await logAdminAction(client, req.user.id, "reject_withdrawal", "withdrawal", w.id, { amount: w.amount, note: normalize(req.body.note) });
    await client.query("UPDATE withdrawals SET status='rejected', reviewed_by=$1, reviewed_at=NOW(), admin_note=$2 WHERE id=$3", [req.user.id, normalize(req.body.note), w.id]);
    await addTransaction(client, w.user_id, "withdrawal_refund", Number(w.amount), "إرجاع مبلغ سحب مرفوض");
    await client.query("COMMIT");
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
  const userId = Number(req.body.user_id);
  const title = normalize(req.body.title || "المهمة الذهبية الأسبوعية");
  const description = normalize(req.body.description || "مهمة ذهبية خاصة مرسلة من الأدمن.");
  const reward = Number(req.body.reward || 10);
  if (!userId || reward <= 0) return res.status(422).json({ error: "Invalid request." });
  await createNotification(pool, userId, "مهمة ذهبية جديدة", title, "golden");
  await logAdminAction(pool, req.user.id, "send_golden_task", "user", userId, { title, reward });
  const result = await query(`
    INSERT INTO golden_tasks (user_id, title, description, reward, sent_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [userId, title, description, reward, req.user.id]);
  res.status(201).json({ golden_task: result.rows[0] });
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

app.use(express.static(publicDir, {
  index: false,
  fallthrough: true,
  maxAge: "1h"
}));

function sendFrontend(req, res) {
  if (!fs.existsSync(indexFile)) {
    return res.status(500).send("Frontend file missing: public/index.html");
  }
  res.sendFile(indexFile);
}

app.get("/", sendFrontend);
app.get("/index.html", sendFrontend);

// SPA fallback: serve frontend for all non-API routes.
app.get("*", (req, res, next) => {
  if (req.path === "/health" || req.path === "/__debug" || req.path.startsWith("/api/")) {
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
