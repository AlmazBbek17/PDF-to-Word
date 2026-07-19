import pg from 'pg';

const { Pool } = pg;

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : undefined })
  : null;

export async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL not set — auth/billing endpoints will not work until a Postgres DB is attached.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      google_sub TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      pages_limit INTEGER NOT NULL DEFAULT 10,
      pages_used INTEGER NOT NULL DEFAULT 0,
      dodo_customer_id TEXT,
      dodo_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Plan catalog — pages_limit here is what a webhook applies once a plan becomes active.
// FREE_PAGES is the one-time lifetime allotment for brand-new users (not a monthly reset).
export const FREE_PAGES = 10;
export const PLANS = {
  plan_5:  { pages: 50,  priceLabel: '$5 / 50 стр' },
  plan_10: { pages: 120, priceLabel: '$10 / 120 стр' },
  plan_15: { pages: 200, priceLabel: '$15 / 200 стр' },
};

export async function findOrCreateUser({ email, googleSub }) {
  const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  if (existing.rows.length) return existing.rows[0];
  const inserted = await pool.query(
    'INSERT INTO users (email, google_sub, plan, pages_limit, pages_used) VALUES ($1,$2,\'free\',$3,0) RETURNING *',
    [email, googleSub || null, FREE_PAGES]
  );
  return inserted.rows[0];
}

export async function getUserByEmail(email) {
  const res = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return res.rows[0] || null;
}

export async function incrementUsage(email, pages) {
  await pool.query('UPDATE users SET pages_used = pages_used + $2, updated_at = now() WHERE email = $1', [email, pages]);
}

export async function setDodoCustomerId(email, dodoCustomerId) {
  await pool.query('UPDATE users SET dodo_customer_id = $2, updated_at = now() WHERE email = $1', [email, dodoCustomerId]);
}

// Called from the Dodo webhook when a subscription becomes active/renews.
export async function activatePlan({ email, dodoCustomerId, dodoSubscriptionId, planKey }) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error(`Unknown plan key: ${planKey}`);
  await pool.query(
    `UPDATE users SET plan = $2, pages_limit = $3, pages_used = 0, dodo_customer_id = $4, dodo_subscription_id = $5, updated_at = now()
     WHERE email = $1`,
    [email, planKey, plan.pages, dodoCustomerId, dodoSubscriptionId]
  );
}

export async function deactivatePlan(email) {
  await pool.query(
    `UPDATE users SET plan = 'free', pages_limit = $2, pages_used = 0, updated_at = now() WHERE email = $1`,
    [email, FREE_PAGES]
  );
}

export async function findUserByDodoCustomerId(dodoCustomerId) {
  const res = await pool.query('SELECT * FROM users WHERE dodo_customer_id = $1', [dodoCustomerId]);
  return res.rows[0] || null;
}
