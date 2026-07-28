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
      fast_limit INTEGER NOT NULL DEFAULT 500,
      fast_used INTEGER NOT NULL DEFAULT 0,
      editable_limit INTEGER NOT NULL DEFAULT 5,
      editable_used INTEGER NOT NULL DEFAULT 0,
      dodo_customer_id TEXT,
      dodo_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migrations — every statement here is safe to re-run, for both brand-new
  // tables and ones created by an earlier schema version.
  await pool.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS anon_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fast_limit INTEGER NOT NULL DEFAULT 500;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fast_used INTEGER NOT NULL DEFAULT 0;`);
  // editable_* replaces the older precise_*/scan_* split (two separate modes
  // merged into one "will this be real editable text, yes or no" choice).
  // Old columns (if present from an earlier schema) are left in place rather
  // than dropped — no data-loss risk from a DROP, they're just unused now.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS editable_limit INTEGER NOT NULL DEFAULT 5;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS editable_used INTEGER NOT NULL DEFAULT 0;`);
  // Best-effort carry-over from the older precise+scan schema, if present,
  // so nobody's existing usage history is silently lost by the merge.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='precise_used')
         AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='scan_used') THEN
        UPDATE users
        SET editable_used = precise_used + scan_used,
            editable_limit = GREATEST(precise_limit + scan_limit, 5)
        WHERE editable_used = 0 AND (precise_used > 0 OR scan_used > 0);
      END IF;
    END $$;
  `);
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

// Free tier (no sign-in): a real cap on Non-editable (cheap for us, but not
// literally infinite) and a small trial allotment of genuinely editable pages.
export const FREE_FAST = 500;
export const FREE_EDITABLE = 5;

// Launch prices — matching real prices actually charged from day one, so any
// later strikethrough discount is a legitimate former price, not a fabricated one.
// "fast" (Non-editable) uses a large-but-finite number rather than a special
// "unlimited" value, so quota checks use the same comparison logic everywhere.
const UNLIMITED_FAST = 1_000_000;
export const PLANS = {
  plan_20:  { fast: UNLIMITED_FAST, editable: 130,  priceLabel: '$20 / mo' },  // = the old 100 precise + 30 scan, same deal
  plan_120: { fast: UNLIMITED_FAST, editable: 1200, priceLabel: '$120 / mo' }, // = the old 1000 precise + 200 scan, same deal
};

// The free tier is anonymous — identified by a random ID the extension
// generates once and stores locally, sent as the X-Anonymous-Id header.
export async function findOrCreateAnonUser(anonId) {
  const existing = await pool.query('SELECT * FROM users WHERE anon_id = $1', [anonId]);
  if (existing.rows.length) return existing.rows[0];
  const inserted = await pool.query(
    `INSERT INTO users (anon_id, plan, fast_limit, editable_limit) VALUES ($1,'free',$2,$3) RETURNING *`,
    [anonId, FREE_FAST, FREE_EDITABLE]
  );
  return inserted.rows[0];
}

export async function getUserByEmail(email) {
  const res = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return res.rows[0] || null;
}

// Called on Google sign-in. If the person already used some of their
// anonymous free trial pages, that usage carries over instead of resetting —
// signing in should never grant a second free allotment.
export async function findOrCreateUserFromGoogle({ email, googleSub, anonId }) {
  let user = await getUserByEmail(email);

  if (!user) {
    let fastUsedToCarry = 0, editableUsedToCarry = 0;
    let anonRow = null;
    if (anonId) {
      const res = await pool.query('SELECT * FROM users WHERE anon_id = $1', [anonId]);
      anonRow = res.rows[0] || null;
      if (anonRow) {
        fastUsedToCarry = anonRow.fast_used;
        editableUsedToCarry = anonRow.editable_used;
      }
    }
    const inserted = await pool.query(
      `INSERT INTO users (email, google_sub, plan, fast_limit, fast_used, editable_limit, editable_used)
       VALUES ($1,$2,'free',$3,$4,$5,$6) RETURNING *`,
      [email, googleSub || null, FREE_FAST, Math.min(fastUsedToCarry, FREE_FAST),
       FREE_EDITABLE, Math.min(editableUsedToCarry, FREE_EDITABLE)]
    );
    if (anonRow) await pool.query('DELETE FROM users WHERE id = $1', [anonRow.id]);
    return inserted.rows[0];
  }

  if (anonId) {
    const res = await pool.query('SELECT * FROM users WHERE anon_id = $1', [anonId]);
    const anonRow = res.rows[0];
    if (anonRow) {
      await pool.query(
        `UPDATE users SET
           fast_used = LEAST(fast_used + $2, fast_limit),
           editable_used = LEAST(editable_used + $3, editable_limit),
           updated_at = now()
         WHERE id = $1`,
        [user.id, anonRow.fast_used, anonRow.editable_used]
      );
      await pool.query('DELETE FROM users WHERE id = $1', [anonRow.id]);
      user = await getUserByEmail(email);
    }
  }
  return user;
}

// mode is 'fast' (Non-editable, embedded page image) or 'editable' (real
// text — via free direct extraction OR Claude, decided automatically;
// only the pages that actually needed Claude get billed at all).
export async function incrementUsageById(id, mode, pages) {
  const column = mode === 'editable' ? 'editable_used' : 'fast_used';
  await pool.query(`UPDATE users SET ${column} = ${column} + $2, updated_at = now() WHERE id = $1`, [id, pages]);
}

export async function setDodoCustomerId(email, dodoCustomerId) {
  await pool.query('UPDATE users SET dodo_customer_id = $2, updated_at = now() WHERE email = $1', [email, dodoCustomerId]);
}

// Called from the Dodo webhook when a subscription becomes active/renews.
export async function activatePlan({ email, dodoCustomerId, dodoSubscriptionId, planKey }) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error(`Unknown plan key: ${planKey}`);
  await pool.query(
    `UPDATE users SET plan = $2, fast_limit = $3, fast_used = 0, editable_limit = $4, editable_used = 0,
       dodo_customer_id = $5, dodo_subscription_id = $6, updated_at = now()
     WHERE email = $1`,
    [email, planKey, plan.fast, plan.editable, dodoCustomerId, dodoSubscriptionId]
  );
}

export async function deactivatePlan(email) {
  await pool.query(
    `UPDATE users SET plan = 'free', fast_limit = $2, fast_used = 0, editable_limit = $3, editable_used = 0, updated_at = now()
     WHERE email = $1`,
    [email, FREE_FAST, FREE_EDITABLE]
  );
}

export async function findUserByDodoCustomerId(dodoCustomerId) {
  const res = await pool.query('SELECT * FROM users WHERE dodo_customer_id = $1', [dodoCustomerId]);
  return res.rows[0] || null;
}
