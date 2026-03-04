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

app.get('/admin/clients', async (req, res) => {
  try {
    const dbConn = db.getDB();
    const r = await dbConn.query(`SELECT phone, name, last_name, email, visit_count, points, created_at FROM clients ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cleanup-test-clients', async (req, res) => {
  const pw = req.headers['x-staff-password'] || req.body?.password;
  if (pw !== (process.env.STAFF_PASSWORD || 'estefan2024')) return res.status(403).json({ error: 'No autorizado' });
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
  const pw = req.headers['x-staff-password'] || req.body?.password;
  if (pw !== (process.env.STAFF_PASSWORD || 'estefan2024')) return res.status(403).json({ error: 'No autorizado' });
  try {
    const dbConn = db.getDB();
    await dbConn.query(`DELETE FROM bookings WHERE client_phone = $1`, [req.body.phone]);
    await dbConn.query(`DELETE FROM clients WHERE phone = $1`, [req.body.phone]);
    await sheets.syncClientesToSheet();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar turno individual
app.delete('/admin/booking/:id', async (req, res) => {
  if ((req.headers['x-staff-password'] || req.query.pw) !== (process.env.STAFF_PASSWORD || 'estefan2024')) return res.status(401).json({ error: 'No autorizado' });
  try {
    const dbConn = db.getDB();
    const r = await dbConn.query('DELETE FROM bookings WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Turno no encontrado' });
    res.json({ ok: true, id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar múltiples turnos
app.post('/admin/bookings/bulk-delete', async (req, res) => {
  if ((req.headers['x-staff-password'] || req.query.pw) !== (process.env.STAFF_PASSWORD || 'estefan2024')) return res.status(401).json({ error: 'No autorizado' });
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.json({ ok: true, deleted: 0 });
    const dbConn = db.getDB();
    const r = await dbConn.query('DELETE FROM bookings WHERE id = ANY($1)', [ids]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listar todos los turnos para admin (con filtros)
app.get('/admin/bookings', async (req, res) => {
  if ((req.headers['x-staff-password'] || req.query.pw) !== (process.env.STAFF_PASSWORD || 'estefan2024')) return res.status(401).json({ error: 'No autorizado' });
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
app.get('/admin/stats', async (req, res) => {
  if ((req.headers['x-staff-password'] || req.query.pw) !== (process.env.STAFF_PASSWORD || 'estefan2024')) return res.status(401).json({ error: 'No autorizado' });
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

function staffAuth(req, res, next) {
  const pw = req.headers['x-staff-password'] || req.query.pw;
  if (pw !== STAFF_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
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
      SELECT id, booking_code as code, client_name as nombre, client_phone as phone,
             service as servicio, date_str as fecha, time_str as hora,
             status as estado, monto, created_at
      FROM bookings
      WHERE created_at >= NOW() - INTERVAL '1 day'
         OR date_str >= TO_CHAR(NOW(), 'DD/MM/YYYY')
      ORDER BY date_str ASC, time_str ASC
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
      SELECT id, booking_code as code, client_name as nombre, client_phone as phone,
             service as servicio, date_str as fecha, time_str as hora,
             status as estado, monto
      FROM bookings WHERE date_str = $1
      ORDER BY time_str ASC
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
    await db.clientUpsert(phoneF, nombre);
    if (email) await getConn().query('UPDATE clients SET email = $1 WHERE phone = $2', [email, phoneF]).catch(() => {});
    const saved = await db.bookingSave({
      sessionId: 'staff-manual',
      nombre, phone: phoneF,
      servicio: servicioStr, fecha, hora,
      monto: montoFinal, senaAmount: senaFinal, senaPaid: false,
      calendarEventId: null, email, notes: notas || null
    });
    const { appendTurnoToSheet } = require('./core/sheets');
    await appendTurnoToSheet({ code: saved.code, fecha, hora, nombre, phone: phoneF, servicio: servicioStr, monto: montoFinal, sena: senaFinal, senaPagada: false, estado: 'Confirmado', canal: 'Staff Manual' }).catch(() => {});
    res.json({ ok: true, code: saved.code, id: saved.id });
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
        if (bookingId) {
          await getConn().query('UPDATE bookings SET sena_paid = true, status = $1 WHERE id = $2', ['Seña pagada', bookingId]).catch(() => {});
          const { updateTurnoStatus } = require('./core/sheets');
          const b = await getConn().query('SELECT booking_code, service FROM bookings WHERE id = $1', [bookingId]);
          if (b.rows[0]) await updateTurnoStatus(b.rows[0].booking_code, b.rows[0].service, 'Seña pagada').catch(() => {});
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
    const validStatuses = ['Confirmado','Cancelado','Completado','Consulta Pendiente','Reprogramado','No asistió'];
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
      const { mailTurnoConfirmado, mailTurnoCancelado, mailTurnoModificado } = require('./mailer');
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
        const { mailTurnoModificado } = require('./mailer');
        try {
          await mailTurnoModificado({
            to: bk.email, nombre: bk.client_name, servicio: bk.service,
            fecha, hora, code: bk.booking_code, monto: bk.monto, motivo: motivo || ''
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
app.post('/admin/sync-emails', staffAuth, async (req, res) => {
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
        const { mailTurnoConfirmado } = require('./mailer');
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
