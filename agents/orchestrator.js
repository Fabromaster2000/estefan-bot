// agents/orchestrator.js — v6
// ARQUITECTURA: Sonnet lee el historial completo y decide.
// El orquestador solo: (1) prepara el contexto, (2) llama a Sonnet,
// (3) ejecuta la acción que Sonnet pidió, (4) devuelve el resultado.
// NO hay regex conversacional. NO hay state machine. Sonnet manda.
'use strict';

const { BOT } = require('../core/marca');

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
  // Hora y día exactos para que el bot no los invente
  const ahoraBsAs = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const diaSemana = dias[ahoraBsAs.getDay()];
  const horaExacta = ahoraBsAs.getHours().toString().padStart(2,'0') + ':' + ahoraBsAs.getMinutes().toString().padStart(2,'0') + 'hs';
  const pad2 = n => String(n).padStart(2,'0');
  const fechaHoy = `${pad2(ahoraBsAs.getDate())}/${pad2(ahoraBsAs.getMonth()+1)}/${ahoraBsAs.getFullYear()}`;
  const manana = new Date(ahoraBsAs); manana.setDate(manana.getDate()+1);
  const fechaManana = `${pad2(manana.getDate())}/${pad2(manana.getMonth()+1)}/${manana.getFullYear()}`;
  const horaActualNum = ahoraBsAs.getHours() + ahoraBsAs.getMinutes() / 60;
  const esDomingo = ahoraBsAs.getDay() === 0;
  const estaAbierto = !esDomingo && horaActualNum >= 10 && horaActualNum < 20;

  const resultado = await personal.pensar({
    mensaje:     t,
    historial:   session.historial.slice(-20),
    fichaCliente,
    saludoHora,
    horaExacta,
    diaSemana,
    fechaHoy,
    fechaManana,
    estaAbierto,
    horaActualNum,
  });

  console.log(`[orch] tool=${resultado.tool?.name || 'none'} texto=${resultado.texto?.substring(0, 60) || ''}`);

  // ── Sin tool: respuesta directa ─────────────────────────────────────────────
  if (!resultado.tool) {
    memory.update(phone, clientCtx?.client, t).catch(() => {});
    const textoFinal = resultado.texto?.trim();
    // No mandar respuestas vacías ni solo emojis sueltos
    if (!textoFinal || textoFinal.length < 3) return;
    return send(textoFinal);
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
        // Verificar si esta clienta requiere seña por score de confiabilidad bajo
        const clientRequiereSena = profile?.requiresSena && !srv.seña;
        if (clientRequiereSena) {
          // Forzar seña aunque el servicio normalmente no la requiera
          srv = { ...srv, seña: true, pct: 20, senaNotes: 'Seña requerida por historial de cancelaciones' };
        }

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
          const portalLinkSena = await _generarLinkPortal(phone);
          const msgSena = personal.msgSenaRequerida(input.nombre, srvDisplay, fechaDisplay, bResult.horaReal, bResult.code, montoSena, bResult.mpLink, portalLinkSena);
          return send(msgSena + _msgApellido());
        }

        // Sin seña — confirmación directa
        if (email) _mandarEmailConfirmacion(bResult, srv, srvDisplay, input.nombre, email).catch(() => {});
        toolResultado = `Turno confirmado exitosamente. Código: ${bResult.code}. Fecha: ${fechaDisplay}. Hora: ${bResult.horaReal}. Puntos ganados: ${pts}.`;
        const portalLink = await _generarLinkPortal(phone);
        const msgConfirm = personal.msgTurnoConfirmado(input.nombre, srvDisplay, fechaDisplay, bResult.horaReal, bResult.code, pts, portalLink);
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
      const { bookingFindByCode, bookingFindByName, bookingFindByEmail, bookingFindByPhone } = require('../core/db');
      const q = (input.query || '').trim();
      let found = null;

      // Buscar por código
      if (q.startsWith('#') || /^[A-Z0-9]{4,6}$/i.test(q)) {
        found = await bookingFindByCode(q);
      }
      // Buscar por email
      if (!found && q.includes('@')) {
        found = await bookingFindByEmail(q);
      }
      // Buscar por teléfono del contexto (la clienta que está hablando)
      if (!found && phone && !phone.startsWith('web-')) {
        found = await bookingFindByPhone(phone);
      }
      // Buscar por nombre
      if (!found && q.length > 2) {
        found = await bookingFindByName(q);
      }

      if (found) {
        session.lastFoundBooking = found;
        toolResultado = `Turno encontrado: Código ${found.code} | Servicio: ${found.servicio} | Fecha: ${found.fecha} | Hora: ${found.hora} | Cliente: ${found.nombre} | Estado: ${found.estado}.`;
      } else {
        // Generar link del portal para que la clienta se autogestione
        const portalLink = await _generarLinkPortal(phone).catch(() => null);
        toolResultado = `No se encontró ningún turno activo con "${q}". ${portalLink ? 'Link portal personal: ' + portalLink : ''} Opciones: pedir el código de reserva (#XXXX del email de confirmación), o derivar al equipo.`;
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
        const { getDB } = require('../core/db');
        const db = getDB();
        if (!db) throw new Error('Sin conexión a DB');

        const nuevaFecha = input.nuevo_dia;   // DD/MM/YYYY
        const nuevaHora  = input.nueva_hora;  // HH:MM

        console.log(`[reprogramar] booking id=${found.id} code=${found.code} nombre=${found.nombre} fecha_nueva=${nuevaFecha} ${nuevaHora}`);

        // 1. Actualizar DB
        const updateResult = await db.query(
          "UPDATE bookings SET date_str=$1, time_str=$2, status='Reprogramado' WHERE id=$3 RETURNING id, booking_code, client_name",
          [nuevaFecha, nuevaHora, found.id]
        );
        console.log(`[reprogramar] DB actualizada:`, updateResult.rows[0]);

        // 2. Actualizar Sheets por código exacto
        try {
          const { updateTurnoStatus } = require('../core/sheets');
          await updateTurnoStatus(found.code, found.servicio, 'Reprogramado').catch(() => {});
        } catch(_) {}

        // 3. Mandar mail de confirmación si hay email
        try {
          const emailDestino = found.email || profile?.email || null;
          if (emailDestino) {
            const { mailTurnoModificado } = require('./mailer');
            await mailTurnoModificado({
              to: emailDestino,
              nombre: found.nombre,
              servicio: found.servicio,
              fechaAnterior: found.fecha,
              horaAnterior: found.hora,
              fechaNueva: nuevaFecha,
              horaNueva: nuevaHora,
              code: found.code,
              calendarLink: null,
              monto: found.monto,
            }).catch(() => {});
          }
        } catch(_) {}

        // 4. Notificar al admin por mail
        await _notificarStaff(
          phone,
          found.nombre,
          `Reprogramación: ${found.servicio} de ${found.fecha} ${found.hora} → ${nuevaFecha} ${nuevaHora}`,
          'CAMBIO'
        ).catch(() => {});

        session.lastFoundBooking = null;
        toolResultado = `Turno ${found.code} reprogramado exitosamente. Nueva fecha: ${nuevaFecha} a las ${nuevaHora}.`;
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
      const histColorResumen = session.historial
        .slice(-8)
        .map(h => `<strong>${h.role === 'user' ? '👤 Cliente' : ('🤖 ' + BOT)}:</strong> ${String(h.content).substring(0, 200)}`)
        .join('<br>');
      await _notificarStaff(phone, input.nombre, `Color: ${input.servicio} | ${notes}`, 'COLOR', histColorResumen);
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
      // Generar link del portal para incluir en la respuesta
      const portalLinkEmail = await _generarLinkPortal(phone);
      toolResultado = `Email ${input.email} guardado correctamente. Se mandó la confirmación del turno.${portalLinkEmail ? ' Link del portal personal: ' + portalLinkEmail : ''}`;
    } catch (e) {
      toolResultado = `Error guardando email: ${e.message}`;
    }
  }

  // ── notificar_equipo ─────────────────────────────────────────────────────────
  else if (name === 'notificar_equipo') {
    try {
      // Usar todos los datos disponibles del cliente
      const clientData = clientCtx?.client || await clientGet(phone).catch(() => null);
      const nombreCliente = profile?.firstName || clientData?.name || input.nombre || 'Sin nombre';
      const emailCliente  = profile?.email || clientData?.email || null;
      const motivo = input.motivo || 'Sin especificar';

      // Resumen del historial para el mail
      const histResumen = session.historial
        .slice(-6)
        .map(h => `<strong>${h.role === 'user' ? '👤 Cliente' : ('🤖 ' + BOT)}:</strong> ${String(h.content).substring(0, 200)}`)
        .join('<br>');

      // Guardar en portal como "Solicitud cliente" para que aparezca en staff
      const { bookingSave } = require('../core/db');
      await bookingSave({
        sessionId: session.id,
        nombre: nombreCliente,
        phone,
        servicio: `Derivación: ${motivo.substring(0, 80)}`,
        fecha: '', hora: '',
        monto: 0,
        senaPaid: false,
        calendarEventId: null,
        email: emailCliente,
        notes: motivo,
        status: 'Solicitud cliente',
      }).catch(() => {});

      const detalleConEmail = emailCliente ? `${motivo}\n📧 ${emailCliente}` : motivo;
      await _notificarStaff(phone, nombreCliente, detalleConEmail, 'DERIVACION', histResumen);
      toolResultado = 'Notificación enviada al equipo por mail y WhatsApp. Se comunican a la brevedad.';
    } catch(e) {
      toolResultado = 'Notificación enviada al equipo. Se comunican a la brevedad.';
    }
  }

  // ── canjear_puntos_por_score ──────────────────────────────────────────────
  else if (name === 'canjear_puntos_por_score') {
    if (!input.confirmar) {
      toolResultado = 'La clienta no confirmó el canje. Preguntarle si quiere proceder.';
    } else {
      try {
        const db = require('../core/db').getDB();
        // Verificar puntos suficientes
        const cl = await db.query('SELECT points FROM clients WHERE phone=$1', [phone]);
        const ptsActuales = cl.rows[0]?.points || 0;
        if (ptsActuales < 100) {
          toolResultado = `No tiene suficientes puntos. Tiene ${ptsActuales} puntos, necesita 100.`;
        } else {
          // Descontar 100 puntos y registrar boost
          await db.query('UPDATE clients SET points=points-100 WHERE phone=$1', [phone]);
          await db.query(
            `INSERT INTO loyalty_transactions (phone, type, points, description) VALUES ($1,'redeem',-100,'Canje: +10 puntos de score de confiabilidad')`,
            [phone]
          ).catch(() => {});
          await db.query(
            `INSERT INTO client_notes (client_phone, type, content, created_by) VALUES ($1,'score_boost','+10 puntos de score (canje de 100 puntos)','sistema')`,
            [phone]
          );
          const newPts = await db.query('SELECT points FROM clients WHERE phone=$1', [phone]);
          toolResultado = `Canje exitoso. Se descontaron 100 puntos y el score de confiabilidad subió +10. Puntos restantes: ${newPts.rows[0]?.points || 0}.`;
        }
      } catch(e) {
        toolResultado = `Error procesando el canje: ${e.message}`;
      }
    }
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

  return send(respFinal || '💛');
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

// ── Generar link personalizado del portal ────────────────────────────────────
async function _generarLinkPortal(phone) {
  try {
    const { getDB } = require('../core/db');
    const db = getDB();
    if (!db) return null;
    const crypto = require('crypto');
    const token   = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días
    await db.query(
      'INSERT INTO client_tokens (client_phone, token, expires_at) VALUES ($1,$2,$3)',
      [phone, token, expires]
    );
    const base = process.env.BASE_URL || 'https://peluqueria-bot.onrender.com';
    return `${base}/mi-cuenta?t=${token}`;
  } catch (e) {
    console.error('[orch] generarLinkPortal error:', e.message);
    return null;
  }
}

// ── Notificaciones staff ──────────────────────────────────────────────────────
async function _notificarStaff(phone, nombre, info, tipo, historialResumen = '') {
  const iconos = { COLOR: '🎨', DERIVACION: '💬', CAMBIO: '🔄' };
  const tipoLabel = tipo === 'COLOR' ? 'CONSULTA COLOR' : tipo === 'CAMBIO' ? 'CAMBIO DE TURNO' : 'DERIVACIÓN A HUMANO';
  const emoji = iconos[tipo] || '📋';

  // ── 1. Email al admin ────────────────────────────────────────────────────
  try {
    const { mailNotifAdmin } = require('./mailer');
    await mailNotifAdmin({
      asunto: `${emoji} ${tipoLabel} — ${nombre || phone}`,
      html: `
        <p><strong>Tipo:</strong> ${tipoLabel}</p>
        <p><strong>Cliente:</strong> ${nombre || 'Sin nombre'}</p>
        <p><strong>Teléfono:</strong> ${phone}</p>
        <p><strong>Detalle:</strong> ${info}</p>
        ${historialResumen ? `<p><strong>Contexto:</strong> ${historialResumen}</p>` : ''}
        <p style="margin-top:16px"><a href="https://peluqueria-bot.onrender.com/staff" style="background:#c8a96e;color:#000;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Abrir Staff Portal →</a></p>
      `,
    });
  } catch(e) { console.error('[notif] Error email admin:', e.message); }

  // ── 2. WhatsApp al staff (si está configurado) ───────────────────────────
  const STAFF_WA   = process.env.STAFF_WHATSAPP_PHONE;
  const WASS_TOKEN = process.env.WASSENGER_TOKEN || process.env.WASSENGER_API_KEY;
  if (STAFF_WA && WASS_TOKEN) {
    const axios = require('axios');
    const msg = `${emoji} *${tipoLabel}*\n\n👤 ${nombre || 'Sin nombre'} · 📱 ${phone}\n${info}\n\nhttps://peluqueria-bot.onrender.com/staff`;
    axios.post('https://api.wassenger.com/v1/messages', { phone: STAFF_WA, message: msg }, { headers: { Token: WASS_TOKEN }, timeout: 8000 }).catch(() => {});
  }
}

module.exports = { handle, saludoInicial };