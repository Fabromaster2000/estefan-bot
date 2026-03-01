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
    const { sessionId, message } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: 'Faltan campos' });
    const reply = await orchestrator.handle({ sessionId, phone: sessionId, text: message });
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
    res.json({ sessionId, welcome });
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

app.get('/admin/clients', async (req, res) => {
  try {
    const dbConn = db.getDB();
    const r = await dbConn.query(`SELECT phone, name, last_name, email, visit_count, points, created_at FROM clients ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cleanup-test-clients', async (req, res) => {
  if (req.body?.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'No autorizado' });
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

app.post('/admin/delete-client', async (req, res) => {
  if (req.body?.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'No autorizado' });
  try {
    const dbConn = db.getDB();
    await dbConn.query(`DELETE FROM bookings WHERE client_phone = $1`, [req.body.phone]);
    await dbConn.query(`DELETE FROM clients WHERE phone = $1`, [req.body.phone]);
    await sheets.syncClientesToSheet();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH & STATUS ───────────────────────────────────────────────────────────
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

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  console.log('\n✂️  Estefan Peluquería Bot v4');

  // 1. DB
  const dbConn = await db.initDB();

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
