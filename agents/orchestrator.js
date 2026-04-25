// agents/orchestrator.js — v6
// ARQUITECTURA: Sonnet lee el historial completo y decide.
// El orquestador solo: (1) prepara el contexto, (2) llama a Sonnet,
// (3) ejecuta la acción que Sonnet pidió, (4) devuelve el resultado.
// NO hay regex conversacional. NO hay state machine. Sonnet manda.
'use strict';

const intake   = require('./intake');
const personal = require('./personal');
const booking  = require('./booking');
const loyalty  = require('./loyalty');
const memory   = require('./memory');
const SERVICIOS = require('../core/servicios');
const { getSession } = require('../core/session');
const { conversationLog, clientGet, clientUpsert, clientUpdateProfile } = require('../core/db');
const { syncClientesToSheet } = require('../core/sheets');

// ── Handler principal ─────────────────────────────────────────────────────────
async function handle({ sessionId, phone, text }) {
  const t = (text || '').trim();
  const session = getSession(sessionId);

  if (!session.historial) session.historial = [];
  if (!session.profile)   session.profile   = {};

  await conversationLog(phone, 'user', t);
  console.log(`[orch] phone=${phone} msg="${t.substring(0, 60)}"`);

  const send = async (msg) => {
    await conversationLog(phone, 'assistant', msg);
    session.historial.push({ role: 'assistant', content: msg });
    return msg;
  };

  // Agregar mensaje al historial
  session.historial.push({ role: 'user', content: t });
  if (session.historial.length > 40) session.historial = session.historial.slice(-40);

  // ── CEO MODE ────────────────────────────────────────────────────────────────
  const CEO_PHONE = process.env.CEO_PHONE || process.env.OWNER_PHONE;
  if (CEO_PHONE && phone === CEO_PHONE) {
    return send(await personal.handleCEO(t, session.historial));
  }

  // ── Cargar contexto del cliente ─────────────────────────────────────────────
  const clientCtx    = await intake.buildContext(phone);
  const profile      = clientCtx?.profile || null;
  const fichaCliente = profile?.toPromptContext?.() || '';

  // ── Hora actual para saludo ──────────────────────────────────────────────────
  const ahora      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const horaNum    = ahora.getHours();
  const saludoHora = horaNum >= 6 && horaNum < 12 ? 'buen día'
    : horaNum >= 12 && horaNum < 20 ? 'buenas tardes'
    : 'buenas noches';

  // ── Llamar a Sonnet — lee todo y decide ─────────────────────────────────────
  const resultado = await personal.pensar({
    mensaje:     t,
    historial:   session.historial.slice(-20),
    fichaCliente,
    saludoHora,
  });

  console.log(`[orch] tool=${resultado.tool?.name || 'none'} texto=${resultado.texto?.substring(0, 60) || ''}`);

  // ── Sin tool: respuesta directa ─────────────────────────────────────────────
  if (!resultado.tool) {
    memory.update(phone, clientCtx?.client, t).catch(() => {});
    return send(resultado.texto || '¿En qué más te puedo ayudar? 💛');
  }

  // ── Con tool: ejecutar acción ────────────────────────────────────────────────
  const { name, input, id: toolId } = resultado.tool;
  let toolResultado = '';

  // ── crear_turno ──────────────────────────────────────────────────────────────
  if (name === 'crear_turno') {
    try {
      const srv   = SERVICIOS.findByName(input.servicio);
      const extra = input.extra ? SERVICIOS.findByName(input.extra) : null;

      if (!srv) {
        toolResultado = `Error: servicio "${input.servicio}" no encontrado en el catálogo.`;
      } else {
        const email = input.email || clientCtx?.client?.email || null;
        const bResult = await booking.create({
          sessionId: session.id,
          nombre:    input.nombre,
          phone,
          servicio:  srv,
          extra:     extra || null,
          dia:       input.dia,
          hora:      input.hora,
          email,
          notes:     input.objetivo_notas || null,
        });

        const { formatFecha } = require('../core/utils');
        const fechaDisplay = await formatFecha(bResult.fechaReal);
        const srvDisplay   = srv.nombre + (extra ? ' + ' + extra.nombre : '');
        const pts          = bResult.pointsEarned || 0;

        // Guardar en sesión para referencia
        session.lastBooking = {
          nombre: input.nombre, servicio: srvDisplay,
          fecha: bResult.fechaReal, hora: bResult.horaReal,
          code: bResult.code, calLink: bResult.calLink, monto: bResult.monto,
          senaRequired: srv.seña && bResult.senaAmount > 0,
        };
        session.lastCalendarEventId = bResult.calendarEventId;

        if (srv.seña && bResult.senaAmount > 0) {
          const montoSena = bResult.senaAmount.toLocaleString('es-AR');
          // Mandar email si hay
          if (email) _mandarEmailSena(bResult, srv, srvDisplay, input.nombre, email).catch(() => {});
          toolResultado = `Turno registrado con seña requerida. Código: ${bResult.code}. Fecha: ${fechaDisplay}. Hora: ${bResult.horaReal}. Seña requerida: $${montoSena}${bResult.mpLink ? '. Link de pago MercadoPago: ' + bResult.mpLink : ''}.`;
          // Mensaje hardcodeado para el resumen — datos críticos no los genera Sonnet
          const msgSena = personal.msgSenaRequerida(input.nombre, srvDisplay, fechaDisplay, bResult.horaReal, bResult.code, montoSena, bResult.mpLink);
          return send(msgSena + _msgApellido());
        }

        // Sin seña — confirmación directa
        if (email) _mandarEmailConfirmacion(bResult, srv, srvDisplay, input.nombre, email).catch(() => {});
        toolResultado = `Turno confirmado exitosamente. Código: ${bResult.code}. Fecha: ${fechaDisplay}. Hora: ${bResult.horaReal}. Puntos ganados: ${pts}.`;
        const msgConfirm = personal.msgTurnoConfirmado(input.nombre, srvDisplay, fechaDisplay, bResult.horaReal, bResult.code, pts);
        return send(msgConfirm + _msgApellido());
      }
    } catch (e) {
      console.error('[orch] crear_turno error:', e.message);
      toolResultado = `Error técnico al crear el turno: ${e.message}. Decile a la clienta que lo intentemos de nuevo.`;
    }
  }

  // ── buscar_turno ─────────────────────────────────────────────────────────────
  else if (name === 'buscar_turno') {
    try {
      const found = await booking.findBooking(input.query, phone);
      if (found) {
        session.lastFoundBooking = found;
        toolResultado = `Turno encontrado. Código: ${found.code}. Servicio: ${found.servicio}. Fecha: ${found.fecha}. Hora: ${found.hora}. Cliente: ${found.nombre}. Estado: ${found.status}.`;
      } else {
        toolResultado = 'No se encontró ningún turno con esa información.';
      }
    } catch (e) {
      toolResultado = `Error buscando el turno: ${e.message}`;
    }
  }

  // ── cancelar_turno ───────────────────────────────────────────────────────────
  else if (name === 'cancelar_turno') {
    try {
      const found = session.lastFoundBooking;
      if (!found) {
        toolResultado = 'No hay turno cargado en sesión. Primero usar buscar_turno.';
      } else {
        const cl = await clientGet(phone);
        await booking.cancel({ bookingData: found, phone, email: cl?.email });
        session.lastFoundBooking = null;
        toolResultado = `Turno ${found.code} cancelado exitosamente.`;
      }
    } catch (e) {
      toolResultado = `Error cancelando: ${e.message}`;
    }
  }

  // ── reprogramar_turno ────────────────────────────────────────────────────────
  else if (name === 'reprogramar_turno') {
    try {
      const found = session.lastFoundBooking;
      if (!found) {
        toolResultado = 'No hay turno cargado en sesión. Primero usar buscar_turno.';
      } else {
        const cl = await clientGet(phone);
        const rResult = await booking.reschedule({
          bookingData: found, newDia: input.nuevo_dia, newHora: input.nueva_hora,
          phone, email: cl?.email, sessionId: session.id,
        });
        const { formatFecha } = require('../core/utils');
        const fechaDisplay = await formatFecha(rResult.fechaReal);
        session.lastFoundBooking = null;
        toolResultado = `Turno reprogramado. Nuevo código: ${rResult.code}. Fecha: ${fechaDisplay}. Hora: ${rResult.horaReal}.`;
      }
    } catch (e) {
      toolResultado = `Error reprogramando: ${e.message}`;
    }
  }

  // ── registrar_consulta_color ─────────────────────────────────────────────────
  else if (name === 'registrar_consulta_color') {
    try {
      const alistado = input.tiene_alisado ? ' ⚠️ Tiene alisado/keratina' : '';
      const notes    = `Procesos: ${input.procesos || 'sin procesos previos'}${alistado} | Resultado: ${input.resultado} | Contacto: ${input.contacto || 'no dejó'}`;
      const db = require('../core/db');
      await db.bookingSave({
        sessionId: session.id, nombre: input.nombre || '', phone,
        servicio:  input.servicio, fecha: '', hora: '',
        monto:     SERVICIOS.findByName(input.servicio)?.precio || 0,
        senaPaid: false, calendarEventId: null,
        email:  /[@.]/.test(input.contacto || '') ? input.contacto : null,
        notes,  status: 'Consulta Pendiente',
      }).catch(() => {});
      _notificarStaff(phone, input.nombre, `Color: ${input.servicio} | ${notes}`, 'COLOR');
      toolResultado = 'Consulta de color registrada. El equipo contacta a la clienta dentro de las 24hs.';
    } catch (e) {
      toolResultado = `Error registrando consulta: ${e.message}`;
    }
  }

  // ── guardar_email ────────────────────────────────────────────────────────────
  else if (name === 'guardar_email') {
    try {
      await clientUpsert(phone, profile?.firstName || null, input.email).catch(() => {});
      // Si hay turno reciente, actualizar su email también
      if (session.lastBooking?.code) {
        const { getDB } = require('../core/db');
        const db = getDB();
        if (db) await db.query('UPDATE bookings SET email=$1 WHERE booking_code=$2', [input.email, session.lastBooking.code]).catch(() => {});
        // Mandar email de confirmación si no se mandó antes
        const b = session.lastBooking;
        if (b && !b.senaRequired && !b._emailSent) {
          b._emailSent = true;
          const { mailTurnoConfirmado } = require('./mailer');
          const { addGuestToCalendarEvent } = require('../core/calendar');
          if (session.lastCalendarEventId) addGuestToCalendarEvent(session.lastCalendarEventId, input.email).catch(() => {});
          const { formatFecha } = require('../core/utils');
          formatFecha(b.fecha).then(fd => {
            mailTurnoConfirmado({ to: input.email, nombre: b.nombre, servicio: b.servicio, fecha: b.fecha, hora: b.hora, code: b.code, calendarLink: b.calLink, monto: b.monto, senaAmount: null }).catch(() => {});
          });
        }
      }
      toolResultado = `Email ${input.email} guardado correctamente. Se mandó la confirmación del turno.`;
    } catch (e) {
      toolResultado = `Error guardando email: ${e.message}`;
    }
  }

  // ── notificar_equipo ─────────────────────────────────────────────────────────
  else if (name === 'notificar_equipo') {
    _notificarStaff(phone, profile?.firstName, input.motivo, 'DERIVACION');
    toolResultado = 'Notificación enviada al equipo. Se comunican a la brevedad.';
  }

  // ── Continuar: Sonnet genera respuesta con el resultado de la tool ───────────
  memory.update(phone, clientCtx?.client, t).catch(() => {});
  const respFinal = await personal.continuar({
    toolId,
    toolName:     name,
    toolResultado,
    historial:    session.historial.slice(-16),
    fichaCliente,
  });

  return send(respFinal || '¿En qué más te puedo ayudar? 💛');
}

// ── Primer mensaje / saludo inicial ──────────────────────────────────────────
// Llamado desde index.js en /chat/start
async function saludoInicial(phone, sessionId) {
  const clientCtx = await intake.buildContext(phone);
  const profile   = clientCtx?.profile || null;
  return await personal.generarSaludo(profile);
}

// ── Helpers de email ──────────────────────────────────────────────────────────
async function _mandarEmailConfirmacion(bResult, srv, srvDisplay, nombre, email) {
  const { addGuestToCalendarEvent } = require('../core/calendar');
  const { mailTurnoConfirmado }     = require('./mailer');
  if (bResult.calendarEventId) await addGuestToCalendarEvent(bResult.calendarEventId, email).catch(() => {});
  await mailTurnoConfirmado({ to: email, nombre, servicio: srvDisplay, fecha: bResult.fechaReal, hora: bResult.horaReal, code: bResult.code, calendarLink: bResult.calLink, monto: bResult.monto, senaAmount: null }).catch(() => {});
}

async function _mandarEmailSena(bResult, srv, srvDisplay, nombre, email) {
  const { addGuestToCalendarEvent } = require('../core/calendar');
  if (bResult.calendarEventId) await addGuestToCalendarEvent(bResult.calendarEventId, email).catch(() => {});
}

// Mensaje post-confirmación de turno
function _msgApellido() {
  return '\n\n¿Me decís tu apellido para sumarte al programa de beneficios? 💛\n_(o *no* para saltear)_';
}

// ── Notificaciones staff ──────────────────────────────────────────────────────
function _notificarStaff(phone, nombre, info, tipo) {
  const STAFF_WA   = process.env.STAFF_WHATSAPP_PHONE;
  const WASS_TOKEN = process.env.WASSENGER_TOKEN || process.env.WASSENGER_API_KEY;
  if (!STAFF_WA || !WASS_TOKEN) return;
  const axios = require('axios');
  const iconos = { COLOR: '🎨', DERIVACION: '💬' };
  const msg = `${iconos[tipo] || '📋'} *${tipo === 'COLOR' ? 'CONSULTA COLOR' : 'DERIVACIÓN'}*\n\n👤 ${nombre || 'Sin nombre'} · 📱 ${phone}\n${info}\n\nhttps://peluqueria-bot.onrender.com/staff`;
  axios.post('https://api.wassenger.com/v1/messages', { phone: STAFF_WA, message: msg }, { headers: { Token: WASS_TOKEN }, timeout: 8000 }).catch(() => {});
}

module.exports = { handle, saludoInicial };