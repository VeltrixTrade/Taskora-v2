require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const userRes = await pool.query("SELECT id, username, balance, package_balance, package_profit, kyc_status FROM users WHERE lower(username) = 'mustafa2001'");
    if (userRes.rowCount === 0) {
      console.log("User not found!");
      return;
    }
    const user = userRes.rows[0];
    console.log("=== USER ===");
    console.log(JSON.stringify(user, null, 2));

    const pkgRes = await pool.query("SELECT id, package_name, price, status, completed_count, completed_tasks, started_at FROM user_packages WHERE user_id = $1 ORDER BY id DESC LIMIT 5", [user.id]);
    console.log("=== PACKAGES ===");
    console.log(JSON.stringify(pkgRes.rows, null, 2));

    const tasksRes = await pool.query("SELECT id, title, status, reward, completed_at FROM golden_tasks WHERE user_id = $1 ORDER BY id DESC LIMIT 20", [user.id]);
    console.log("=== GOLDEN TASKS ===");
    console.log(JSON.stringify(tasksRes.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
