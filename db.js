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
      precise_limit INTEGER NOT NULL DEFAULT 3,
      precise_used INTEGER NOT NULL DEFAULT 0,
      scan_limit INTEGER NOT NULL DEFAULT 1,
      scan_used INTEGER NOT NULL DEFAULT 0,
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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS precise_limit INTEGER NOT NULL DEFAULT 3;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS precise_used INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scan_limit INTEGER NOT NULL DEFAULT 1;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scan_used INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fast_used INTEGER NOT NULL DEFAULT 0;`);
  // fast_limit is new — earlier versions had fast_used only, with no real cap
  // (unlimited, soft-abuse-guarded). Existing rows get the real free-tier cap
  // applied by default via DEFAULT 500 below; paid-plan rows get corrected the
  // next time their subscription renews (activatePlan sets it explicitly).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fast_limit INTEGER NOT NULL DEFAULT 500;`);
  // Best-effort carry-over from the older single-bucket schema, if present —
  // treat prior combined usage as "precise" usage so nobody's history is lost.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='pages_used')
         AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='pages_limit') THEN
        UPDATE users SET precise_used = pages_used, precise_limit = GREATEST(pages_limit, 3) WHERE precise_used = 0 AND pages_used > 0;
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

// Free tier (no sign-in): real trial allowances for all three modes, so
// people can judge quality before paying — Fast gets a generous but real
// cap now too (previously unlimited), not just a soft abuse guard.
export const FREE_FAST = 500;
export const FREE_PRECISE = 3;
export const FREE_SCAN = 1;

// Launch prices — matching real prices actually charged from day one, so any
// later strikethrough discount is a legitimate former price, not a fabricated one.
// "fast" uses a large-but-finite number rather than a special "unlimited" value,
// so quota checks can use the exact same comparison logic for every mode.
const UNLIMITED_FAST = 1_000_000;
export const PLANS = {
  plan_20:  { fast: UNLIMITED_FAST, precise: 100,  scan: 30,  priceLabel: '$20 / mo' },
  plan_120: { fast: UNLIMITED_FAST, precise: 1000, scan: 200, priceLabel: '$120 / mo' },
};

// The free tier is anonymous — identified by a random ID the extension
// generates once and stores locally, sent as the X-Anonymous-Id header.
export async function findOrCreateAnonUser(anonId) {
  const existing = await pool.query('SELECT * FROM users WHERE anon_id = $1', [anonId]);
  if (existing.rows.length) return existing.rows[0];
  const inserted = await pool.query(
    `INSERT INTO users (anon_id, plan, fast_limit, precise_limit, scan_limit) VALUES ($1,'free',$2,$3,$4) RETURNING *`,
    [anonId, FREE_FAST, FREE_PRECISE, FREE_SCAN]
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
    let fastUsedToCarry = 0, preciseUsedToCarry = 0, scanUsedToCarry = 0;
    let anonRow = null;
    if (anonId) {
      const res = await pool.query('SELECT * FROM users WHERE anon_id = $1', [anonId]);
      anonRow = res.rows[0] || null;
      if (anonRow) {
        fastUsedToCarry = anonRow.fast_used;
        preciseUsedToCarry = anonRow.precise_used;
        scanUsedToCarry = anonRow.scan_used;
      }
    }
    const inserted = await pool.query(
      `INSERT INTO users (email, google_sub, plan, fast_limit, fast_used, precise_limit, precise_used, scan_limit, scan_used)
       VALUES ($1,$2,'free',$3,$4,$5,$6,$7,$8) RETURNING *`,
      [email, googleSub || null, FREE_FAST, Math.min(fastUsedToCarry, FREE_FAST),
       FREE_PRECISE, Math.min(preciseUsedToCarry, FREE_PRECISE),
       FREE_SCAN, Math.min(scanUsedToCarry, FREE_SCAN)]
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
           precise_used = LEAST(precise_used + $3, precise_limit),
           scan_used = LEAST(scan_used + $4, scan_limit),
           updated_at = now()
         WHERE id = $1`,
        [user.id, anonRow.fast_used, anonRow.precise_used, anonRow.scan_used]
      );
      await pool.query('DELETE FROM users WHERE id = $1', [anonRow.id]);
      user = await getUserByEmail(email);
    }
  }
  return user;
}

// mode is 'fast' | 'precise' | 'scan' — decided per-page by scan detection
// plus the user's manual Fast/Precise choice for non-scanned pages.
export async function incrementUsageById(id, mode, pages) {
  const column = mode === 'scan' ? 'scan_used' : mode === 'precise' ? 'precise_used' : 'fast_used';
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
    `UPDATE users SET plan = $2, fast_limit = $3, fast_used = 0, precise_limit = $4, precise_used = 0,
       scan_limit = $5, scan_used = 0, dodo_customer_id = $6, dodo_subscription_id = $7, updated_at = now()
     WHERE email = $1`,
    [email, planKey, plan.fast, plan.precise, plan.scan, dodoCustomerId, dodoSubscriptionId]
  );
}

export async function deactivatePlan(email) {
  await pool.query(
    `UPDATE users SET plan = 'free', fast_limit = $2, fast_used = 0, precise_limit = $3, precise_used = 0,
       scan_limit = $4, scan_used = 0, updated_at = now()
     WHERE email = $1`,
    [email, FREE_FAST, FREE_PRECISE, FREE_SCAN]
  );
}

export async function findUserByDodoCustomerId(dodoCustomerId) {
  const res = await pool.query('SELECT * FROM users WHERE dodo_customer_id = $1', [dodoCustomerId]);
  return res.rows[0] || null;
}
