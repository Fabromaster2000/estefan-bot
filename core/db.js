// ── CORE: DATABASE ────────────────────────────────────────────────────────────
// Todas las operaciones con PostgreSQL centralizadas acá.
// Ningún agente escribe SQL directamente — todo pasa por este módulo.

const { Pool } = require('pg');

let db = null;

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[db] Sin DATABASE_URL');
    return null;
  }
  try {
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    // ── SCHEMA ──────────────────────────────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clients (
        id               SERIAL PRIMARY KEY,
        phone            TEXT UNIQUE NOT NULL,
        name             TEXT,
        last_name        TEXT,
        email            TEXT,
        visit_count      INTEGER DEFAULT 0,
        total_spent      INTEGER DEFAULT 0,
        points           INTEGER DEFAULT 0,
        promo_opt_in     BOOLEAN DEFAULT FALSE,
        profile_complete BOOLEAN DEFAULT FALSE,
        preferences      TEXT,
        notes            TEXT,
        last_visit       TIMESTAMPTZ,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_memory (
        id           SERIAL PRIMARY KEY,
        phone        TEXT UNIQUE NOT NULL,
        summary      TEXT,
        favorite_services TEXT,
        visit_patterns    TEXT,
        personality_notes TEXT,
        last_updated TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id                SERIAL PRIMARY KEY,
        session_id        TEXT,
        client_phone      TEXT,
        client_name       TEXT,
        service           TEXT,
        date_str          TEXT,
        time_str          TEXT,
        monto             INTEGER DEFAULT 0,
        sena_amount       INTEGER DEFAULT 0,
        sena_paid         BOOLEAN DEFAULT FALSE,
        calendar_event_id TEXT,
        booking_code      TEXT,
        status            TEXT DEFAULT 'confirmed',
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id          SERIAL PRIMARY KEY,
        phone       TEXT NOT NULL,
        type        TEXT NOT NULL,
        points      INTEGER NOT NULL,
        description TEXT,
        booking_id  INTEGER,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS loyalty_rewards (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        points_cost INTEGER NOT NULL,
        active      BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conversation_log (
        id         SERIAL PRIMARY KEY,
        phone      TEXT,
        role       TEXT,
        content    TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── MIGRATIONS: columnas que pueden faltar en DBs existentes ────────────
    const migrations = [
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_name TEXT`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS promo_opt_in BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS profile_complete BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0`,
      `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_code TEXT`,
      `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS monto INTEGER DEFAULT 0`,
      `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'confirmed'`,
      `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS calendar_event_id TEXT`,
    ];
    for (const m of migrations) {
      await db.query(m).catch(() => {});
    }

    // ── Rewards por defecto ──────────────────────────────────────────────────
    await db.query(`
      INSERT INTO loyalty_rewards (name, description, points_cost, active)
      VALUES
        ('Descuento $5.000',   '$5.000 de descuento en tu próximo servicio', 5, true),
        ('Descuento $10.000',  '$10.000 de descuento en tu próximo servicio', 10, true),
        ('Ampolla gratis',     'Ampolla reparadora sin cargo', 30, true),
        ('Ozono gratis',       'Tratamiento de ozono sin cargo', 30, true),
        ('Corte gratis',       'Corte de pelo sin cargo', 50, true)
      ON CONFLICT DO NOTHING
    `).catch(() => {});

    console.log('[db] ✓ PostgreSQL conectado y tablas listas');
    return db;
  } catch(e) {
    console.error('[db] Error:', e.message);
    db = null;
    return null;
  }
}

function getDB() { return db; }

// ── CONFIG ───────────────────────────────────────────────────────────────────
async function configGet(key) {
  if (!db) return null;
  const r = await db.query(`SELECT value FROM config WHERE key = $1`, [key]);
  return r.rows[0]?.value || null;
}
async function configSet(key, value) {
  if (!db) return;
  await db.query(`INSERT INTO config (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`, [key, value]);
}

// ── CLIENTS ──────────────────────────────────────────────────────────────────
async function clientGet(phone) {
  if (!db) return null;
  const r = await db.query(`SELECT * FROM clients WHERE phone = $1`, [phone]);
  return r.rows[0] || null;
}

async function clientUpsert(phone, name = null) {
  if (!db) return;
  await db.query(`
    INSERT INTO clients (phone, name, created_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (phone) DO UPDATE SET
      name = COALESCE($2, clients.name),
      updated_at = NOW()
  `, [phone, name]);
}

async function clientUpdateProfile(phone, { lastName, email, promoOptIn, profileComplete }) {
  if (!db) return;
  await db.query(`
    UPDATE clients SET
      last_name        = COALESCE($2, last_name),
      email            = COALESCE($3, email),
      promo_opt_in     = COALESCE($4, promo_opt_in),
      profile_complete = COALESCE($5, profile_complete),
      updated_at       = NOW()
    WHERE phone = $1
  `, [phone, lastName, email, promoOptIn, profileComplete]);
}

async function clientRecordVisit(phone, service, amount) {
  if (!db) return;
  // Calcular puntos: 1 punto cada $1.000
  const pointsEarned = Math.floor(amount / 1000);
  await db.query(`
    UPDATE clients SET
      visit_count = visit_count + 1,
      total_spent = total_spent + $2,
      points      = points + $3,
      last_visit  = NOW(),
      updated_at  = NOW()
    WHERE phone = $1
  `, [phone, amount, pointsEarned]);
  // Registrar transacción de puntos si ganó algo
  if (pointsEarned > 0) {
    await db.query(`
      INSERT INTO loyalty_transactions (phone, type, points, description)
      VALUES ($1, 'earn', $2, $3)
    `, [phone, pointsEarned, `Servicio: ${service} ($${amount.toLocaleString('es-AR')})`]);
  }
  return pointsEarned;
}

async function clientGetAll() {
  if (!db) return [];
  const r = await db.query(`SELECT * FROM clients ORDER BY last_visit DESC NULLS LAST`);
  return r.rows;
}

// ── CLIENT MEMORY ─────────────────────────────────────────────────────────────
async function memoryGet(phone) {
  if (!db) return null;
  const r = await db.query(`SELECT * FROM client_memory WHERE phone = $1`, [phone]);
  return r.rows[0] || null;
}

async function memoryUpdate(phone, { summary, favoriteServices, visitPatterns, personalityNotes }) {
  if (!db) return;
  await db.query(`
    INSERT INTO client_memory (phone, summary, favorite_services, visit_patterns, personality_notes, last_updated)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (phone) DO UPDATE SET
      summary           = COALESCE($2, client_memory.summary),
      favorite_services = COALESCE($3, client_memory.favorite_services),
      visit_patterns    = COALESCE($4, client_memory.visit_patterns),
      personality_notes = COALESCE($5, client_memory.personality_notes),
      last_updated      = NOW()
  `, [phone, summary, favoriteServices, visitPatterns, personalityNotes]);
}

// ── BOOKINGS ─────────────────────────────────────────────────────────────────
function generateBookingCode() {
  return '#' + Math.random().toString(36).substring(2,6).toUpperCase();
}

async function bookingSave({ sessionId, nombre, phone, servicio, fecha, hora, monto, senaPaid, calendarEventId }) {
  if (!db) return null;
  const code = generateBookingCode();
  const r = await db.query(`
    INSERT INTO bookings (session_id, client_name, client_phone, service, date_str, time_str, monto, sena_amount, sena_paid, calendar_event_id, booking_code)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id, booking_code
  `, [sessionId, nombre, phone, servicio, fecha, hora, monto||0, senaPaid?monto:0, senaPaid||false, calendarEventId||null, code]);
  return { id: r.rows[0].id, code: r.rows[0].booking_code };
}

async function bookingFindByCode(code) {
  if (!db) return null;
  const r = await db.query(`
    SELECT id, client_name as nombre, service as servicio, date_str as fecha,
           time_str as hora, booking_code as code, status as estado, monto
    FROM bookings WHERE booking_code = $1 AND status NOT IN ('Cancelado','Reprogramado','cancelled')
    ORDER BY created_at DESC LIMIT 1
  `, [code.toUpperCase()]);
  return r.rows[0] || null;
}

async function bookingFindByName(name) {
  if (!db) return null;
  const r = await db.query(`
    SELECT id, client_name as nombre, service as servicio, date_str as fecha,
           time_str as hora, booking_code as code, status as estado, monto
    FROM bookings WHERE LOWER(client_name) LIKE $1 AND status NOT IN ('Cancelado','Reprogramado','cancelled')
    ORDER BY created_at DESC LIMIT 1
  `, ['%' + name.toLowerCase() + '%']);
  return r.rows[0] || null;
}

async function bookingCancel(bookingId, reason = 'Cancelado') {
  if (!db) return;
  await db.query(`UPDATE bookings SET status = $1 WHERE id = $2`, [reason, bookingId]);
}

async function bookingGetByPhone(phone, limit = 10) {
  if (!db) return [];
  const r = await db.query(`
    SELECT service, date_str, time_str, status, monto, booking_code, created_at
    FROM bookings WHERE client_phone = $1 ORDER BY created_at DESC LIMIT $2
  `, [phone, limit]);
  return r.rows;
}

async function bookingGetActive(phone) {
  if (!db) return [];
  const r = await db.query(`
    SELECT id, service, date_str, time_str, booking_code, monto
    FROM bookings WHERE client_phone = $1 AND status = 'confirmed'
    ORDER BY created_at DESC
  `, [phone]);
  return r.rows;
}

// ── LOYALTY ──────────────────────────────────────────────────────────────────
async function loyaltyGetBalance(phone) {
  if (!db) return 0;
  const r = await db.query(`SELECT points FROM clients WHERE phone = $1`, [phone]);
  return r.rows[0]?.points || 0;
}

async function loyaltyGetTransactions(phone, limit = 10) {
  if (!db) return [];
  const r = await db.query(`
    SELECT type, points, description, created_at
    FROM loyalty_transactions WHERE phone = $1
    ORDER BY created_at DESC LIMIT $2
  `, [phone, limit]);
  return r.rows;
}

async function loyaltyGetRewards() {
  if (!db) return [];
  const r = await db.query(`SELECT * FROM loyalty_rewards WHERE active = true ORDER BY points_cost ASC`);
  return r.rows;
}

async function loyaltyRedeem(phone, rewardId) {
  if (!db) return { ok: false, error: 'Sin DB' };
  const reward = await db.query(`SELECT * FROM loyalty_rewards WHERE id = $1 AND active = true`, [rewardId]);
  if (!reward.rows[0]) return { ok: false, error: 'Premio no encontrado' };
  const r = reward.rows[0];
  const balance = await loyaltyGetBalance(phone);
  if (balance < r.points_cost) return { ok: false, error: `Puntos insuficientes (tenés ${balance}, necesitás ${r.points_cost})` };
  await db.query(`UPDATE clients SET points = points - $1 WHERE phone = $2`, [r.points_cost, phone]);
  await db.query(`INSERT INTO loyalty_transactions (phone, type, points, description) VALUES ($1, 'redeem', $2, $3)`,
    [phone, -r.points_cost, `Canje: ${r.name}`]);
  return { ok: true, reward: r, remainingPoints: balance - r.points_cost };
}

// ── CONVERSATIONS ────────────────────────────────────────────────────────────
async function conversationLog(phone, role, content) {
  if (!db) return;
  await db.query(`INSERT INTO conversation_log (phone, role, content) VALUES ($1,$2,$3)`, [phone, role, content]);
}

async function conversationGetRecent(phone, limit = 20) {
  if (!db) return [];
  const r = await db.query(`
    SELECT role, content, created_at FROM conversation_log
    WHERE phone = $1 ORDER BY created_at DESC LIMIT $2
  `, [phone, limit]);
  return r.rows.reverse();
}

module.exports = {
  initDB, getDB,
  configGet, configSet,
  clientGet, clientUpsert, clientUpdateProfile, clientRecordVisit, clientGetAll,
  memoryGet, memoryUpdate,
  bookingSave, bookingFindByCode, bookingFindByName, bookingCancel, bookingGetByPhone, bookingGetActive, generateBookingCode,
  loyaltyGetBalance, loyaltyGetTransactions, loyaltyGetRewards, loyaltyRedeem,
  conversationLog, conversationGetRecent,
};
