// ── ESTEFAN PELUQUERÍA BOT v4 ─────────────────────────────────────────────────
// Arquitectura multi-agente modular
// Cada agente tiene una responsabilidad única y no toca lo de los demás.
//
// /core    → DB, Calendar, Sheets, Sessions, Utils, Servicios
// /agents  → Orchestrator, Intake, Personal, Booking, Loyalty, Upsell, Memory, Mailer

'use strict';

const express  = require('express');
const axios    = require('axios');

// ── Core modules ─────────────────────────────────────────────────────────────
const db       = require('./core/db');
const { getSession, getAllSessions } = require('./core/session');
const calendar = require('./core/calendar');
const sheets   = require('./core/sheets');
const { generateSessionId } = require('./core/utils');

// ── Agents ───────────────────────────────────────────────────────────────────
const orchestrator = require('./agents/orchestrator');

// ── Config ───────────────────────────────────────────────────────────────────
const PORT             = process.env.PORT || 10000;
const WASSENGER_KEY    = process.env.WASSENGER_API_KEY;
const WASSENGER_DEVICE = process.env.WASSENGER_DEVICE_ID || '';

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Logo estático para emails (Gmail bloquea base64 inline) ──────────────────
const LOGO_JPG_B64 = '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';
app.get('/assets/logo.jpg', (req, res) => {
  const buf = Buffer.from(LOGO_JPG_B64, 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buf);
});
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Send WhatsApp ─────────────────────────────────────────────────────────────
async function sendWhatsApp(phone, text) {
  if (!WASSENGER_KEY) return console.log('[wa] Sin API key');
  await axios.post('https://api.wassenger.com/v1/messages', { phone, message: text }, {
    headers: { Token: WASSENGER_KEY }
  });
}

// ── WHATSAPP WEBHOOK ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    if (event.event !== 'message:in:new') return;
    const msg = event.data;
    if (!msg || msg.fromMe) return;
    const originalId = msg.chat?.id || msg.from || '';
    if (originalId.includes('@g.us')) return;
    const rawPhone = msg.chat?.id?.replace('@c.us','') || msg.from?.replace('@c.us','');
    const phone = rawPhone?.startsWith('+') ? rawPhone : `+${rawPhone}`;
    const text  = msg.body?.trim();
    if (!phone || !text) return;
    console.log(`[wa→in] ${phone}: ${text.substring(0,60)}`);
    const reply = await orchestrator.handle({ sessionId: phone, phone, text });
    await sendWhatsApp(phone, reply);
    console.log(`[wa→out] ${phone}: ${reply.substring(0,80)}`);
  } catch(err) {
    console.error('[webhook error]', err.message);
  }
});

// ── WEB CHAT (Dashboard) ─────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { sessionId, message, text } = req.body;
    const userText = text || message;
    if (!sessionId || !userText) return res.status(400).json({ error: 'Faltan campos' });
    const reply = await orchestrator.handle({ sessionId, phone: sessionId, text: userText });
    const session = getSession(sessionId);
    res.json({
      reply,
      requiresStaff:  session.requiresStaff  || false,
      pendingBooking: session.pendingBooking  || null,
      bookings:       session.confirmedBookings || [],
    });
  } catch(err) {
    console.error('[chat error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FIRST MESSAGE (bienvenida al web chat) ────────────────────────────────────
app.post('/chat/start', async (req, res) => {
  try {
    const sessionId = generateSessionId();
    const session = getSession(sessionId);
    session.welcomed = true;
    const { buildContext, run } = require('./agents/intake');
    const { greet } = require('./agents/personal');
    await run({ phone: sessionId });
    const clientCtx = await buildContext(sessionId);
    const welcome = await greet({ clientCtx });
    res.json({ sessionId, message: welcome });
  } catch(err) {
    console.error('[start error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STAFF REPLY ───────────────────────────────────────────────────────────────
app.post('/staff-reply', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: 'Faltan campos' });
    const session = getSession(sessionId);
    if (session.historial) session.historial.push({ role: 'assistant', content: `[STAFF] ${message}` });
    if (sessionId.startsWith('+')) await sendWhatsApp(sessionId, message);
    console.log(`[staff→] ${sessionId}: ${message.substring(0,60)}`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GOOGLE AUTH ───────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.GOOGLE_REDIRECT_URI||'https://peluqueria-bot.onrender.com/auth/callback')}&response_type=code&scope=https://www.googleapis.com/auth/calendar&access_type=offline&prompt=consent`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Sin code');
  try {
    const r = await axios.post('https://oauth2.googleapis.com/token', {
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI||'https://peluqueria-bot.onrender.com/auth/callback',
      grant_type: 'authorization_code',
    });
    const tokens = r.data;
    calendar.setGoogleTokens(tokens);
    await db.configSet('google_tokens', JSON.stringify(tokens));
    console.log('[auth] ✓ Google tokens guardados');
    res.send('✅ Google Calendar autorizado. Podés cerrar esta ventana.');
  } catch(e) {
    console.error('[auth] Error:', e.response?.data || e.message);
    res.status(500).send('Error obteniendo tokens: ' + e.message);
  }
});

// ── DATA ENDPOINTS ────────────────────────────────────────────────────────────
app.get('/clients', async (req, res) => {
  try { res.json(await db.clientGetAll()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/bookings', async (req, res) => {
  try {
    const dbConn = db.getDB();
    if (!dbConn) return res.json([]);
    const r = await dbConn.query(`SELECT * FROM bookings ORDER BY created_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/sessions', (req, res) => res.json(getAllSessions()));

app.get('/loyalty/rewards', async (req, res) => {
  try { res.json(await db.loyaltyGetRewards()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/loyalty/:phone', async (req, res) => {
  try {
    const balance = await db.loyaltyGetBalance(req.params.phone);
    const txs = await db.loyaltyGetTransactions(req.params.phone);
    res.json({ balance, transactions: txs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SHEETS SYNC ───────────────────────────────────────────────────────────────
app.post('/sheets/sync', async (req, res) => {
  try { await sheets.syncClientesToSheet(); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/sheets/metrics', async (req, res) => {
  try { await sheets.refreshMetricas(); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'estefan2024';

app.get('/admin/clients', adminAuth, async (req, res) => {
  try {
    const dbConn = db.getDB();
    const r = await dbConn.query(`SELECT phone, name, last_name, email, visit_count, points, created_at FROM clients ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cleanup-test-clients', adminAuth, async (req, res) => {
  const pw = req.headers['x-staff-password'] || req.body?.password;
  if (pw !== (process.env.ADMIN_PASSWORD || 'P@chor!23')) return res.status(403).json({ error: 'No autorizado' });
  try {
    const dbConn = db.getDB();
    const clients = await dbConn.query(`SELECT phone FROM clients WHERE phone LIKE 'web-%'`);
    const phones = clients.rows.map(c => c.phone);
    if (!phones.length) return res.json({ ok: true, deleted: 0 });
    await dbConn.query(`DELETE FROM bookings WHERE client_phone = ANY($1)`, [phones]);
    const del = await dbConn.query(`DELETE FROM clients WHERE phone = ANY($1)`, [phones]);
    await sheets.syncClientesToSheet();
    res.json({ ok: true, deleted: del.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/delete-client', adminAuth, async (req, res) => {
  const pw = req.headers['x-staff-password'] || req.body?.password;
  if (pw !== (process.env.ADMIN_PASSWORD || 'P@chor!23')) return res.status(403).json({ error: 'No autorizado' });
  try {
    const dbConn = db.getDB();
    await dbConn.query(`DELETE FROM bookings WHERE client_phone = $1`, [req.body.phone]);
    await dbConn.query(`DELETE FROM clients WHERE phone = $1`, [req.body.phone]);
    await sheets.syncClientesToSheet();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar turno individual
app.delete('/admin/booking/:id', adminAuth, async (req, res) => {
  // adminAuth middleware handles this
  try {
    const dbConn = db.getDB();
    const r = await dbConn.query('DELETE FROM bookings WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Turno no encontrado' });
    res.json({ ok: true, id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar múltiples turnos
app.post('/admin/bookings/bulk-delete', adminAuth, async (req, res) => {
  // adminAuth middleware handles this
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.json({ ok: true, deleted: 0 });
    const dbConn = db.getDB();
    const r = await dbConn.query('DELETE FROM bookings WHERE id = ANY($1)', [ids]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listar todos los turnos para admin (con filtros)
app.get('/admin/bookings', adminAuth, async (req, res) => {
  // adminAuth middleware handles this
  try {
    const dbConn = db.getDB();
    const { filter } = req.query; // 'test' | 'all'
    let q = `SELECT id, booking_code as code, client_name as nombre, client_phone as phone,
             service as servicio, date_str as fecha, time_str as hora,
             status as estado, monto, created_at
             FROM bookings`;
    if (filter === 'test') q += ` WHERE client_phone LIKE 'web-%'`;
    q += ` ORDER BY created_at DESC LIMIT 500`;
    const r = await dbConn.query(q);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stats de DB
app.get('/admin/stats', adminAuth, async (req, res) => {
  // adminAuth middleware handles this
  try {
    const dbConn = db.getDB();
    const [bTotal, bTest, bReal, clients] = await Promise.all([
      dbConn.query('SELECT COUNT(*) FROM bookings'),
      dbConn.query("SELECT COUNT(*) FROM bookings WHERE client_phone LIKE 'web-%'"),
      dbConn.query("SELECT COUNT(*) FROM bookings WHERE client_phone NOT LIKE 'web-%' AND client_phone IS NOT NULL"),
      dbConn.query('SELECT COUNT(*) FROM clients'),
    ]);
    res.json({
      bookings: { total: +bTotal.rows[0].count, test: +bTest.rows[0].count, real: +bReal.rows[0].count },
      clients: +clients.rows[0].count
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH & STATUS ───────────────────────────────────────────────────────────
// ── STAFF PORTAL API ─────────────────────────────────────────────────────────
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'estefan2024';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'P@chor!23';

function staffAuth(req, res, next) {
  const pw = req.headers['x-staff-password'] || req.query.pw;
  if (pw !== STAFF_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

function adminAuth(req, res, next) {
  const pw = req.headers['x-staff-password'] || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// Helper: get raw DB connection for staff routes
function getConn() { return db.getDB(); }

// Helper: trae booking con email resuelto (booking.email || clients.email)
async function getBookingWithEmail(id) {
  const r = await getConn().query(`
    SELECT b.id, b.booking_code, b.client_name, b.client_phone, b.service,
           b.date_str, b.time_str, b.monto, b.status, b.notes, b.sena_amount,
           COALESCE(NULLIF(b.email,''), c.email) AS email
    FROM bookings b
    LEFT JOIN clients c ON c.phone = b.client_phone
    WHERE b.id = $1
  `, [id]);
  const bk = r.rows[0] || null;
  if (bk) console.log(`[booking-email] id=${id} email=${bk.email||'none'} phone=${bk.client_phone}`);
  return bk;
}

// Agenda del día / semana
app.get('/staff/agenda', staffAuth, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const r = await getConn().query(`
      SELECT b.id, b.booking_code as code, b.client_name as nombre, b.client_phone as phone,
             b.service as servicio, b.date_str as fecha, b.time_str as hora,
             b.status as estado, b.monto, b.created_at,
             COALESCE(NULLIF(b.email,''), c.email) AS email
      FROM bookings b
      LEFT JOIN clients c ON c.phone = b.client_phone
      WHERE b.created_at >= NOW() - INTERVAL '1 day'
         OR b.date_str >= TO_CHAR(NOW(), 'DD/MM/YYYY')
      ORDER BY b.date_str ASC, b.time_str ASC
      LIMIT 200
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Turnos de hoy
app.get('/staff/today', staffAuth, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day:'2-digit', month:'2-digit', year:'numeric' });
    const r = await getConn().query(`
      SELECT b.id, b.booking_code as code, b.client_name as nombre, b.client_phone as phone,
             b.service as servicio, b.date_str as fecha, b.time_str as hora,
             b.status as estado, b.monto,
             COALESCE(NULLIF(b.email,''), c.email) AS email
      FROM bookings b
      LEFT JOIN clients c ON c.phone = b.client_phone
      WHERE b.date_str = $1
      ORDER BY b.time_str ASC
    `, [today]);
    res.json({ today, bookings: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Consultas de color pendientes
app.get('/staff/color-consultas', staffAuth, async (req, res) => {
  try {
    const r = await getConn().query(`
      SELECT id, booking_code as code, client_name as nombre, client_phone as phone,
             service as servicio, date_str as fecha, time_str as hora,
             status as estado, monto, created_at, notes
      FROM bookings WHERE status = 'Consulta Pendiente'
      ORDER BY created_at DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Crear turno manualmente
app.post('/staff/booking/create', staffAuth, async (req, res) => {
  try {
    const { nombre, phone, email, servicios, fecha, hora, monto, senaAmount, notas, clientPhone } = req.body;
    if (!nombre || !servicios || !fecha || !hora) return res.status(400).json({ error: 'Faltan campos' });
    const servicioStr = Array.isArray(servicios) ? servicios.join(' + ') : servicios;
    const phoneF = clientPhone || phone || ('manual-' + Date.now());
    const montoFinal = monto || 0;
    const senaFinal = senaAmount || 0;
    // FIX: Solo hacer upsert para clientes NUEVOS (sin clientPhone).
    // Para clientes existentes no pisamos name/last_name con el nombre compuesto.
    if (!clientPhone) {
      // Cliente nuevo: nombre puede venir como "Nombre Apellido" — split inteligente
      const partes = nombre.trim().split(/\s+/);
      const primerNombre = partes[0] || nombre;
      const apellido = partes.length > 1 ? partes.slice(1).join(' ') : null;
      await db.clientUpsert(phoneF, primerNombre, email || null, apellido);
    } else if (email) {
      // Cliente existente: solo actualizar email si se proporcionó uno nuevo
      await getConn().query('UPDATE clients SET email=$1 WHERE phone=$2 AND (email IS NULL OR email=\'\')', [email, phoneF]).catch(()=>{});
    }
    // Si tiene seña → queda pendiente hasta que pague
    const statusInicial = senaFinal > 0 ? 'Seña pendiente' : 'Confirmado';
    const saved = await db.bookingSave({
      sessionId: 'staff-manual',
      nombre, phone: phoneF,
      servicio: servicioStr, fecha, hora,
      monto: montoFinal, senaAmount: senaFinal, senaPaid: false,
      calendarEventId: null, email: email || null, notes: notas || null,
      status: statusInicial,
    });
    const { appendTurnoToSheet } = require('./core/sheets');
    await appendTurnoToSheet({ code: saved.code, fecha, hora, nombre, phone: phoneF, servicio: servicioStr, monto: montoFinal, sena: senaFinal, senaPagada: false, estado: statusInicial, canal: 'Staff Manual' }).catch(() => {});

    // FIX: Calendar y mail solo si NO hay seña pendiente
    if (senaFinal === 0) {
      // Calendar
      try {
        const cal = require('./core/calendar');
        const eventId = await cal.createEvent({ nombre, servicio: servicioStr, fecha, hora, phone: phoneF, code: saved.code, monto: montoFinal });
        if (eventId) await getConn().query('UPDATE bookings SET calendar_event_id=$1 WHERE id=$2', [eventId, saved.id]).catch(()=>{});
      } catch(ce) { console.error('[staff] calendar error:', ce.message); }

      // Email confirmación — solo turnos sin seña
      const emailFinal = email || await getConn().query('SELECT email FROM clients WHERE phone=$1',[phoneF]).then(r=>r.rows[0]?.email).catch(()=>null);
      if (emailFinal) {
        try {
          const { mailTurnoConfirmado } = require('./agents/mailer');
          await mailTurnoConfirmado({ to: emailFinal, nombre, servicio: servicioStr, fecha, hora, code: saved.code, monto: montoFinal, senaAmount: 0, senaPaid: false });
          console.log(`[staff] ✓ Mail confirmación → ${emailFinal}`);
        } catch(me) { console.error('[staff] mail error:', me.message); }
      } else {
        console.log(`[staff] ⚠ Sin email para ${phoneF} — no se envió confirmación`);
      }
    } else {
      console.log(`[staff] ℹ Turno con seña pendiente — mail y calendario se activarán al recibir el pago (booking ${saved.id})`);
    }

    res.json({ ok: true, code: saved.code, id: saved.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buscar TURNOS para panel de cobro (por código, nombre o teléfono)
app.get('/staff/bookings/search', staffAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const term = q.toLowerCase();
    const r = await getConn().query(`
      SELECT b.id, b.booking_code, b.client_name, b.client_phone,
             b.service, b.date_str, b.time_str, b.monto, b.status,
             b.sena_amount, b.sena_paid,
             COALESCE(b.email, c.email) AS email
      FROM bookings b
      LEFT JOIN clients c ON c.phone = b.client_phone
      WHERE b.status NOT IN ('Cancelado','Completado')
        AND (
          LOWER(b.booking_code) LIKE $1
          OR LOWER(b.client_name) LIKE $1
          OR b.client_phone LIKE $1
        )
      ORDER BY b.created_at DESC
      LIMIT 10
    `, ['%' + term + '%']);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buscar cliente por nombre/phone para autocompletar
app.get('/staff/clients/search', staffAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const r = await getConn().query(`
      SELECT phone, name, last_name, email, visit_count, points
      FROM clients
      WHERE LOWER(name) LIKE $1 OR LOWER(last_name) LIKE $1 OR phone LIKE $1 OR LOWER(email) LIKE $1
      ORDER BY visit_count DESC LIMIT 8
    `, ['%' + q.toLowerCase() + '%']);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Generar link de pago Mercado Pago
app.post('/staff/mp/crear-link', staffAuth, async (req, res) => {
  try {
    const { bookingId, monto, descripcion, nombre, email } = req.body;
    if (!monto || !descripcion) return res.status(400).json({ error: 'Faltan monto y descripción' });
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_ACCESS_TOKEN) return res.status(400).json({ error: 'MP_ACCESS_TOKEN no configurado en env vars' });
    
    const axios = require('axios');
    const payload = {
      items: [{
        title: descripcion,
        unit_price: Number(monto),
        quantity: 1,
        currency_id: 'ARS'
      }],
      payer: { name: nombre || 'Clienta', email: email || undefined },
      statement_descriptor: 'Estefan Peluquería',
      external_reference: bookingId ? String(bookingId) : undefined,
      notification_url: `https://peluqueria-bot.onrender.com/mp/webhook`,
      back_urls: {
        success: `https://peluqueria-bot.onrender.com/mp/success`,
        failure: `https://peluqueria-bot.onrender.com/mp/failure`,
      },
      auto_return: 'approved'
    };

    const mpRes = await axios.post('https://api.mercadopago.com/checkout/preferences', payload, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });

    const link = mpRes.data.init_point;
    const prefId = mpRes.data.id;

    // Guardar link en el booking
    if (bookingId) {
      await getConn().query('UPDATE bookings SET mp_payment_link = $1, mp_payment_id = $2, sena_amount = $3 WHERE id = $4',
        [link, prefId, monto, bookingId]).catch(() => {});
    }

    console.log(`[mp] ✓ Link creado: ${link.substring(0,60)}...`);
    res.json({ ok: true, link, prefId });
  } catch(e) {
    console.error('[mp] Error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// Webhook de Mercado Pago — notificación de pago
app.post('/mp/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('[mp] webhook:', type, data?.id);
    if (type === 'payment' && data?.id) {
      const axios = require('axios');
      const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
      const payment = await axios.get(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
      });
      const p = payment.data;
      if (p.status === 'approved') {
        const bookingId = p.external_reference;
        // ── Cobro de caja pendiente (external_reference = "cobro:ID") ─────────
        if (typeof bookingId === 'string' && bookingId.startsWith('cobro:')) {
          const cobroId = bookingId.replace('cobro:', '');
          const dbConn = getConn();

          // Marcar cobro como pagado
          await dbConn.query(
            `UPDATE payments SET status='paid', medio_pago='Mercado Pago' WHERE id=$1`,
            [cobroId]
          ).catch(()=>{});

          // Marcar turno como Completado si había booking_id
          const cobroR = await dbConn.query(
            `SELECT p.*, b.date_str, b.time_str, b.service
             FROM payments p
             LEFT JOIN bookings b ON b.id = p.booking_id
             WHERE p.id = $1`, [cobroId]
          );
          const cobro = cobroR.rows[0];
          if (cobro) {
            if (cobro.booking_id) {
              await dbConn.query(`UPDATE bookings SET status='Completado' WHERE id=$1`, [cobro.booking_id]).catch(()=>{});
            }
            // Actualizar total_spent
            if (cobro.client_phone) {
              await dbConn.query(
                `UPDATE clients SET total_spent=COALESCE(total_spent,0)+$1, visit_count=COALESCE(visit_count,0)+1, last_visit=NOW() WHERE phone=$2`,
                [cobro.total, cobro.client_phone]
              ).catch(()=>{});
            }
            // Puntos
            const pointsEarned = cobro.total_servicios > 0 ? Math.floor(cobro.total_servicios / 1000) : 0;
            if (pointsEarned > 0 && cobro.client_phone) {
              await dbConn.query(
                `UPDATE clients SET points=COALESCE(points,0)+$1 WHERE phone=$2`,
                [pointsEarned, cobro.client_phone]
              ).catch(()=>{});
            }
            // Emitir comprobante por mail
            if (cobro.email) {
              try {
                const { mailComprobante } = require('./agents/mailer');
                const servicios = JSON.parse(cobro.servicios_json || '[]');
                const productos = JSON.parse(cobro.productos_json || '[]');
                await mailComprobante({
                  to: cobro.email, nombre: cobro.client_name,
                  numero: cobro.numero_comprobante,
                  servicios, productos,
                  totalServicios: cobro.total_servicios,
                  totalProductos: cobro.total_productos,
                  descuento: cobro.descuento, total: cobro.total,
                  medioPago: 'Mercado Pago', pointsEarned,
                  senaPagada: 0,
                });
                console.log(`[mp] ✓ Comprobante cobro enviado a ${cobro.email}`);
              } catch(me) { console.error('[mp] comprobante mail error:', me.message); }
            }
            console.log(`[mp] ✓ Cobro caja ${cobroId} pagado vía MP`);
          }
          res.sendStatus(200); return;
        }

        // ── Seña de turno (external_reference = bookingId numérico) ──────────
        if (bookingId) {
          await getConn().query('UPDATE bookings SET sena_paid = true, status = $1 WHERE id = $2', ['Seña pagada', bookingId]).catch(() => {});
          const { updateTurnoStatus } = require('./core/sheets');
          const b = await getConn().query(
            `SELECT b.id, b.booking_code, b.service, b.date_str, b.time_str,
                    b.monto, b.sena_amount, b.client_phone, b.client_name, b.calendar_event_id,
                    COALESCE(b.email, c.email) AS email
             FROM bookings b
             LEFT JOIN clients c ON c.phone = b.client_phone
             WHERE b.id = $1`, [bookingId]
          );
          const bk = b.rows[0];
          if (bk) {
            await updateTurnoStatus(bk.booking_code, bk.service, 'Seña pagada').catch(() => {});

            // ── Agregar al calendario (si no estaba ya) ────────────────────
            if (!bk.calendar_event_id) {
              try {
                const cal = require('./core/calendar');
                const eventId = await cal.createEvent({
                  nombre: bk.client_name, servicio: bk.service,
                  fecha: bk.date_str, hora: bk.time_str,
                  phone: bk.client_phone, code: bk.booking_code, monto: bk.monto
                });
                if (eventId) await getConn().query('UPDATE bookings SET calendar_event_id=$1 WHERE id=$2', [eventId, bk.id]).catch(()=>{});
                console.log(`[mp] ✓ Calendario creado para booking ${bookingId}`);
              } catch(ce) { console.error('[mp] calendar error:', ce.message); }
            }

            // ── Enviar mail de confirmación ────────────────────────────────
            if (bk.email) {
              try {
                const { mailTurnoConfirmado } = require('./agents/mailer');
                await mailTurnoConfirmado({
                  to: bk.email, nombre: bk.client_name, servicio: bk.service,
                  fecha: bk.date_str, hora: bk.time_str, code: bk.booking_code,
                  monto: bk.monto, senaAmount: bk.sena_amount, senaPaid: true
                });
                console.log(`[mp] ✓ Mail confirmación enviado a ${bk.email}`);
              } catch(me) { console.error('[mp] mail error:', me.message); }
            }
          }
          console.log(`[mp] ✓ Seña pagada booking ${bookingId}`);
        }
      }
    }
    res.sendStatus(200);
  } catch(e) { console.error('[mp] webhook error:', e.message); res.sendStatus(200); }
});

app.get('/mp/success', (req, res) => res.send('<h2 style="font-family:sans-serif;text-align:center;padding:40px">✅ ¡Pago recibido! Gracias por tu seña 💛<br><br>El equipo de Estefan te contactará para confirmar tu turno.</h2>'));
app.get('/mp/failure', (req, res) => res.send('<h2 style="font-family:sans-serif;text-align:center;padding:40px">❌ Hubo un problema con el pago. Escribinos al salón y te ayudamos 💛</h2>'));

// Actualizar estado de turno — con email automático
app.put('/staff/booking/:id/status', staffAuth, async (req, res) => {
  try {
    const { status, motivo } = req.body;
    const validStatuses = ['Confirmado','Seña pagada','Seña pendiente','Cancelado','Completado','Consulta Pendiente','Reprogramado','No asistió','Solicitud cliente'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Estado inválido' });
    await getConn().query('UPDATE bookings SET status = $1 WHERE id = $2', [status, req.params.id]);

    // Traer datos completos del turno — email desde booking o desde clients
    const bk = await getBookingWithEmail(req.params.id);

    // Sheets sync
    if (bk) {
      const { updateTurnoStatus } = require('./core/sheets');
      await updateTurnoStatus(bk.booking_code, bk.service, status).catch(() => {});
    }

    // Email al cliente según el nuevo estado
    if (bk?.email) {
      const { mailTurnoConfirmado, mailTurnoCancelado, mailTurnoModificado } = require('./agents/mailer');
      const params = {
        to: bk.email, nombre: bk.client_name, servicio: bk.service,
        fecha: bk.date_str, hora: bk.time_str, code: bk.booking_code,
        monto: bk.monto, motivo: motivo || ''
      };
      if (status === 'Confirmado') {
        await mailTurnoConfirmado(params).catch(e => console.error('[staff] mail confirm error:', e.message));
        console.log(`[staff] ✓ Mail confirmación → ${bk.email}`);
      } else if (status === 'Cancelado') {
        await mailTurnoCancelado(params).catch(e => console.error('[staff] mail cancel error:', e.message));
        console.log(`[staff] ✓ Mail cancelación → ${bk.email}`);
      }
    }

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reprogramar turno — con email automático
app.put('/staff/booking/:id/reschedule', staffAuth, async (req, res) => {
  try {
    const { fecha, hora, motivo } = req.body;
    if (!fecha || !hora) return res.status(400).json({ error: 'Faltan fecha/hora' });
    await getConn().query(
      "UPDATE bookings SET date_str = $1, time_str = $2, status = 'Reprogramado' WHERE id = $3",
      [fecha, hora, req.params.id]
    );
    const bk = await getBookingWithEmail(req.params.id);
    if (bk) {
      const { updateTurnoStatus } = require('./core/sheets');
      await updateTurnoStatus(bk.booking_code, bk.service, 'Reprogramado').catch(() => {});
      console.log(`[reschedule] bk found: ${!!bk} | email: ${bk?.email||'NONE'} | phone: ${bk?.client_phone}`);
      if (bk.email) {
        const { mailTurnoModificado } = require('./agents/mailer');
        try {
          await mailTurnoModificado({
            to: bk.email, nombre: bk.client_name, servicio: bk.service,
            fechaAnterior: bk.date_str, horaAnterior: bk.time_str,
            fechaNueva: fecha, horaNueva: hora,
            code: bk.booking_code, monto: bk.monto, motivo: motivo || ''
          });
          console.log(`[staff] ✓ Mail reprogramación → ${bk.email}`);
        } catch(mailErr) {
          console.error(`[staff] ✗ Mail reschedule FAILED: ${mailErr.message}`);
        }
      } else {
        console.warn(`[reschedule] ⚠️ Sin email para booking ${req.params.id} — phone=${bk?.client_phone} — mail NO enviado`);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clientes — lista completa
app.get('/staff/clients', staffAuth, async (req, res) => {
  try {
    const r = await getConn().query(`
      SELECT phone, name, last_name, email, visit_count, total_spent,
             last_visit, points, promo_opt_in, profile_complete, created_at
      FROM clients ORDER BY visit_count DESC, created_at DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cliente — detalle con turnos
app.get('/staff/clients/:phone', staffAuth, async (req, res) => {
  try {
    const client = await db.clientGet(req.params.phone);
    const bookings = await getConn().query(`
      SELECT id, booking_code, service, date_str, time_str, status, monto, created_at
      FROM bookings WHERE client_phone = $1 ORDER BY created_at DESC
    `, [req.params.phone]);
    res.json({ client, bookings: bookings.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Actualizar cliente — y propagar email a todos sus bookings
app.put('/staff/clients/:phone', staffAuth, async (req, res) => {
  try {
    const { name, lastName, email } = req.body;
    const phone = req.params.phone;

    // Update clients table
    await getConn().query(
      `UPDATE clients SET name=$1, last_name=$2, email=$3, updated_at=NOW() WHERE phone=$4`,
      [name, lastName, email || null, phone]
    );

    // Propagate email to all bookings for this client (so mails work even for old bookings)
    if (email) {
      const updated = await getConn().query(
        `UPDATE bookings SET email=$1 WHERE client_phone=$2 AND (email IS NULL OR email='') RETURNING id`,
        [email, phone]
      );
      console.log(`[staff] ✓ Email propagado a ${updated.rowCount} bookings de ${phone}`);
    }

    const { syncClientesToSheet } = require('./core/sheets');
    syncClientesToSheet().catch(() => {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sync email desde clients → bookings para todos (util para datos viejos)
app.post('/admin/sync-emails', adminAuth, async (req, res) => {
  try {
    const r = await getConn().query(`
      UPDATE bookings b
      SET email = c.email
      FROM clients c
      WHERE c.phone = b.client_phone
        AND c.email IS NOT NULL AND c.email != ''
        AND (b.email IS NULL OR b.email = '')
      RETURNING b.id
    `);
    res.json({ ok: true, updated: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Confirmar consulta de color — crear turno + email
app.post('/staff/color-consultas/:id/confirmar', staffAuth, async (req, res) => {
  try {
    const { fecha, hora, notas } = req.body;
    await getConn().query(
      "UPDATE bookings SET status = 'Confirmado', date_str = $1, time_str = $2, notes = $3 WHERE id = $4",
      [fecha, hora, notas || '', req.params.id]
    );
    const row = await getBookingWithEmail(req.params.id);
    if (row) {
      // Sheets
      const { appendTurnoToSheet } = require('./core/sheets');
      await appendTurnoToSheet({
        code: row.booking_code, fecha, hora, nombre: row.client_name,
        phone: row.client_phone, servicio: row.service, monto: row.monto,
        sena: null, senaPagada: false, estado: 'Confirmado', canal: 'Staff'
      }).catch(() => {});

      // Email confirmación al cliente
      if (row.email) {
        const { mailTurnoConfirmado } = require('./agents/mailer');
        const senaAmt = row.sena_amount || Math.round((row.monto || 0) * 0.15);
        await mailTurnoConfirmado({
          to: row.email, nombre: row.client_name, servicio: row.service,
          fecha, hora, code: row.booking_code,
          monto: row.monto, senaAmount: senaAmt, senaPaid: false
        }).catch(e => console.error('[staff] mail color confirm error:', e.message));
        console.log(`[staff] ✓ Mail confirmación color → ${row.email}`);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Portal staff — sirve el HTML
app.get('/staff', (req, res) => {
  res.sendFile(__dirname + '/staff-portal.html');
});

app.get('/health', async (req, res) => {
  const dbConn = db.getDB();
  const sessions = getAllSessions();
  res.json({
    status: 'ok',
    db: !!dbConn,
    sessions: sessions.length,
    uptime: Math.round(process.uptime()) + 's',
  });
});

app.get('/', (req, res) => res.send('Estefan Peluquería Bot v4 ✂️ — running'));

// ── TEST CHAT (accesible desde cualquier browser) ─────────────────────────────
app.get('/test', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Estefan — Test Chat</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f0f0f0;display:flex;justify-content:center;align-items:center;min-height:100vh}
.container{width:100%;max-width:420px;height:100vh;max-height:700px;background:white;border-radius:16px;box-shadow:0 4px 30px rgba(0,0,0,.15);display:flex;flex-direction:column;overflow:hidden}
.header{background:#1a1a2e;color:white;padding:16px 20px;display:flex;align-items:center;gap:12px}
.avatar{width:40px;height:40px;background:#e91e8c;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px}
.header-info h3{font-size:15px}.header-info p{font-size:12px;color:#aaa}
.messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:82%;padding:10px 14px;border-radius:18px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
.msg.bot{background:#f0f0f0;align-self:flex-start;border-bottom-left-radius:4px}
.msg.user{background:#e91e8c;color:white;align-self:flex-end;border-bottom-right-radius:4px}
.msg.system{background:#fff3cd;color:#856404;align-self:center;font-size:12px;border-radius:8px;text-align:center;max-width:90%}
.input-area{padding:12px 16px;border-top:1px solid #eee;display:flex;gap:8px}
input{flex:1;border:1px solid #ddd;border-radius:24px;padding:10px 16px;font-size:14px;outline:none}
input:focus{border-color:#e91e8c}
button{background:#e91e8c;color:white;border:none;border-radius:50%;width:42px;height:42px;font-size:18px;cursor:pointer;flex-shrink:0}
.typing{display:none;align-self:flex-start;background:#f0f0f0;border-radius:18px;border-bottom-left-radius:4px;padding:12px 16px}
.typing span{width:8px;height:8px;background:#999;border-radius:50%;display:inline-block;margin:0 2px;animation:bounce 1.2s infinite}
.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="avatar">✂️</div>
    <div class="header-info"><h3>Estefan Peluquería</h3><p>Asistente virtual — modo test</p></div>
  </div>
  <div class="messages" id="messages"><div class="msg system">— Conectando... —</div></div>
  <div class="typing" id="typing"><span></span><span></span><span></span></div>
  <div class="input-area">
    <input id="input" placeholder="Escribí tu mensaje..." autocomplete="off"/>
    <button onclick="sendMsg()">➤</button>
  </div>
</div>
<script>
let sessionId=null;
async function init(){
  try{
    const r=await fetch('/chat/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:'web-'+Math.random().toString(36).slice(2,8)})});
    const d=await r.json();sessionId=d.sessionId;
    document.getElementById('messages').innerHTML='';
    if(d.message)addMsg(d.message,'bot');
  }catch(e){addMsg('No se pudo conectar 😅','system');}
}
async function sendMsg(){
  const inp=document.getElementById('input');
  const text=inp.value.trim();if(!text||!sessionId)return;
  inp.value='';addMsg(text,'user');showTyping(true);
  try{
    const r=await fetch('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,text})});
    const d=await r.json();showTyping(false);
    if(d.reply)addMsg(d.reply,'bot');
  }catch(e){showTyping(false);addMsg('Error 😅','system');}
}
function addMsg(text,type){
  const d=document.createElement('div');d.className='msg '+type;d.textContent=text;
  const m=document.getElementById('messages');m.appendChild(d);m.scrollTop=m.scrollHeight;
}
function showTyping(s){
  document.getElementById('typing').style.display=s?'flex':'none';
  if(s)document.getElementById('messages').scrollTop=9999;
}
document.getElementById('input').addEventListener('keydown',e=>{if(e.key==='Enter')sendMsg();});
init();
</script>
</body>
</html>`);
});


// ── PORTAL CLIENTE: SOLICITAR TURNO ──────────────────────────────────────────
const SERVICIOS_CON_APROBACION = ['color','balayage','decoloración','mechas','keratina','alisado','quimico','química','permanente','ondas'];

app.post('/cliente/solicitar-turno', clientAuth, async (req, res) => {
  try {
    const phone = req.clientPhone;
    const { servicio, fecha_tentativa, hora_tentativa, notas, fotos_urls } = req.body;
    if (!servicio) return res.status(400).json({ error: 'Servicio requerido' });

    const dbConn = db.getDB();
    const clientR = await dbConn.query(`SELECT name, last_name, email FROM clients WHERE phone=$1`, [phone]);
    const client = clientR.rows[0] || {};
    const nombre = ((client.name||'') + ' ' + (client.last_name||'')).trim() || phone;

    const necesitaAprobacion = SERVICIOS_CON_APROBACION.some(s => servicio.toLowerCase().includes(s));
    const statusInicial = necesitaAprobacion ? 'Consulta Pendiente' : 'Solicitud cliente';

    let notaCompleta = `[Solicitud portal cliente]`;
    if (notas) notaCompleta += `
Nota: ${notas}`;
    if (fecha_tentativa) notaCompleta += `
Fecha tentativa: ${fecha_tentativa}`;
    if (hora_tentativa) notaCompleta += `
Horario preferido: ${hora_tentativa}`;
    if (fotos_urls && fotos_urls.length) notaCompleta += `
Fotos: ${fotos_urls.join(', ')}`;

    const saved = await db.bookingSave({
      sessionId: 'portal-cliente',
      nombre, phone,
      servicio, fecha: fecha_tentativa || 'A confirmar',
      hora: hora_tentativa || 'A confirmar',
      monto: 0, senaAmount: 0, senaPaid: false,
      calendarEventId: null, email: client.email || null,
      notes: notaCompleta,
      status: statusInicial,
    });

    await dbConn.query(
      `INSERT INTO client_notes (client_phone, type, content, created_by) VALUES ($1,'solicitud',$2,'cliente')`,
      [phone, `Solicitud turno: ${servicio}${fecha_tentativa ? ' — '+fecha_tentativa : ''}${hora_tentativa ? ' '+hora_tentativa : ''}.${notas ? ' '+notas : ''}`]
    );

    const staffPhone = process.env.STAFF_WHATSAPP_PHONE;
    if (staffPhone && WASSENGER_KEY) {
      const msg = `📲 *Nueva solicitud portal*\n\n*Cliente:* ${nombre}\n*Servicio:* ${servicio}\n*Fecha:* ${fecha_tentativa || 'No especificó'}\n*Horario:* ${hora_tentativa || 'No especificó'}${notas ? '\n*Nota:* '+notas : ''}${necesitaAprobacion ? '\n⚠️ Requiere evaluación' : ''}`;
      sendWhatsApp(staffPhone, msg).catch(() => {});
    }

    res.json({
      ok: true, code: saved.code, status: statusInicial, necesitaAprobacion,
      message: necesitaAprobacion
        ? 'Tu solicitud fue recibida. Te contactaremos para confirmar el turno.'
        : 'Tu solicitud fue recibida. El staff la confirmará pronto.',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BOT: CONTEXTO ENRIQUECIDO ─────────────────────────────────────────────────
app.get('/staff/clients/:phone/contexto-bot', staffAuth, async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const dbConn = db.getDB();
    const [clientR, bookingsR, cobrosR, fichaR] = await Promise.all([
      dbConn.query(`SELECT phone, name, last_name, email, visit_count, points, total_spent FROM clients WHERE phone=$1`, [phone]),
      dbConn.query(`SELECT service, date_str, time_str, status, monto FROM bookings WHERE client_phone=$1 ORDER BY created_at DESC LIMIT 5`, [phone]),
      dbConn.query(`SELECT fecha, total, servicios_json FROM payments WHERE client_phone=$1 ORDER BY created_at DESC LIMIT 3`, [phone]),
      dbConn.query(`SELECT color_actual, tecnica, alergias, observaciones FROM client_ficha WHERE client_phone=$1`, [phone]),
    ]);
    const client = clientR.rows[0];
    if (!client) return res.json({ found: false });
    const proximos = bookingsR.rows.filter(b => !['Cancelado','Completado'].includes(b.status));
    const pasados  = bookingsR.rows.filter(b => b.status === 'Completado');
    res.json({
      found: true,
      nombre: ((client.name||'') + ' ' + (client.last_name||'')).trim(),
      visitas: client.visit_count || 0,
      puntos: client.points || 0,
      totalGastado: client.total_spent || 0,
      proximosTurnos: proximos.map(b => `${b.service} el ${b.date_str} a las ${b.time_str} (${b.status})`),
      historial: pasados.map(b => `${b.service} el ${b.date_str}`),
      ficha: fichaR.rows[0] || null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  console.log('\n✂️  Estefan Peluquería Bot v4');

  // 1. DB
  const dbConn = await db.initDB();

  // Migraciones — columnas opcionales que pueden no existir en instancias antiguas
  if (dbConn) {
    const migrations = [
      `ALTER TABLE payments ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'paid'`,
      `ALTER TABLE payments ADD COLUMN IF NOT EXISTS mp_payment_link TEXT`,
    ];
    for (const m of migrations) {
      await dbConn.query(m).catch(e => console.log('[migration] skipped:', e.message));
    }
  }

  // 2. Google tokens desde DB
  if (dbConn) {
    const tokens = await db.configGet('google_tokens');
    if (tokens) {
      calendar.setGoogleTokens(JSON.parse(tokens));
      console.log('   Google OAuth: ✓ tokens cargados');
    } else {
      console.log('   Google OAuth: ⚠ pendiente — visitá /auth');
    }
  }

  // 3. Sheets
  sheets.init({
    getServiceAccountToken: () => calendar.getServiceAccountToken(),
    getDB: () => db.getDB(),
  });
  setTimeout(async () => {
    try { await sheets.initSheets(); }
    catch(e) { console.error('[sheets] Error init:', e.message); }
  }, 3000);

  // 4. Servidor
  app.listen(PORT, () => {
    console.log(`   Puerto: ${PORT}`);
    console.log(`   Wassenger: ${WASSENGER_KEY ? '✓' : '✗ sin key'}`);
    console.log(`   DB: ${dbConn ? '✓' : '✗ sin conexión'}`);
    console.log(`   URL: https://peluqueria-bot.onrender.com\n`);
  });
}

init().catch(console.error);

// ── PAYMENTS / COBROS ─────────────────────────────────────────────────────────

// Listar empleados
app.get('/staff/empleados', staffAuth, async (req, res) => {
  try {
    const r = await getConn().query(`SELECT id, nombre, activo FROM empleados WHERE activo = true ORDER BY nombre ASC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listar productos
app.get('/staff/productos', staffAuth, async (req, res) => {
  try {
    const r = await getConn().query(`SELECT id, nombre, precio, categoria, comision_pct FROM productos WHERE activo = true ORDER BY categoria, nombre`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Crear cobro / comprobante
// Generar link MP para cobro en caja — comprobante se emite al recibir el pago
app.post('/staff/cobros/mp-link', staffAuth, async (req, res) => {
  try {
    const { booking_id, client_phone, client_name, empleado_id, servicios,
            productos, descuento, notas, email, sena_pagada, monto } = req.body;
    const axios = require('axios');
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN no configurado' });

    // Guardar datos del cobro pendiente en DB para emitirlo al recibir el pago
    const dbConn = getConn();
    const totalServicios = (servicios||[]).reduce((s,x) => s+(x.monto||0), 0);
    const totalProductos = (productos||[]).reduce((s,x) => s+(x.precio*x.cantidad), 0);
    const descuentoAmt   = descuento || 0;
    const total          = monto || (totalServicios + totalProductos - descuentoAmt);

    // Guardar cobro_pendiente en tabla payments con status='mp_pending'
    const r = await dbConn.query(`
      INSERT INTO payments
        (booking_id, client_phone, client_name, empleado_id, medio_pago,
         servicios_json, productos_json, total_servicios, total_productos,
         descuento, total, notas, email, fecha_str, status)
      VALUES ($1,$2,$3,$4,'Mercado Pago',$5,$6,$7,$8,$9,$10,$11,$12,
              TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY'),
              'mp_pending')
      RETURNING id, numero_comprobante
    `, [
      booking_id||null, client_phone||null, client_name||'',
      empleado_id||null,
      JSON.stringify(servicios||[]), JSON.stringify(productos||[]),
      totalServicios, totalProductos, descuentoAmt, total, notas||null, email||null
    ]);
    const cobro = r.rows[0];

    // Generar preferencia MP
    const payload = {
      items: [{ title: `Pago en salón — Estefan Peluquería`, quantity: 1, unit_price: total, currency_id: 'ARS' }],
      payer: { name: client_name },
      external_reference: `cobro:${cobro.id}`,
      back_urls: {
        success: 'https://peluqueria-bot.onrender.com/mp/success',
        failure: 'https://peluqueria-bot.onrender.com/mp/failure',
      },
      auto_return: 'approved',
      notification_url: 'https://peluqueria-bot.onrender.com/mp/webhook',
    };
    const mpRes = await axios.post('https://api.mercadopago.com/checkout/preferences', payload, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
    const mpUrl = mpRes.data?.init_point;
    if (!mpUrl) return res.status(500).json({ error: 'MP no devolvió URL' });

    // Guardar el link en el cobro
    await dbConn.query('UPDATE payments SET mp_payment_link=$1 WHERE id=$2', [mpUrl, cobro.id]).catch(()=>{});

    console.log(`[cobros-mp] ✓ Link generado cobro_id=${cobro.id} → ${mpUrl}`);
    res.json({ ok: true, url: mpUrl, cobro_id: cobro.id });
  } catch(e) { console.error('[cobros-mp] error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/staff/cobros', staffAuth, async (req, res) => {
  try {
    const { booking_id, client_phone, client_name, empleado_id, medio_pago,
            servicios, productos, descuento, notas, email, sena_pagada } = req.body;

    const dbConn = getConn();

    // Calcular totales
    const totalServicios = (servicios||[]).reduce((s,x) => s + (x.monto||0), 0);
    const totalProductos = (productos||[]).reduce((s,x) => s + (x.precio * x.cantidad), 0);
    const descuentoAmt   = descuento || 0;
    const total          = totalServicios + totalProductos - descuentoAmt;

    // Insertar cobro
    const r = await dbConn.query(`
      INSERT INTO payments
        (booking_id, client_phone, client_name, empleado_id, medio_pago,
         servicios_json, productos_json, total_servicios, total_productos,
         descuento, total, notas, email, fecha_str)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
              TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY'))
      RETURNING id, numero_comprobante
    `, [
      booking_id||null, client_phone||null, client_name||'',
      empleado_id||null, medio_pago||'Efectivo',
      JSON.stringify(servicios||[]), JSON.stringify(productos||[]),
      totalServicios, totalProductos,
      descuentoAmt, total, notas||null, email||null
    ]);

    const cobro = r.rows[0];

    // Marcar turno como Completado
    if (booking_id) {
      await dbConn.query(`UPDATE bookings SET status = 'Completado' WHERE id = $1`, [booking_id]).catch(()=>{});
    }

    // Actualizar total_spent del cliente
    if (client_phone) {
      await dbConn.query(
        `UPDATE clients SET total_spent = COALESCE(total_spent,0) + $1 WHERE phone = $2`,
        [total, client_phone]
      ).catch(()=>{});
    }

    // Calcular comisiones de productos
    if ((productos||[]).length && empleado_id) {
      for (const p of productos) {
        if (!p.comision_pct) continue;
        const comision = Math.round(p.precio * p.cantidad * p.comision_pct / 100);
        await dbConn.query(`
          INSERT INTO comisiones (empleado_id, payment_id, producto_id, monto, descripcion, fecha_str)
          VALUES ($1,$2,$3,$4,$5, TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY'))
        `, [empleado_id, cobro.id, p.id||null, comision,
            `${p.nombre} x${p.cantidad}`]).catch(()=>{});
      }
    }

    // Puntos ganados + visit_count (solo al cobrar)
    let pointsEarned = 0;
    if (client_phone) {
      // Incrementar visitas al momento de cobrar
      await dbConn.query(
        `UPDATE clients SET visit_count = COALESCE(visit_count,0) + 1, last_visit = NOW() WHERE phone = $1`,
        [client_phone]
      ).catch(() => {});

      if (totalServicios > 0) {
        pointsEarned = Math.floor(totalServicios / 1000);
        if (pointsEarned > 0) {
          await dbConn.query(
            `UPDATE clients SET points = COALESCE(points,0) + $1 WHERE phone = $2`,
            [pointsEarned, client_phone]
          ).catch(() => {});
          await dbConn.query(
            `INSERT INTO loyalty_transactions (phone, type, points, description)
             VALUES ($1,'earn',$2,$3)`,
            [client_phone, pointsEarned, `Cobro #${cobro.numero_comprobante}`]
          ).catch(() => {});
        }
      }
    }

    // Email comprobante
    if (email) {
      try {
        const { mailComprobante } = require('./agents/mailer');
        await mailComprobante({
          to: email, nombre: client_name, numero: cobro.numero_comprobante,
          servicios: servicios||[], productos: productos||[],
          totalServicios, totalProductos, descuento: descuentoAmt, total,
          medioPago: medio_pago, pointsEarned,
          senaPagada: sena_pagada || 0,
        });
        console.log(`[cobros] ✓ Comprobante email → ${email}`);
      } catch(me) { console.error('[cobros] mail error:', me.message); }
    }

    console.log(`[cobros] ✓ Cobro #${cobro.numero_comprobante} | $${total} | ${medio_pago} | ${client_name}`);
    res.json({ ok: true, id: cobro.id, numero: cobro.numero_comprobante, total, pointsEarned });
  } catch(e) {
    console.error('[cobros] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Historial de cobros
app.get('/staff/cobros', staffAuth, async (req, res) => {
  try {
    const r = await getConn().query(`
      SELECT p.id, p.numero_comprobante as numero, p.client_name as nombre,
             p.client_phone as phone, p.medio_pago, p.total, p.descuento,
             p.total_servicios, p.total_productos, p.fecha_str as fecha,
             p.servicios_json, p.productos_json, p.created_at, e.nombre as empleado
      FROM payments p
      LEFT JOIN empleados e ON e.id = p.empleado_id
      ORDER BY p.created_at DESC LIMIT 100
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Detalle de un cobro (para reimprimir comprobante)
app.get('/staff/cobros/:id', staffAuth, async (req, res) => {
  try {
    const r = await getConn().query(`
      SELECT p.*, e.nombre as empleado_nombre
      FROM payments p
      LEFT JOIN empleados e ON e.id = p.empleado_id
      WHERE p.id = $1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const cobro = r.rows[0];
    cobro.servicios_json = JSON.parse(cobro.servicios_json||'[]');
    cobro.productos_json = JSON.parse(cobro.productos_json||'[]');
    res.json(cobro);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Historial de comisiones por empleado
app.get('/staff/comisiones', staffAuth, async (req, res) => {
  try {
    const { empleado_id, desde, hasta } = req.query;
    let q = `
      SELECT c.id, e.nombre as empleado, c.monto, c.descripcion, c.fecha_str,
             p.numero_comprobante as comprobante, p.client_name as cliente
      FROM comisiones c
      JOIN empleados e ON e.id = c.empleado_id
      JOIN payments p ON p.id = c.payment_id
      WHERE 1=1
    `;
    const params = [];
    if (empleado_id) { params.push(empleado_id); q += ` AND c.empleado_id = $${params.length}`; }
    q += ` ORDER BY c.created_at DESC LIMIT 200`;
    const r = await getConn().query(q, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CRUD empleados (admin)
app.get('/staff/empleados/todos', adminAuth, async (req, res) => {
  try {
    const r = await getConn().query(`SELECT * FROM empleados ORDER BY nombre`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/staff/empleados', adminAuth, async (req, res) => {
  try {
    const { nombre, rol, comision_servicios_pct } = req.body;
    const r = await getConn().query(
      `INSERT INTO empleados (nombre, rol, comision_servicios_pct) VALUES ($1,$2,$3) RETURNING *`,
      [nombre, rol||'Estilista', comision_servicios_pct||0]
    );
    res.json({ ok: true, empleado: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/staff/empleados/:id', adminAuth, async (req, res) => {
  try {
    const { nombre, rol, activo, comision_servicios_pct } = req.body;
    await getConn().query(
      `UPDATE empleados SET nombre=$1, rol=$2, activo=$3, comision_servicios_pct=$4 WHERE id=$5`,
      [nombre, rol, activo !== false, comision_servicios_pct||0, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CRUD productos (admin)
app.get('/staff/productos/todos', adminAuth, async (req, res) => {
  try {
    const r = await getConn().query(`SELECT * FROM productos ORDER BY categoria, nombre`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/staff/productos', adminAuth, async (req, res) => {
  try {
    const { nombre, precio, categoria, comision_pct } = req.body;
    const r = await getConn().query(
      `INSERT INTO productos (nombre, precio, categoria, comision_pct) VALUES ($1,$2,$3,$4) RETURNING *`,
      [nombre, precio||0, categoria||'General', comision_pct||10]
    );
    res.json({ ok: true, producto: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/staff/productos/:id', adminAuth, async (req, res) => {
  try {
    const { nombre, precio, categoria, comision_pct, activo } = req.body;
    await getConn().query(
      `UPDATE productos SET nombre=$1, precio=$2, categoria=$3, comision_pct=$4, activo=$5 WHERE id=$6`,
      [nombre, precio||0, categoria||'General', comision_pct||10, activo !== false, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════════════════════════
// HISTORIAL + NOTAS + FICHA + PORTAL CLIENTE
// ══════════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// ── Auth middleware para portal del cliente ───────────────────────────────────
async function clientAuth(req, res, next) {
  const token = req.headers['x-client-token'] || req.query.t;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const r = await getConn().query(
      'SELECT client_phone FROM client_tokens WHERE token=$1 AND expires_at > NOW()',
      [token]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Token invalido o expirado' });
    req.clientPhone = r.rows[0].client_phone;
    next();
  } catch(e) { res.status(500).json({ error: e.message }); }
}

// ── Init nuevas tablas ────────────────────────────────────────────────────────
async function initNewTables() {
  const db_conn = getConn();
  await db_conn.query(`
    CREATE TABLE IF NOT EXISTS client_notes (
      id           SERIAL PRIMARY KEY,
      client_phone TEXT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'nota',
      content      TEXT NOT NULL,
      created_by   TEXT DEFAULT 'staff',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db_conn.query(`
    CREATE TABLE IF NOT EXISTS client_ficha (
      id               SERIAL PRIMARY KEY,
      client_phone     TEXT UNIQUE NOT NULL,
      color_actual     TEXT,
      tecnica          TEXT,
      procesos_previos TEXT,
      ultimo_proceso   TEXT,
      alergias         TEXT,
      observaciones    TEXT,
      largo            TEXT,
      textura          TEXT,
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db_conn.query(`
    CREATE TABLE IF NOT EXISTS client_tokens (
      id           SERIAL PRIMARY KEY,
      client_phone TEXT NOT NULL,
      token        TEXT UNIQUE NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db_conn.query('CREATE INDEX IF NOT EXISTS idx_client_tokens_token ON client_tokens(token)');
  await db_conn.query('CREATE INDEX IF NOT EXISTS idx_client_notes_phone  ON client_notes(client_phone)');
  console.log('[init] Nuevas tablas OK');
}
initNewTables().catch(e => console.error('[init] Error nuevas tablas:', e.message));

// ── STAFF: historial completo del cliente ─────────────────────────────────────
app.get('/staff/clients/:phone/historial', staffAuth, async (req, res) => {
  try {
    const phone = req.params.phone;
    const [client, bookings, cobros, notas, ficha] = await Promise.all([
      getConn().query(`SELECT c.*, COALESCE(c.email, '') as email FROM clients c WHERE c.phone = $1`, [phone]).then(r=>r.rows[0]||null),
      getConn().query(`
        SELECT id, booking_code, service, date_str, time_str, status, monto, notes as notas, created_at
        FROM bookings WHERE client_phone=$1 ORDER BY date_str DESC, time_str DESC
      `, [phone]),
      getConn().query(`
        SELECT p.id, p.numero_comprobante as numero, p.fecha_str as fecha,
               p.medio_pago, p.total, p.total_servicios, p.total_productos,
               p.servicios_json, p.productos_json, e.nombre as empleado
        FROM payments p
        LEFT JOIN empleados e ON e.id = p.empleado_id
        WHERE p.client_phone=$1 ORDER BY p.created_at DESC
      `, [phone]),
      getConn().query(`
        SELECT id, type, content, created_by, created_at
        FROM client_notes WHERE client_phone=$1 ORDER BY created_at DESC
      `, [phone]),
      getConn().query('SELECT * FROM client_ficha WHERE client_phone=$1', [phone])
    ]);
    res.json({
      client,
      bookings:  bookings.rows,
      cobros:    cobros.rows,
      notas:     notas.rows,
      ficha:     ficha.rows[0] || null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STAFF: agregar nota ───────────────────────────────────────────────────────
app.post('/staff/clients/:phone/notas', staffAuth, async (req, res) => {
  try {
    const { content, type = 'nota', created_by = 'staff' } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Contenido requerido' });
    const r = await getConn().query(
      'INSERT INTO client_notes (client_phone, type, content, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.phone, type, content.trim(), created_by]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STAFF: borrar nota ────────────────────────────────────────────────────────
app.delete('/staff/clients/:phone/notas/:id', staffAuth, async (req, res) => {
  try {
    await getConn().query(
      'DELETE FROM client_notes WHERE id=$1 AND client_phone=$2',
      [req.params.id, req.params.phone]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STAFF: guardar ficha técnica (upsert) ─────────────────────────────────────
app.put('/staff/clients/:phone/ficha', staffAuth, async (req, res) => {
  try {
    const { color_actual, tecnica, procesos_previos, ultimo_proceso,
            alergias, observaciones, largo, textura } = req.body;
    await getConn().query(`
      INSERT INTO client_ficha
        (client_phone, color_actual, tecnica, procesos_previos, ultimo_proceso,
         alergias, observaciones, largo, textura, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (client_phone) DO UPDATE SET
        color_actual=$2, tecnica=$3, procesos_previos=$4, ultimo_proceso=$5,
        alergias=$6, observaciones=$7, largo=$8, textura=$9, updated_at=NOW()
    `, [req.params.phone, color_actual||null, tecnica||null, procesos_previos||null,
        ultimo_proceso||null, alergias||null, observaciones||null, largo||null, textura||null]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STAFF: generar link para cliente ──────────────────────────────────────────
app.post('/staff/clients/:phone/token', staffAuth, async (req, res) => {
  try {
    const phone   = req.params.phone;
    const token   = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días
    await getConn().query(
      'INSERT INTO client_tokens (client_phone, token, expires_at) VALUES ($1,$2,$3)',
      [phone, token, expires]
    );
    const base = process.env.BASE_URL || 'https://peluqueria-bot.onrender.com';
    res.json({ token, url: base + '/mi-cuenta?t=' + token, expires });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PORTAL CLIENTE — /mi-cuenta
// ══════════════════════════════════════════════════════════════════════════════
app.get('/mi-cuenta', (req, res) => {
  res.sendFile(__dirname + '/client-portal.html');
});

// Perfil + historial del cliente autenticado
app.get('/cliente/perfil', clientAuth, async (req, res) => {
  try {
    const phone = req.clientPhone;
    const [clientRow, bookings, cobros] = await Promise.all([
      db.clientGet(phone),
      getConn().query(`
        SELECT booking_code, service, date_str, time_str, status, monto, notes as notas
        FROM bookings WHERE client_phone=$1 ORDER BY date_str DESC, time_str DESC LIMIT 30
      `, [phone]),
      getConn().query(`
        SELECT p.numero_comprobante as numero, p.fecha_str as fecha,
               p.medio_pago, p.total, p.servicios_json, p.productos_json, e.nombre as empleado
        FROM payments p LEFT JOIN empleados e ON e.id=p.empleado_id
        WHERE p.client_phone=$1 ORDER BY p.created_at DESC LIMIT 10
      `, [phone])
    ]);
    const puntos = {
      points:      clientRow ? clientRow.points      || 0 : 0,
      total_spent: clientRow ? clientRow.total_spent || 0 : 0,
      visit_count: clientRow ? clientRow.visit_count || 0 : 0
    };
    res.json({ client: clientRow, bookings: bookings.rows, cobros: cobros.rows, puntos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// El cliente actualiza sus propios datos
app.put('/cliente/perfil', clientAuth, async (req, res) => {
  try {
    const { name, lastName, email } = req.body;
    const phone = req.clientPhone;
    if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    await getConn().query(
      'UPDATE clients SET name=$1, last_name=$2, email=$3, updated_at=NOW() WHERE phone=$4',
      [name.trim(), lastName?.trim()||null, email?.trim()||null, phone]
    );
    if (email?.trim()) {
      await getConn().query(
        "UPDATE bookings SET email=$1 WHERE client_phone=$2 AND (email IS NULL OR email='')",
        [email.trim(), phone]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// El cliente solicita cancelar o reprogramar un turno
// ── CLIENTE: slots disponibles ───────────────────────────────────────────────
app.get('/cliente/slots', clientAuth, async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
    const parts = fecha.split('/');
    if (parts.length !== 3) return res.status(400).json({ error: 'Formato inválido' });
    const [d, m, y] = parts.map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getDay() === 0) return res.json({ slots: [], motivo: 'Domingo cerrado' });
    const ocupados = await getConn().query(
      "SELECT time_str FROM bookings WHERE date_str=$1 AND status NOT IN ('Cancelado','Reprogramado','cancelled')",
      [fecha]
    );
    const horasOcupadas = new Set(ocupados.rows.map(r => r.time_str));
    const slots = [];
    for (let h = 10; h < 20; h++) {
      for (let min of [0, 30]) {
        const slot = String(h).padStart(2,'0') + ':' + String(min).padStart(2,'0');
        slots.push({ hora: slot, disponible: !horasOcupadas.has(slot) });
      }
    }
    res.json({ slots });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE: cancelar turno ───────────────────────────────────────────────────
app.post('/cliente/cancelar', clientAuth, async (req, res) => {
  try {
    const { booking_code } = req.body;
    const phone = req.clientPhone;
    const bk = await getConn().query(
      'SELECT id, service, date_str, time_str, email, client_name FROM bookings WHERE booking_code=$1 AND client_phone=$2',
      [booking_code, phone]
    );
    if (!bk.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const b = bk.rows[0];
    await getConn().query("UPDATE bookings SET status='Cancelado' WHERE id=$1", [b.id]);
    const { updateTurnoStatus } = require('./core/sheets');
    updateTurnoStatus(booking_code, b.service, 'Cancelado').catch(() => {});
    const clientData = await db.clientGet(phone);
    const nombre = clientData ? ((clientData.name||'')+' '+(clientData.last_name||'')).trim() || b.client_name : b.client_name;
    const emailTo = b.email || clientData?.email;
    if (emailTo) {
      const { mailTurnoCancelado } = require('./agents/mailer');
      mailTurnoCancelado({ to: emailTo, nombre, servicio: b.service, fecha: b.date_str, hora: b.time_str, code: booking_code }).catch(() => {});
    }
    const adminEmail = process.env.GMAIL_USER;
    if (adminEmail) {
      const { mailNotifAdmin } = require('./agents/mailer');
      mailNotifAdmin({
        asunto: '❌ Turno cancelado por cliente',
        html: `<p><b>Cliente:</b> ${nombre}</p><p><b>Servicio:</b> ${b.service}</p><p><b>Fecha:</b> ${b.date_str} ${b.time_str}</p><p><b>Código:</b> #${booking_code}</p>`
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE: reprogramar turno ────────────────────────────────────────────────
app.post('/cliente/reprogramar', clientAuth, async (req, res) => {
  try {
    const { booking_code, fecha_nueva, hora_nueva } = req.body;
    const phone = req.clientPhone;
    if (!fecha_nueva || !hora_nueva) return res.status(400).json({ error: 'Faltan datos' });
    const bk = await getConn().query(
      'SELECT id, service, date_str, time_str, email, client_name, monto FROM bookings WHERE booking_code=$1 AND client_phone=$2',
      [booking_code, phone]
    );
    if (!bk.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const b = bk.rows[0];
    const conflicto = await getConn().query(
      "SELECT id FROM bookings WHERE date_str=$1 AND time_str=$2 AND status NOT IN ('Cancelado','Reprogramado','cancelled') AND id!=$3",
      [fecha_nueva, hora_nueva, b.id]
    );
    if (conflicto.rows.length) return res.status(409).json({ error: 'Ese horario ya no está disponible. Elegí otro.' });
    const fechaAnterior = b.date_str;
    const horaAnterior = b.time_str;
    await getConn().query(
      "UPDATE bookings SET date_str=$1, time_str=$2, status='confirmed' WHERE id=$3",
      [fecha_nueva, hora_nueva, b.id]
    );
    const { updateTurnoStatus } = require('./core/sheets');
    updateTurnoStatus(booking_code, b.service, 'Reprogramado').catch(() => {});
    const clientData = await db.clientGet(phone);
    const nombre = clientData ? ((clientData.name||'')+' '+(clientData.last_name||'')).trim() || b.client_name : b.client_name;
    const emailTo = b.email || clientData?.email;
    const { generateCalendarLink } = require('./core/calendar');
    const calLink = generateCalendarLink(nombre, b.service, fecha_nueva, hora_nueva);
    if (emailTo) {
      const { mailTurnoModificado } = require('./agents/mailer');
      mailTurnoModificado({ to: emailTo, nombre, servicio: b.service, fechaAnterior, horaAnterior, fechaNueva: fecha_nueva, horaNueva: hora_nueva, code: booking_code, calendarLink: calLink, monto: b.monto }).catch(() => {});
    }
    const adminEmail = process.env.GMAIL_USER;
    if (adminEmail) {
      const { mailNotifAdmin } = require('./agents/mailer');
      mailNotifAdmin({
        asunto: '📅 Turno reprogramado por cliente',
        html: `<p><b>Cliente:</b> ${nombre}</p><p><b>Servicio:</b> ${b.service}</p><p><b>Antes:</b> ${fechaAnterior} ${horaAnterior}</p><p><b>Nuevo:</b> ${fecha_nueva} ${hora_nueva}</p><p><b>Código:</b> #${booking_code}</p>`
      }).catch(() => {});
    }
    res.json({ ok: true, fecha_nueva, hora_nueva });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
