// ── AGENT: BOOKING ────────────────────────────────────────────────────────────
// Responsabilidad única: crear, cancelar y reprogramar turnos.
// NUNCA interpreta texto libre — recibe datos ya validados del orchestrator.
// Todas las acciones son deterministas y atómicas.

const { bookingSave, bookingCancel, bookingFindByCode, bookingFindByName, clientRecordVisit, clientUpsert } = require('../core/db');
const { addToCalendar, addGuestToCalendarEvent, generateCalendarLink } = require('../core/calendar');
const { appendTurnoToSheet } = require('../core/sheets');
const { mailTurnoConfirmado, mailTurnoCancelado, mailTurnoModificado } = require('./mailer');

async function create({ sessionId, nombre, phone, servicio, extra, dia, hora, email }) {
  const nombreSrv = extra ? `${servicio.nombre} + ${extra.nombre}` : servicio.nombre;
  const monto     = servicio.precio + (extra?.precio || 0);

  // 1. Google Calendar
  const evento = await addToCalendar({ clientName: nombre, phone, service: nombreSrv, date: dia, time: hora, duration: 60, sena: 0 });
  const fechaReal = evento?.fechaFormateada || dia;
  const horaReal  = evento?.horaFormateada  || hora;
  const calLink   = generateCalendarLink(nombre, nombreSrv, fechaReal, horaReal);

  // 2. Base de datos
  await clientUpsert(phone, nombre);
  const saved = await bookingSave({ sessionId, nombre, phone, servicio: nombreSrv, fecha: fechaReal, hora: horaReal, monto, senaPaid: false, calendarEventId: evento?.id });
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
  if (email) {
    mailTurnoCancelado({ to: email, nombre: bookingData.nombre, servicio: bookingData.servicio, fecha: bookingData.fecha, hora: bookingData.hora, code: bookingData.code }).catch(()=>{});
  }
  console.log(`[booking] ✓ CANCELADO ID:${bookingData.id}`);
}

async function reschedule({ bookingData, newDia, newHora, phone, email, sessionId }) {
  // Cancelar el viejo
  await bookingCancel(bookingData.id, 'Reprogramado');

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
