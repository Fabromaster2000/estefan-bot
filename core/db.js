// ── CORE: DATABASE ────────────────────────────────────────────────────────────
// Arquitectura v2: client_id (UUID) es el identificador único.
// phone y email son métodos de contacto opcionales — puede haber uno, ambos o ninguno.
// Esto permite crear perfiles desde web (solo email), WhatsApp (solo phone),
// o fusionar ambos cuando coinciden.

const { Pool } = require('pg');

let db = null;

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[db] Sin DATABASE_URL');
    return null;
  }
  try {
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    // ── PRE-MIGRATIONS: adaptar schema existente antes de CREATE TABLE IF NOT EXISTS
    // Agregar client_id a clients si no existe (tabla creada antes de v2)
    await db.query(`
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_id UUID DEFAULT gen_random_uuid();
    `).catch(() => {});
    // Hacer client_id PRIMARY KEY si aún no lo es
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'clients_pkey' AND contype = 'p'
        ) THEN
          ALTER TABLE clients ADD PRIMARY KEY (client_id);
        END IF;
      END$$;
    `).catch(() => {});
    // Crear índice único en phone si no existe
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone) WHERE phone IS NOT NULL`).catch(() => {});
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email ON clients(email) WHERE email IS NOT NULL`).catch(() => {});

    // ── SCHEMA v2 ─────────────────────────────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- TABLA CENTRAL: clients con client_id como PK
      -- phone y email son opcionales pero deben ser únicos si están presentes
      CREATE TABLE IF NOT EXISTS clients (
        client_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone            TEXT UNIQUE,
        email            TEXT UNIQUE,
        name             TEXT,
        last_name        TEXT,
        visit_count      INTEGER DEFAULT 0,
        total_spent      INTEGER DEFAULT 0,
        points           INTEGER DEFAULT 0,
        promo_opt_in     BOOLEAN DEFAULT FALSE,
        profile_complete BOOLEAN DEFAULT FALSE,
        preferences      TEXT,
        notes            TEXT,
        last_visit       TIMESTAMPTZ,
        source           TEXT DEFAULT 'whatsapp',
        created_at       TIMESTAMPTZ DEFAULT NOW(),
                updated_at       TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_memory (
        client_id         UUID PRIMARY KEY ,
        summary           TEXT,
        favorite_services TEXT,
        visit_patterns    TEXT,
        personality_notes TEXT,
        last_updated      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id                SERIAL PRIMARY KEY,
        session_id        TEXT,
        client_id         UUID ,
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
        status            TEXT DEFAULT 'Confirmado',
        notes             TEXT,
        mp_payment_id     TEXT,
        mp_payment_link   TEXT,
        email             TEXT,
        source            VARCHAR(50) DEFAULT 'whatsapp',
        fotos             TEXT,
        cancelled_at      TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_client_phone ON bookings(client_phone);
      CREATE INDEX IF NOT EXISTS idx_bookings_cancelled_at ON bookings(cancelled_at) WHERE cancelled_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS empleados (
        id                     SERIAL PRIMARY KEY,
        nombre                 TEXT NOT NULL,
        rol                    TEXT DEFAULT 'Estilista',
        comision_servicios_pct INTEGER DEFAULT 0,
        activo                 BOOLEAN DEFAULT TRUE,
        created_at             TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS productos (
        id           SERIAL PRIMARY KEY,
        nombre       TEXT NOT NULL,
        precio       INTEGER DEFAULT 0,
        categoria    TEXT DEFAULT 'General',
        comision_pct INTEGER DEFAULT 10,
        activo       BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id                 SERIAL PRIMARY KEY,
        numero_comprobante SERIAL,
        booking_id         INTEGER,
        client_id          UUID ,
        client_phone       TEXT,
        client_name        TEXT,
        empleado_id        INTEGER,
        medio_pago         TEXT DEFAULT 'Efectivo',
        servicios_json     TEXT DEFAULT '[]',
        productos_json     TEXT DEFAULT '[]',
        total_servicios    INTEGER DEFAULT 0,
        total_productos    INTEGER DEFAULT 0,
        descuento          INTEGER DEFAULT 0,
        total              INTEGER DEFAULT 0,
        notas              TEXT,
        email              TEXT,
        fecha_str          TEXT,
        status             VARCHAR(30) DEFAULT 'paid',
        mp_payment_link    TEXT,
        splits_json        TEXT,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS comisiones (
        id          SERIAL PRIMARY KEY,
        empleado_id INTEGER NOT NULL,
        payment_id  INTEGER NOT NULL,
        producto_id INTEGER,
        monto       INTEGER DEFAULT 0,
        descripcion TEXT,
        fecha_str   TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id          SERIAL PRIMARY KEY,
        client_id   UUID ,
        phone       TEXT,
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
        client_id  UUID ,
        phone      TEXT,
        role       TEXT,
        content    TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_convo_phone     ON conversation_log(phone);

      CREATE TABLE IF NOT EXISTS human_mode_control (
        client_id  UUID PRIMARY KEY ,
        phone      TEXT,
        active     BOOLEAN DEFAULT FALSE,
        taken_by   TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_notes (
        id         SERIAL PRIMARY KEY,
        client_id  UUID ,
        phone      TEXT,
        type       TEXT NOT NULL DEFAULT 'nota',
        content    TEXT NOT NULL,
        created_by TEXT DEFAULT 'staff',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_ficha (
        id               SERIAL PRIMARY KEY,
        client_id        UUID UNIQUE,
        phone            TEXT,
        color_actual     TEXT,
        tecnica          TEXT,
        procesos_previos TEXT,
        ultimo_proceso   TEXT,
        alergias         TEXT,
        observaciones    TEXT,
        largo            TEXT,
        textura          TEXT,
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_tokens (
        id           SERIAL PRIMARY KEY,
        client_id    UUID ,
        phone        TEXT,
        token        TEXT UNIQUE NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_client_tokens_token     ON client_tokens(token);

      CREATE TABLE IF NOT EXISTS client_photos (
        id           SERIAL PRIMARY KEY,
        client_id    UUID ,
        phone        TEXT,
        url          TEXT NOT NULL,
        tipo         TEXT NOT NULL DEFAULT 'general',
        descripcion  TEXT,
        booking_code TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS discount_codes (
        id            SERIAL PRIMARY KEY,
        code          VARCHAR(12) UNIQUE NOT NULL,
        client_id     UUID ,
        client_phone  VARCHAR(30),
        reward_id     VARCHAR(50),
        reward_label  VARCHAR(200),
        discount_type VARCHAR(20),
        discount_value NUMERIC,
        points_cost   INT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        used_at       TIMESTAMPTZ,
        used_in_cobro INT,
        status        VARCHAR(20) DEFAULT 'active'
      );
    `);

    // ── Rewards por defecto ────────────────────────────────────────────────
    await db.query(`
      INSERT INTO loyalty_rewards (name, description, points_cost, active)
      VALUES
        ('Descuento $5.000',  '$5.000 de descuento en tu próximo servicio', 5,  true),
        ('Descuento $10.000', '$10.000 de descuento en tu próximo servicio', 10, true),
        ('Ampolla gratis',    'Ampolla reparadora sin cargo',                30, true),
        ('Ozono gratis',      'Tratamiento de ozono sin cargo',              30, true),
        ('Corte gratis',      'Corte de pelo sin cargo',                    50, true)
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
function getConn() { return db; }

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUCIÓN DE IDENTIDAD
// La función más importante del sistema. Resuelve quién es la clienta
// a partir de cualquier combinación de phone, email o client_id.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolver de identidad flexible.
 * Busca en este orden: client_id → phone → email
 * Si no existe, crea el perfil. Si encuentra dos perfiles para fusionar, los fusiona.
 * Retorna siempre un row de clients (nunca null si hay al menos phone o email).
 */
async function clientResolve({ clientId, phone, email, source = 'whatsapp' } = {}) {
  if (!db) return null;

  // 1. Por client_id directo (caso más rápido)
  if (clientId) {
    const r = await db.query('SELECT * FROM clients WHERE client_id=$1', [clientId]);
    if (r.rows[0]) return r.rows[0];
  }

  // 2. Por phone
  let byPhone = null;
  if (phone) {
    const r = await db.query('SELECT * FROM clients WHERE phone=$1', [phone]);
    byPhone = r.rows[0] || null;
  }

  // 3. Por email
  let byEmail = null;
  if (email) {
    const r = await db.query('SELECT * FROM clients WHERE LOWER(email)=LOWER($1)', [email]);
    byEmail = r.rows[0] || null;
  }

  // 4. Mismo perfil
  if (byPhone && byEmail && byPhone.client_id === byEmail.client_id) return byPhone;

  // 5. Fusión: tenemos phone en un perfil y email en otro
  if (byPhone && byEmail && byPhone.client_id !== byEmail.client_id) {
    // Mantener el que tiene más datos (más visitas o más antiguo)
    const keeper  = byPhone.visit_count >= byEmail.visit_count ? byPhone  : byEmail;
    const discard = byPhone.visit_count >= byEmail.visit_count ? byEmail  : byPhone;
    await _mergeClients(keeper.client_id, discard.client_id);
    return keeper;
  }

  // 6. Solo uno encontrado — completar datos faltantes
  if (byPhone && email && !byPhone.email) {
    await db.query('UPDATE clients SET email=$1, updated_at=NOW() WHERE client_id=$2', [email.toLowerCase(), byPhone.client_id]);
    byPhone.email = email.toLowerCase();
    return byPhone;
  }
  if (byEmail && phone && !byEmail.phone) {
    await db.query('UPDATE clients SET phone=$1, source=$2, updated_at=NOW() WHERE client_id=$3', [phone, source, byEmail.client_id]);
    byEmail.phone = phone;
    return byEmail;
  }
  if (byPhone) return byPhone;
  if (byEmail) return byEmail;

  // 7. No existe — crear perfil nuevo
  const newClient = await db.query(`
    INSERT INTO clients (phone, email, source, created_at, updated_at)
    VALUES ($1, $2, $3, NOW(), NOW())
    RETURNING *
  `, [phone || null, email ? email.toLowerCase() : null, source]);
  return newClient.rows[0];
}

/**
 * Fusionar dos perfiles: reasigna todas las FK de discard → keeper, borra discard
 */
async function _mergeClients(keeperId, discardId) {
  console.log(`[db] Fusionando perfiles: ${discardId} → ${keeperId}`);
  const tables = [
    'bookings', 'loyalty_transactions', 'client_tokens', 'client_notes',
    'client_photos', 'conversation_log', 'human_mode_control',
    'payments', 'discount_codes',
  ];
  for (const t of tables) {
    await db.query(`UPDATE ${t} SET client_id=$1 WHERE client_id=$2`, [keeperId, discardId]).catch(() => {});
  }
  // client_ficha y client_memory tienen UNIQUE en client_id — merge manual
  await db.query(`
    INSERT INTO client_ficha (client_id)
    SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM client_ficha WHERE client_id=$1)
  `, [keeperId]).catch(() => {});
  await db.query('DELETE FROM client_ficha WHERE client_id=$1', [discardId]).catch(() => {});
  await db.query('DELETE FROM client_memory WHERE client_id=$1', [discardId]).catch(() => {});

  // Fusionar puntos y visitas del descartado al keeper
  const discard = await db.query('SELECT * FROM clients WHERE client_id=$1', [discardId]);
  if (discard.rows[0]) {
    const d = discard.rows[0];
    await db.query(`
      UPDATE clients SET
        visit_count = visit_count + $2,
        total_spent = total_spent + $3,
        points      = points + $4,
        phone       = COALESCE(phone, $5),
        email       = COALESCE(email, $6),
        name        = COALESCE(name, $7),
        updated_at  = NOW()
      WHERE client_id=$1
    `, [keeperId, d.visit_count || 0, d.total_spent || 0, d.points || 0, d.phone, d.email, d.name]);
  }
  await db.query('DELETE FROM clients WHERE client_id=$1', [discardId]).catch(() => {});
  console.log(`[db] ✓ Fusión completa`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTS — API pública
// ─────────────────────────────────────────────────────────────────────────────

async function clientGet(phone) {
  if (!db || !phone) return null;
  const r = await db.query('SELECT * FROM clients WHERE phone=$1', [phone]);
  return r.rows[0] || null;
}

async function clientGetById(clientId) {
  if (!db || !clientId) return null;
  const r = await db.query('SELECT * FROM clients WHERE client_id=$1', [clientId]);
  return r.rows[0] || null;
}

async function clientGetByEmail(email) {
  if (!db || !email) return null;
  const r = await db.query('SELECT * FROM clients WHERE LOWER(email)=LOWER($1)', [email]);
  return r.rows[0] || null;
}

/**
 * Upsert de cliente — siempre usa clientResolve para manejar fusiones
 */
async function clientUpsert(phone, name = null, email = null, source = 'whatsapp') {
  if (!db) return null;
  const client = await clientResolve({ phone, email, source });
  if (!client) return null;
  // Actualizar nombre si lo tenemos
  if (name) {
    await db.query('UPDATE clients SET name=COALESCE($1,name), updated_at=NOW() WHERE client_id=$2', [name, client.client_id]);
    client.name = name || client.name;
  }
  return client;
}

async function clientUpdateProfile(phone, { lastName, email, promoOptIn, profileComplete, clientId }) {
  if (!db) return;
  const id = clientId || (await clientGet(phone))?.client_id;
  if (!id) return;
  await db.query(`
    UPDATE clients SET
      last_name        = COALESCE($2, last_name),
      email            = COALESCE($3, email),
      promo_opt_in     = COALESCE($4, promo_opt_in),
      profile_complete = COALESCE($5, profile_complete),
      updated_at       = NOW()
    WHERE client_id=$1
  `, [id, lastName || null, email || null, promoOptIn ?? null, profileComplete ?? null]);
}

async function clientRecordVisit(phone, service, amount, clientId = null) {
  if (!db) return 0;
  const id = clientId || (await clientGet(phone))?.client_id;
  if (!id) return 0;
  const pointsEarned = Math.floor(amount / 1000);
  await db.query(`
    UPDATE clients SET
      visit_count = visit_count + 1,
      total_spent = total_spent + $2,
      points      = points + $3,
      last_visit  = NOW(),
      updated_at  = NOW()
    WHERE client_id=$1
  `, [id, amount, pointsEarned]);
  if (pointsEarned > 0) {
    await db.query(
      'INSERT INTO loyalty_transactions (client_id, phone, type, points, description) VALUES ($1,$2,$3,$4,$5)',
      [id, phone, 'earn', pointsEarned, `Servicio: ${service} ($${amount.toLocaleString('es-AR')})`]
    );
  }
  return pointsEarned;
}

async function clientGetAll() {
  if (!db) return [];
  const r = await db.query('SELECT * FROM clients ORDER BY last_visit DESC NULLS LAST');
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
async function configGet(key) {
  if (!db) return null;
  const r = await db.query('SELECT value FROM config WHERE key=$1', [key]);
  return r.rows[0]?.value || null;
}
async function configSet(key, value) {
  if (!db) return;
  await db.query(
    'INSERT INTO config (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
    [key, value]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT MEMORY
// ─────────────────────────────────────────────────────────────────────────────
async function memoryGet(phone) {
  if (!db) return null;
  const client = await clientGet(phone);
  if (!client) return null;
  const r = await db.query('SELECT * FROM client_memory WHERE client_id=$1', [client.client_id]);
  return r.rows[0] || null;
}

async function memoryUpdate(phone, { summary, favoriteServices, visitPatterns, personalityNotes }) {
  if (!db) return;
  try {
    const client = await clientGet(phone);
    if (!client?.client_id) return; // skip if no client_id yet (legacy schema)
    await db.query(`
      INSERT INTO client_memory (client_id, summary, favorite_services, visit_patterns, personality_notes, last_updated)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (client_id) DO UPDATE SET
        summary           = COALESCE($2, client_memory.summary),
        favorite_services = COALESCE($3, client_memory.favorite_services),
        visit_patterns    = COALESCE($4, client_memory.visit_patterns),
        personality_notes = COALESCE($5, client_memory.personality_notes),
        last_updated      = NOW()
    `, [client.client_id, summary, favoriteServices, visitPatterns, personalityNotes]);
  } catch(e) {
    // Silently ignore memory errors - non-critical feature
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOKINGS
// ─────────────────────────────────────────────────────────────────────────────
function generateBookingCode() {
  return '#' + Math.random().toString(36).substring(2,6).toUpperCase();
}

async function bookingSave({ sessionId, nombre, phone, clientId, servicio, fecha, hora, monto, senaPaid, calendarEventId, email, notes, senaAmount, status, fotos }) {
  if (!db) return null;
  const code = generateBookingCode();
  const sena = senaAmount || 0;
  const finalStatus = status || 'Confirmado';
  // Resolver client_id si no viene
  const resolvedClientId = clientId || (phone ? (await clientGet(phone))?.client_id : null);
  const r = await db.query(`
    INSERT INTO bookings
      (session_id, client_id, client_name, client_phone, service, date_str, time_str, monto,
       sena_amount, sena_paid, calendar_event_id, booking_code, email, notes, status, fotos)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING id, booking_code
  `, [sessionId, resolvedClientId, nombre, phone || null, servicio, fecha, hora, monto||0,
      sena, senaPaid||false, calendarEventId||null, code, email||null, notes||null, finalStatus, fotos||null]);
  return { id: r.rows[0].id, code: r.rows[0].booking_code };
}

async function bookingFindByCode(code) {
  if (!db) return null;
  try {
    const clean = code.replace('#','').toUpperCase();
    const r = await db.query(`
      SELECT b.id, b.client_name as nombre, b.service as servicio,
             b.date_str as fecha, b.time_str as hora,
             b.booking_code as code, b.status as estado, b.monto,
             b.client_phone as phone
      FROM bookings b
      WHERE (b.booking_code=$1 OR b.booking_code=$2)
        AND b.status NOT IN ('Cancelado','Reprogramado','Consulta Pendiente')
      ORDER BY b.created_at DESC LIMIT 1
    `, ['#'+clean, clean]);
    return r.rows[0] || null;
  } catch(e) { console.error('[db] bookingFindByCode:', e.message); return null; }
}

async function bookingFindByName(name) {
  if (!db) return null;
  try {
    const r = await db.query(`
      SELECT b.id, b.client_name as nombre, b.service as servicio,
             b.date_str as fecha, b.time_str as hora,
             b.booking_code as code, b.status as estado, b.monto,
             b.client_phone as phone
      FROM bookings b
      WHERE LOWER(b.client_name) LIKE $1
        AND b.status NOT IN ('Cancelado','Reprogramado','Consulta Pendiente')
      ORDER BY b.created_at DESC LIMIT 1
    `, ['%'+name.toLowerCase()+'%']);
    return r.rows[0] || null;
  } catch(e) { console.error('[db] bookingFindByName:', e.message); return null; }
}

async function bookingFindByEmail(email) {
  if (!db) return null;
  try {
    // Join con clients para buscar por email aunque bookings.email no exista
    const r = await db.query(`
      SELECT b.id, b.client_name as nombre, b.service as servicio,
             b.date_str as fecha, b.time_str as hora,
             b.booking_code as code, b.status as estado, b.monto,
             b.client_phone as phone
      FROM bookings b
      LEFT JOIN clients c ON c.phone = b.client_phone
      WHERE LOWER(c.email) = $1
        AND b.status NOT IN ('Cancelado','Reprogramado','Consulta Pendiente')
      ORDER BY b.created_at DESC LIMIT 1
    `, [email.toLowerCase()]);
    return r.rows[0] || null;
  } catch(e) { console.error('[db] bookingFindByEmail:', e.message); return null; }
}

async function bookingFindByPhone(searchPhone) {
  if (!db) return null;
  try {
    const r = await db.query(`
      SELECT b.id, b.client_name as nombre, b.service as servicio,
             b.date_str as fecha, b.time_str as hora,
             b.booking_code as code, b.status as estado, b.monto,
             b.client_phone as phone
      FROM bookings b
      WHERE b.client_phone = $1
        AND b.status NOT IN ('Cancelado','Reprogramado','Consulta Pendiente')
      ORDER BY b.created_at DESC LIMIT 1
    `, [searchPhone]);
    return r.rows[0] || null;
  } catch(e) { console.error('[db] bookingFindByPhone:', e.message); return null; }
}

async function bookingCancel(bookingId, reason = 'Cancelado') {
  if (!db) return;
  await db.query('UPDATE bookings SET status=$1, cancelled_at=NOW() WHERE id=$2', [reason, bookingId]);
}

async function bookingGetByClient(clientId, phone = null, limit = 10) {
  if (!db) return [];
  const r = await db.query(`
    SELECT service, date_str, time_str, status, monto, booking_code, created_at, cancelled_at
    FROM bookings
    WHERE (client_id=$1 OR client_phone=$2)
    ORDER BY created_at DESC LIMIT $3
  `, [clientId, phone, limit]);
  return r.rows;
}

// Alias backward-compatible
async function bookingGetByPhone(phone, limit = 10) {
  if (!db) return [];
  const client = await clientGet(phone);
  return bookingGetByClient(client?.client_id, phone, limit);
}

async function bookingGetActive(phone, clientId = null) {
  if (!db) return [];
  const id = clientId || (await clientGet(phone))?.client_id;
  const r = await db.query(`
    SELECT id, service, date_str, time_str, booking_code, monto
    FROM bookings
    WHERE (client_id=$1 OR client_phone=$2)
      AND status NOT IN ('Cancelado','Consulta Pendiente')
    ORDER BY created_at DESC
  `, [id, phone]);
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOYALTY
// ─────────────────────────────────────────────────────────────────────────────
async function loyaltyGetBalance(phone, clientId = null) {
  if (!db) return 0;
  const id = clientId || (await clientGet(phone))?.client_id;
  if (!id) return 0;
  const r = await db.query('SELECT points FROM clients WHERE client_id=$1', [id]);
  return r.rows[0]?.points || 0;
}

async function loyaltyGetTransactions(phone, limit = 10, clientId = null) {
  if (!db) return [];
  const id = clientId || (await clientGet(phone))?.client_id;
  if (!id) return [];
  const r = await db.query(`
    SELECT type, points, description, created_at
    FROM loyalty_transactions WHERE client_id=$1
    ORDER BY created_at DESC LIMIT $2
  `, [id, limit]);
  return r.rows;
}

async function loyaltyGetRewards() {
  if (!db) return [];
  const r = await db.query('SELECT * FROM loyalty_rewards WHERE active=true ORDER BY points_cost ASC');
  return r.rows;
}

async function loyaltyRedeem(phone, rewardId, clientId = null) {
  if (!db) return { ok: false, error: 'Sin DB' };
  const id = clientId || (await clientGet(phone))?.client_id;
  if (!id) return { ok: false, error: 'Cliente no encontrado' };
  const reward = await db.query('SELECT * FROM loyalty_rewards WHERE id=$1 AND active=true', [rewardId]);
  if (!reward.rows[0]) return { ok: false, error: 'Premio no encontrado' };
  const r = reward.rows[0];
  const balance = await loyaltyGetBalance(phone, id);
  if (balance < r.points_cost) return { ok: false, error: `Puntos insuficientes (tenés ${balance}, necesitás ${r.points_cost})` };
  await db.query('UPDATE clients SET points=points-$1 WHERE client_id=$2', [r.points_cost, id]);
  await db.query(
    'INSERT INTO loyalty_transactions (client_id, phone, type, points, description) VALUES ($1,$2,$3,$4,$5)',
    [id, phone, 'redeem', -r.points_cost, `Canje: ${r.name}`]
  );
  return { ok: true, reward: r, remainingPoints: balance - r.points_cost };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATIONS
// ─────────────────────────────────────────────────────────────────────────────
async function conversationLog(phone, role, content) {
  if (!db) return;
  const client = phone ? await clientGet(phone) : null;
  await db.query(
    'INSERT INTO conversation_log (client_id, phone, role, content) VALUES ($1,$2,$3,$4)',
    [client?.client_id || null, phone, role, content]
  );
}

async function conversationGetRecent(phone, limit = 20) {
  if (!db) return [];
  const r = await db.query(`
    SELECT role, content, created_at FROM conversation_log
    WHERE phone=$1 ORDER BY created_at DESC LIMIT $2
  `, [phone, limit]);
  return r.rows.reverse();
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT / HUMAN MODE
// ─────────────────────────────────────────────────────────────────────────────
async function chatSetHumanMode(phone, enabled, takenBy = null) {
  const client = await clientResolve({ phone });
  if (!client) return;
  await db.query(`
    INSERT INTO human_mode_control (client_id, phone, active, taken_by, updated_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (client_id) DO UPDATE SET active=$3, taken_by=$4, updated_at=NOW()
  `, [client.client_id, phone, enabled, takenBy]);
}

async function chatGetHumanMode(phone) {
  try {
    const client = await clientGet(phone);
    if (!client) return { active: false, taken_by: null };
    const r = await db.query('SELECT active, taken_by FROM human_mode_control WHERE client_id=$1', [client.client_id]);
    return r.rows[0] || { active: false, taken_by: null };
  } catch { return { active: false, taken_by: null }; }
}

async function chatListConversations() {
  const r = await db.query(`
    SELECT
      c.phone, c.client_id, c.name, c.last_name,
      COALESCE(hm.active, false)   AS human_mode,
      COALESCE(hm.taken_by, null)  AS taken_by,
      (SELECT content    FROM conversation_log WHERE client_id=c.client_id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT role       FROM conversation_log WHERE client_id=c.client_id ORDER BY created_at DESC LIMIT 1) AS last_role,
      (SELECT created_at FROM conversation_log WHERE client_id=c.client_id ORDER BY created_at DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*)   FROM conversation_log WHERE client_id=c.client_id AND role='user'
         AND created_at > NOW() - INTERVAL '24 hours') AS msgs_today
    FROM clients c
    LEFT JOIN human_mode_control hm ON hm.client_id=c.client_id
    WHERE EXISTS (SELECT 1 FROM conversation_log WHERE client_id=c.client_id)
    ORDER BY last_at DESC NULLS LAST
    LIMIT 50
  `);
  return r.rows;
}

async function chatGetHistory(phone, limit = 60) {
  const client = phone ? await clientGet(phone) : null;
  const r = await db.query(`
    SELECT role, content, created_at FROM conversation_log
    WHERE ${client ? 'client_id=$1' : 'phone=$1'}
    ORDER BY created_at ASC LIMIT $2
  `, [client?.client_id || phone, limit]);
  return r.rows;
}

async function chatSendStaffMessage(phone, content) {
  const client = await clientGet(phone);
  await db.query(
    'INSERT INTO conversation_log (client_id, phone, role, content) VALUES ($1,$2,$3,$4)',
    [client?.client_id || null, phone, 'staff', content]
  );
}

// ── LOYALTY: acreditar puntos ────────────────────────────────────────────────
async function loyaltyAdd(phone, points, description) {
  const db = getDB();
  if (!db || !phone || !points) return;
  await db.query(
    'UPDATE clients SET points = COALESCE(points,0) + $1 WHERE phone = $2',
    [points, phone]
  ).catch(() => {});
  await db.query(
    "INSERT INTO loyalty_transactions (phone, type, points, description) VALUES ($1,$2,$3,$4)",
    [phone, points > 0 ? 'earn' : 'redeem', points, description || 'Acreditación']
  ).catch(() => {});
}

// ── GIFT CARDS ────────────────────────────────────────────────────────────────

function generateGCCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'GC-' + code.slice(0, 4) + '-' + code.slice(4, 8);
}

async function giftCardCreate({ tipo, servicio, monto, puntos,
  buyerPhone, buyerName, buyerEmail,
  recipientName, recipientEmail, recipientPhone,
  pagoMetodo, createdBy }) {
  const db = getDB();
  const code = generateGCCode();
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 año de validez

  const paidAt = (pagoMetodo === 'efectivo' || pagoMetodo === 'transferencia') ? new Date() : null;
  const pagoEstado = paidAt ? 'pagado' : 'pendiente';

  const r = await db.query(`
    INSERT INTO gift_cards
      (code, tipo, servicio, monto, puntos,
       buyer_phone, buyer_name, buyer_email,
       recipient_name, recipient_email, recipient_phone,
       pago_metodo, pago_estado, paid_at,
       created_by, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING *
  `, [code, tipo, servicio||null, monto||0, puntos||0,
      buyerPhone||null, buyerName||null, buyerEmail||null,
      recipientName, recipientEmail, recipientPhone||null,
      pagoMetodo||'efectivo', pagoEstado, paidAt,
      createdBy||'staff', expiresAt]);
  return r.rows[0];
}

async function giftCardMarkPaid(code, mpPaymentId) {
  const db = getDB();
  const r = await db.query(`
    UPDATE gift_cards
    SET pago_estado='pagado', paid_at=NOW(), mp_payment_id=$2
    WHERE code=$1
    RETURNING *
  `, [code, mpPaymentId || null]);
  return r.rows[0] || null;
}

async function giftCardGetByCode(code) {
  const db = getDB();
  const r = await db.query('SELECT * FROM gift_cards WHERE code=$1', [code]);
  return r.rows[0] || null;
}

async function giftCardGetAll(filter = {}) {
  const db = getDB();
  let q = 'SELECT * FROM gift_cards WHERE 1=1';
  const params = [];
  if (filter.pago_estado) { params.push(filter.pago_estado); q += ` AND pago_estado=$${params.length}`; }
  if (filter.usada !== undefined) { params.push(filter.usada); q += ` AND usada=$${params.length}`; }
  q += ' ORDER BY created_at DESC LIMIT 200';
  const r = await db.query(q, params);
  return r.rows;
}

async function giftCardRedeem(code, bookingCode) {
  const db = getDB();
  const r = await db.query(`
    UPDATE gift_cards
    SET usada=true, used_at=NOW(), used_in_booking=$2
    WHERE code=$1
    RETURNING *
  `, [code, bookingCode || null]);
  return r.rows[0] || null;
}

module.exports = {
  initDB, getDB, getConn,
  clientResolve, clientGet, clientGetById, clientGetByEmail,
  clientUpsert, clientUpdateProfile, clientRecordVisit, clientGetAll,
  _mergeClients,
  configGet, configSet,
  memoryGet, memoryUpdate,
  bookingSave, bookingFindByCode, bookingFindByName, bookingFindByEmail, bookingFindByPhone, bookingCancel,
  bookingGetByPhone, bookingGetByClient, bookingGetActive, generateBookingCode,
  loyaltyGetBalance, loyaltyGetTransactions, loyaltyGetRewards, loyaltyRedeem,
  loyaltyAdd,
  conversationLog, conversationGetRecent,
  chatSetHumanMode, chatGetHumanMode, chatListConversations, chatGetHistory, chatSendStaffMessage,
  giftCardCreate, giftCardMarkPaid, giftCardGetByCode, giftCardGetAll, giftCardRedeem,
};