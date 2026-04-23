// agents/intake.js
// =============================================================================
// Intake — loads and hydrates a ClientProfile for every incoming message.
// This is what gives Estefi her "memory" of each client.
// =============================================================================
'use strict';

const { ClientProfile } = require('../core/client_profile');
const { clientGet, getDB } = require('../core/db');

// In-memory cache so we don't hit the DB on every single message
// Invalidated after 5 minutes or on explicit refresh
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Load a ClientProfile for a given phone number.
 * Uses in-memory cache with 5-min TTL.
 */
async function loadProfile(phone) {
  const cached = _cache.get(phone);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.profile;
  }

  const profile = new ClientProfile();

  try {
    const db = getDB();
    if (!db) return profile;

    // Parallel DB queries
    const [clientRow, bookingsRow, fichaRow, notesRow] = await Promise.all([
      clientGet(phone),
      db.query(`
        SELECT booking_code, service, date_str, time_str, status, monto, created_at
        FROM bookings
        WHERE client_phone = $1
        ORDER BY date_str DESC, time_str DESC
        LIMIT 20
      `, [phone]).then(r => r.rows).catch(() => []),
      db.query(
        'SELECT * FROM client_ficha WHERE client_phone = $1',
        [phone]
      ).then(r => r.rows[0] || null).catch(() => null),
      db.query(`
        SELECT content, type, created_by, created_at
        FROM client_notes
        WHERE client_phone = $1
        ORDER BY created_at DESC
        LIMIT 10
      `, [phone]).then(r => r.rows).catch(() => []),
    ]);

    profile.hydrate(clientRow, bookingsRow, fichaRow, notesRow);

  } catch(e) {
    console.error('[intake] Error loading profile for', phone, e.message);
  }

  _cache.set(phone, { profile, ts: Date.now() });
  return profile;
}

/**
 * Invalidate cache for a phone (call after booking, payment, note update, etc.)
 */
function invalidateCache(phone) {
  _cache.delete(phone);
}

/**
 * buildContext — returns the full context object the orchestrator uses.
 * Backward compatible with existing orchestrator calls.
 */
async function buildContext(phone) {
  const profile = await loadProfile(phone);

  // Build recentBookings array for upsell engine (backward compat)
  const recentBookings = profile.lastServices.map(s => ({
    service: s.servicio,
    date:    s.fecha,
  }));

  return {
    phone,
    profile,                          // full ClientProfile object
    client: {                          // legacy flat object (orchestrator uses this)
      phone,
      name:        profile.firstName,
      last_name:   profile.lastName,
      email:       profile.email,
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
    promptContext:   profile.toPromptContext(),   // ← injected into Estefi's prompt
  };
}

/**
 * run — legacy function called at session start.
 * Just warms up the cache.
 */
async function run({ phone }) {
  await loadProfile(phone);
}

module.exports = { buildContext, run, loadProfile, invalidateCache };
