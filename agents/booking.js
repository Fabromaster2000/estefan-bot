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


async function create({ sessionId, nombre, phone, servicio, extra, dia, hora, email, notes }) {
  const nombreSrv = extra ? `${servicio.nombre} + ${extra.nombre}` : servicio.nombre;
  const monto     = servicio.precio + (extra?.precio || 0);

  // 1. Google Calendar (may fail if OAuth expired — always resolve date locally as fallback)
  const fechaFallback = resolveLocalDate(dia, hora);
  const evento = await addToCalendar({ clientName: nombre, phone, service: nombreSrv, date: dia, time: hora, duration: 60, sena: 0 });
  const fechaReal = evento?.fechaFormateada || fechaFallback.fecha;
  const horaReal  = evento?.horaFormateada  || fechaFallback.hora;
  const calLink   = generateCalendarLink(nombre, nombreSrv, fechaReal, horaReal);

  // 2. Base de datos
  await clientUpsert(phone, nombre);
  const saved = await bookingSave({ sessionId, nombre, phone, servicio: nombreSrv, fecha: fechaReal, hora: horaReal, monto, senaPaid: false, calendarEventId: evento?.id, email: email || null, notes: notes || null });
  const pointsEarned = await clientRecordVisit(phone, nombreSrv, monto);

  // 3. Sheets
  await appendTurnoToSheet({ id: saved?.id, code: saved?.code, nombre, servicio: nombreSrv, fecha: fechaReal, hora: horaReal, phone, monto, senaAmount: 0, senaPaid: false });

  // 4. Email (si tiene)
  if (email) {
    await addGuestToCalendarEvent(evento?.id, email).catch(()=>{});
    mailTurnoConfirmado({ to: email, nombre, servicio: nombreSrv, fecha: fechaReal, hora: horaReal, code: saved?.code, calendarLink: calLink, monto, senaAmount: null }).catch(()=>{});
  }

  console.log(`[booking] ✓ CREADO ID:${saved?.id} código:${saved?.code} ${fechaReal} ${horaReal} pts:+${pointsEarned}`);
  return { fechaReal, horaReal, code: saved?.code, calLink, monto, calendarEventId: evento?.id, pointsEarned };
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
