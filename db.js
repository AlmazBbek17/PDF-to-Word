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
      email TEXT UNIQUE,
      anon_id TEXT UNIQUE,
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

  // Migration for tables created by an earlier version of this schema (email NOT
  // NULL, no anon_id) — CREATE TABLE IF NOT EXISTS above is a no-op on those, so
  // bring them up to date explicitly. Every statement here is safe to re-run.
  await pool.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS anon_id TEXT;`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_anon_id_key'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_anon_id_key UNIQUE (anon_id);
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'email_or_anon'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT email_or_anon CHECK (email IS NOT NULL OR anon_id IS NOT NULL);
      END IF;
    END $$;
  `);
}

// Plan catalog — pages_limit here is what a webhook applies once a plan becomes active.
// FREE_PAGES is the one-time lifetime allotment for a new anonymous device/browser
// (not a monthly reset) — no sign-in required to use it.
export const FREE_PAGES = 10;
export const PLANS = {
  plan_5:  { pages: 50,  priceLabel: '$5 / 50 стр' },
  plan_10: { pages: 120, priceLabel: '$10 / 120 стр' },
  plan_15: { pages: 200, priceLabel: '$15 / 200 стр' },
};

// The free tier is anonymous — identified by a random ID the extension
// generates once and stores locally, sent as the X-Anonymous-Id header.
export async function findOrCreateAnonUser(anonId) {
  const existing = await pool.query('SELECT * FROM users WHERE anon_id = $1', [anonId]);
  if (existing.rows.length) return existing.rows[0];
  const inserted = await pool.query(
    `INSERT INTO users (anon_id, plan, pages_limit, pages_used) VALUES ($1,'free',$2,0) RETURNING *`,
    [anonId, FREE_PAGES]
  );
  return inserted.rows[0];
}

export async function getUserByEmail(email) {
  const res = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return res.rows[0] || null;
}

// Called on Google sign-in. If the person already used some/all of their
// anonymous free pages, that usage is carried over to their account instead
// of resetting — signing in should never grant a second free allotment.
export async function findOrCreateUserFromGoogle({ email, googleSub, anonId }) {
  let user = await getUserByEmail(email);

  if (!user) {
    let pagesUsedToCarry = 0;
    let anonRow = null;
    if (anonId) {
      const res = await pool.query('SELECT * FROM users WHERE anon_id = $1', [anonId]);
      anonRow = res.rows[0] || null;
      if (anonRow) pagesUsedToCarry = anonRow.pages_used;
    }
    const inserted = await pool.query(
      `INSERT INTO users (email, google_sub, plan, pages_limit, pages_used) VALUES ($1,$2,'free',$3,$4) RETURNING *`,
      [email, googleSub || null, FREE_PAGES, Math.min(pagesUsedToCarry, FREE_PAGES)]
    );
    if (anonRow) await pool.query('DELETE FROM users WHERE id = $1', [anonRow.id]);
    return inserted.rows[0];
  }

  // Existing account signing in again from a browser that also has anonymous usage
  // on this plan (e.g. used some free pages before, signed in later) — merge it in once.
  if (anonId) {
    const res = await pool.query('SELECT * FROM users WHERE anon_id = $1', [anonId]);
    const anonRow = res.rows[0];
    if (anonRow) {
      await pool.query(
        'UPDATE users SET pages_used = LEAST(pages_used + $2, pages_limit), updated_at = now() WHERE id = $1',
        [user.id, anonRow.pages_used]
      );
      await pool.query('DELETE FROM users WHERE id = $1', [anonRow.id]);
      user = await getUserByEmail(email);
    }
  }
  return user;
}

export async function incrementUsageById(id, pages) {
  await pool.query('UPDATE users SET pages_used = pages_used + $2, updated_at = now() WHERE id = $1', [id, pages]);
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
