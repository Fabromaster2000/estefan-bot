// ── AGENT: INTAKE ─────────────────────────────────────────────────────────────
// Carga y hidrata el perfil de la clienta para cada mensaje entrante.
// v2: resuelve identidad por phone, email o client_id — no solo phone.
'use strict';

const { ClientProfile }     = require('../core/client_profile');
const { clientResolve, clientGet, getDB } = require('../core/db');

// Cache en memoria — 5 minutos de TTL
const _cache  = new Map();
const TTL_MS  = 5 * 60 * 1000;

function _cacheKey({ clientId, phone, email }) {
  return clientId || phone || email || 'anon';
}

function invalidateCache(identifier) {
  // Acepta phone, email o client_id
  _cache.delete(identifier);
}

/**
 * Carga el perfil completo de una clienta.
 * Acepta { phone }, { email }, { clientId }, o cualquier combinación.
 */
async function loadProfile({ phone = null, email = null, clientId = null, source = 'whatsapp' } = {}) {
  const key = _cacheKey({ clientId, phone, email });
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.profile;

  const profile = new ClientProfile();

  try {
    const db = getDB();
    if (!db) return profile;

    // 1. Resolver quién es la clienta
    const client = await clientResolve({ clientId, phone, email, source });
    if (!client) return profile;

    const cid = client.client_id;

    // 2. Cargar datos en paralelo — por client_id (fuente de verdad)
    const [bookingsRow, fichaRow, notesRow] = await Promise.all([
      db.query(`
        SELECT booking_code, service, date_str, time_str, status, monto, cancelled_at, created_at
        FROM bookings
        WHERE client_id = $1
        ORDER BY date_str DESC, time_str DESC
        LIMIT 20
      `, [cid]).then(r => r.rows).catch(() => []),

      db.query('SELECT * FROM client_ficha WHERE client_id=$1', [cid])
        .then(r => r.rows[0] || null).catch(() => null),

      db.query(`
        SELECT content, type, created_by, created_at
        FROM client_notes
        WHERE client_id=$1
        ORDER BY created_at DESC LIMIT 10
      `, [cid]).then(r => r.rows).catch(() => []),
    ]);

    profile.hydrate(client, bookingsRow, fichaRow, notesRow);

  } catch(e) {
    console.error('[intake] Error loading profile:', e.message);
  }

  _cache.set(key, { profile, ts: Date.now() });
  return profile;
}

/**
 * buildContext — contexto completo para el orquestador.
 * Funciona con phone (WhatsApp), email (web) o client_id.
 */
async function buildContext(identifier, { email = null, source = 'whatsapp' } = {}) {
  // identifier puede ser un phone string (legacy) o { phone, email, clientId }
  let phone = null, clientId = null;
  if (typeof identifier === 'string') {
    phone = identifier;
  } else {
    phone    = identifier.phone    || null;
    email    = identifier.email    || email || null;
    clientId = identifier.clientId || null;
  }

  const profile = await loadProfile({ phone, email, clientId, source });

  const recentBookings = profile.lastServices.map(s => ({
    service: s.servicio,
    date:    s.fecha,
  }));

  return {
    phone:    phone || profile.phone,
    email:    email || profile.email,
    clientId: profile.clientId,
    profile,
    client: {
      client_id:   profile.clientId,
      phone:       profile.phone,
      email:       profile.email,
      name:        profile.firstName,
      last_name:   profile.lastName,
      visit_count: profile.visitCount,
      points:      profile.points,
      total_spent: profile.totalSpent,
      last_visit:  profile.lastVisitDate,
    },
    isNewClient:     profile.isNewClient,
    isVip:           profile.isVip,
    recentBookings,
    nextBooking:     profile.nextBooking,
    favoriteService: profile.favoriteService,
    upsellOpps:      profile.upsellOpportunities,
    promptContext:   profile.toPromptContext(),
  };
}

// Backward-compatible alias
async function run({ phone }) {
  await loadProfile({ phone });
}

module.exports = { buildContext, run, loadProfile, invalidateCache };