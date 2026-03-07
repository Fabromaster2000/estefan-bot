// ── AGENT: BOOKING ────────────────────────────────────────────────────────────
// Responsabilidad única: crear, cancelar y reprogramar turnos.
// NUNCA interpreta texto libre — recibe datos ya validados del orchestrator.
// Todas las acciones son deterministas y atómicas.
const { bookingSave, bookingCancel, bookingFindByCode, bookingFindByName, clientRecordVisit, clientUpsert } = require('../core/db');
const { addToCalendar, addGuestToCalendarEvent, generateCalendarLink } = require('../core/calendar');
const { appendTurnoToSheet } = require('../core/sheets');
const { mailTurnoConfirmado, mailTurnoCancelado, mailTurnoModificado } = require('./mailer');

// ── Resolver de fecha local (fallback cuando Google Calendar falla) ────────────
function resolveLocalDate(dia, hora) {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  
  // Parse hora
  let hours = 10, minutes = 0;
  if (hora) {
    const t = hora.toLowerCase().replace(/hs?$/, '').trim();
    const parts = t.split(':');
    hours = parseInt(parts[0]) || 10;
    minutes = parseInt(parts[1]) || 0;
  }
  let startDate;
  const diaStr = (dia || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Already in DD/MM/YYYY format
  const slashMatch = diaStr.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (slashMatch) {
    const d = parseInt(slashMatch[1]), m = parseInt(slashMatch[2]) - 1;
    const y = slashMatch[3] ? parseInt(slashMatch[3]) : now.getFullYear();
    startDate = new Date(y < 100 ? 2000 + y : y, m, d, hours, minutes, 0);
  } else {
    // Day name like "jueves", "hoy", "mañana"
    const days = { domingo:0, lunes:1, martes:2, miercoles:3, jueves:4, viernes:5, sabado:6, hoy:-1, manana:-2 };
    const dayKey = Object.keys(days).find(k => diaStr.includes(k));
    startDate = new Date(now);
    startDate.setHours(hours, minutes, 0, 0);
    if (dayKey === 'hoy' || dayKey === undefined) {
      // keep today
    } else if (dayKey === 'manana') {
      startDate.setDate(startDate.getDate() + 1);
    } else {
      const target = days[dayKey];
      let diff = target - startDate.getDay();
      if (diff < 0) diff += 7;
      if (diff === 0) {
        const test = new Date(startDate);
        if (test <= now) diff = 7;
      }
      startDate.setDate(startDate.getDate() + diff);
    }
  }
  const fecha = `${pad(startDate.getDate())}/${pad(startDate.getMonth()+1)}/${startDate.getFullYear()}`;
  const horaOut = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;
  return { fecha, hora: horaOut };
}

// ── Generar link de pago MP para seña ─────────────────────────────────────────
async function generarMpLink(bookingId, monto, nombre, servicio) {
  try {
    const axios = require('axios');
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_ACCESS_TOKEN) return null;
    const payload = {
      items: [{ title: `Seña — ${servicio}`, quantity: 1, unit_price: monto, currency_id: 'ARS' }],
      payer: { name: nombre },
      external_reference: String(bookingId),
      back_urls: {
        success: 'https://peluqueria-bot.onrender.com/mp/success',
        failure: 'https://peluqueria-bot.onrender.com/mp/failure',
      },
      auto_return: 'approved',
      notification_url: 'https://peluqueria-bot.onrender.com/mp/webhook',
    };
    const res = await axios.post('https://api.mercadopago.com/checkout/preferences', payload, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    return res.data?.init_point || null;
  } catch(e) {
    console.error('[booking] MP link error:', e.message);
    return null;
  }
}

async function create({ sessionId, nombre, phone, servicio, extra, dia, hora, email, notes }) {
  const nombreSrv  = extra ? `${servicio.nombre} + ${extra.nombre}` : servicio.nombre;
  const monto      = servicio.precio + (extra?.precio || 0);
  const tieneSeña  = !!servicio.seña;
  const pctSeña    = servicio.pct || 10;
  const senaAmount = tieneSeña ? Math.round(monto * pctSeña / 100) : 0;

  // 1. Fecha — Calendar solo si NO hay seña pendiente; fallback siempre disponible
  const fechaFallback = resolveLocalDate(dia, hora);
  let evento = null;
  let fechaReal, horaReal;

  if (!tieneSeña) {
    // Sin seña: crear evento de calendario ahora
    evento = await addToCalendar({ clientName: nombre, phone, service: nombreSrv, date: dia, time: hora, duration: 60, sena: 0 });
  }
  fechaReal = evento?.fechaFormateada || fechaFallback.fecha;
  horaReal  = evento?.horaFormateada  || fechaFallback.hora;
  const calLink = generateCalendarLink(nombre, nombreSrv, fechaReal, horaReal);

  // 2. Base de datos
  await clientUpsert(phone, nombre, email || null);
  const statusInicial = tieneSeña ? 'Seña pendiente' : 'Confirmado';
  const saved = await bookingSave({
    sessionId, nombre, phone,
    servicio: nombreSrv, fecha: fechaReal, hora: horaReal,
    monto, senaAmount, senaPaid: false,
    calendarEventId: evento?.id || null,
    email: email || null, notes: notes || null,
    status: statusInicial,
  });

  // FIX: puntos y visitas se registran al COBRAR, no al reservar
  const pointsEarned = 0;

  // 3. Sheets
  await appendTurnoToSheet({
    id: saved?.id, code: saved?.code, nombre, servicio: nombreSrv,
    fecha: fechaReal, hora: horaReal, phone, monto,
    senaAmount, senaPaid: false, estado: statusInicial,
  });

  // 4. MP link (si tiene seña) + email/calendar (solo sin seña)
  let mpLink = null;
  if (tieneSeña) {
    // Generar link de pago
    mpLink = await generarMpLink(saved?.id, senaAmount, nombre, nombreSrv);
    if (mpLink) {
      const { getConn } = require('../core/db');
      await getConn().query(
        'UPDATE bookings SET mp_payment_link=$1 WHERE id=$2',
        [mpLink, saved?.id]
      ).catch(() => {});
    }
    console.log(`[booking] ⏳ Seña pendiente ID:${saved?.id} código:${saved?.code} — $${senaAmount} — mpLink:${mpLink ? '✓' : '✗'}`);
  } else {
    // Sin seña: mandar email y agregar guest al calendario ahora
    if (email) {
      await addGuestToCalendarEvent(evento?.id, email).catch(() => {});
      mailTurnoConfirmado({ to: email, nombre, servicio: nombreSrv, fecha: fechaReal, hora: horaReal, code: saved?.code, calendarLink: calLink, monto, senaAmount: null }).catch(() => {});
    }
    console.log(`[booking] ✓ CREADO ID:${saved?.id} código:${saved?.code} ${fechaReal} ${horaReal}`);
  }

  return {
    fechaReal, horaReal, code: saved?.code, calLink, monto,
    calendarEventId: evento?.id || null, pointsEarned,
    senaAmount, mpLink,
  };
}

async function cancel({ bookingData, phone, email }) {
  await bookingCancel(bookingData.id, 'Cancelado');
  // Actualizar estado en Sheets
  const { updateTurnoStatus } = require('../core/sheets');
  updateTurnoStatus(bookingData.code, bookingData.servicio, 'Cancelado').catch(() => {});
  if (email) {
    mailTurnoCancelado({ to: email, nombre: bookingData.nombre, servicio: bookingData.servicio, fecha: bookingData.fecha, hora: bookingData.hora, code: bookingData.code }).catch(()=>{});
  }
  console.log(`[booking] ✓ CANCELADO ID:${bookingData.id}`);
}

async function reschedule({ bookingData, newDia, newHora, phone, email, sessionId }) {
  // Cancelar el viejo
  await bookingCancel(bookingData.id, 'Reprogramado');
  const { updateTurnoStatus } = require('../core/sheets');
  updateTurnoStatus(bookingData.code, bookingData.servicio, 'Reprogramado').catch(() => {});
  // Crear el nuevo
  const evento = await addToCalendar({ clientName: bookingData.nombre, phone, service: bookingData.servicio, date: newDia, time: newHora, duration: 60, sena: 0 });
  const fechaReal = evento?.fechaFormateada || newDia;
  const horaReal  = evento?.horaFormateada  || newHora;
  const calLink   = generateCalendarLink(bookingData.nombre, bookingData.servicio, fechaReal, horaReal);
  const monto     = bookingData.monto || 0;
  const saved = await bookingSave({ sessionId, nombre: bookingData.nombre, phone, servicio: bookingData.servicio, fecha: fechaReal, hora: horaReal, monto, senaPaid: false, calendarEventId: evento?.id });
  await appendTurnoToSheet({ id: saved?.id, code: saved?.code, nombre: bookingData.nombre, servicio: bookingData.servicio, fecha: fechaReal, hora: horaReal, phone, monto, senaAmount: 0, senaPaid: false });
  if (email) {
    await addGuestToCalendarEvent(evento?.id, email).catch(()=>{});
    mailTurnoModificado({ to: email, nombre: bookingData.nombre, servicio: bookingData.servicio, fechaAnterior: bookingData.fecha, horaAnterior: bookingData.hora, fechaNueva: fechaReal, horaNueva: horaReal, code: saved?.code, calendarLink: calLink, monto }).catch(()=>{});
  }
  console.log(`[booking] ✓ REPROGRAMADO ID:${saved?.id} código:${saved?.code} ${fechaReal} ${horaReal}`);
  return { fechaReal, horaReal, code: saved?.code, calLink, monto };
}

async function findBooking(codeOrName, phone = null) {
  // Intentar por código primero
  const codeMatch = (codeOrName||'').match(/#?([A-Z0-9]{4})/i);
  if (codeMatch) {
    const b = await bookingFindByCode(codeMatch[1].toUpperCase());
    if (b) return b;
  }
  // Por nombre
  if (codeOrName && codeOrName.length > 2) {
    return await bookingFindByName(codeOrName);
  }
  return null;
}

module.exports = { create, cancel, reschedule, findBooking };
