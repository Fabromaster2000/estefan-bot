// ── AGENT: ORCHESTRATOR ───────────────────────────────────────────────────────
// Coordina todos los agentes. Es el único que habla con el usuario.
// Recibe el mensaje, decide qué agente(s) activar, y devuelve la respuesta.
//
// FLUJO:
//   1. Intake: identificar cliente
//   2. Personal: interpretar intención con contexto
//   3. Según intención → Booking / Loyalty / etc.
//   4. Memory: actualizar en background

const intake   = require('./intake');
const personal = require('./personal');
const booking  = require('./booking');
const loyalty  = require('./loyalty');
const memory   = require('./memory');
const { getUpsell, getPersonalizedUpsell } = require('./upsell');
const SERVICIOS = require('../core/servicios');
const { getSession } = require('../core/session');
const { conversationLog, clientGet, clientUpdateProfile, loyaltyGetBalance } = require('../core/db');
const { syncClientesToSheet } = require('../core/sheets');

// ── Mensajes del sistema ──────────────────────────────────────────────────────
const MSGS = {
  servicios: () => `💇 *¿Qué servicio querés?*

✂️ *Cortes*
  1 — Corte de pelo · $50.000
  2 — Corte + Brushing · $70.000
  3 — Brushing / Planchita · $20.000
  4 — Lavado + Aireado · $15.000

💆 *Spa & Tratamientos*
  5 — Ozono · $30.000
  6 — Head Spa completo · $120.000
  7 — Ampolla · $30.000

🎨 *Color*
  8 — Retoque / Raíz · $60.000
  9 — Color entero · desde $80.000
  10 — Contorno · $80.000
  11 — Balayage · desde $200.000
  12 — Decoloración total · desde $200.000

💐 *Peinados*
  13 — Fiesta / 15 años · desde $60.000
  14 — Novia · desde $150.000

_Respondé con el número_ 👆`,

  precios: () => `💈 *Servicios y Precios*

✂️ *Cortes*
  • Corte de pelo: *$50.000*
  • Brushing / Planchita: *+$20.000*
  • Lavado + Aireado: *$15.000*

🎨 *Color*
  • Retoque / Raíz: *$60.000*
  • Color entero: *desde $80.000*
  • Contorno: *$80.000*
  • Balayage: *desde $200.000* ⚠️ requiere consulta
  • Decoloración total: *desde $200.000*

💐 *Peinados*
  • Fiesta / 15 años: *desde $60.000*
  • Novia: *desde $150.000*

💆 *Head Spa*
  • Ozono (15 min): *$30.000*
  • Head Spa completo: *$120.000*

✨ *Adicionales*
  • Ampolla: *$30.000*

_Escribí *reservar* para sacar un turno_ 💛`,

  turnoEncontrado: (b) => `📋 *Tu turno:*

👤 ${b.nombre}
✂️ ${b.servicio}
📅 ${b.fecha} · ⏰ ${b.hora}
🔖 ${b.code}
📊 ${b.estado || 'Confirmado'}

¿Qué querés hacer?
1️⃣ Cambiar fecha/hora
2️⃣ Cancelar turno
3️⃣ Volver`,

  confirmar: (d) => {
    const p = d.servicio.precio.toLocaleString('es-AR');
    let msg = `📋 *Resumen de tu turno:*\n\n`;
    msg += `👤 *${d.nombre}*\n`;
    msg += `✂️ ${d.servicio.nombre}\n`;
    msg += `📅 ${d.dia} · ⏰ ${d.hora}\n`;
    msg += `💰 $${p}`;
    if (d.extra) {
      msg += `\n✨ + ${d.extra.nombre} ($${d.extra.precio.toLocaleString('es-AR')})`;
      msg += `\n💰 *Total: $${(d.servicio.precio + d.extra.precio).toLocaleString('es-AR')}*`;
    }
    if (d.servicio.seña) {
      const base = d.servicio.precio + (d.extra?.precio || 0);
      const seña = Math.round(base * d.servicio.pct / 100).toLocaleString('es-AR');
      msg += `\n⚠️ Requiere seña del ${d.servicio.pct}% — $${seña}`;
    }
    const pts = Math.floor((d.servicio.precio + (d.extra?.precio||0)) / 1000);
    if (pts > 0) msg += `\n⭐ Ganás *+${pts} puntos* con este turno`;
    msg += `\n\n✅ *¿Confirmamos?* · sí / no`;
    return msg;
  },

  turnoConfirmado: (nombre, servicio, fechaDisplay, hora, code) =>
    `✅ *¡Listo, ${nombre}!* 💛\n\n📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n_Guardá el código — con ese podés cambiar o cancelar cuando quieras_ 😊`,
};

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────────
async function handle({ sessionId, phone, text }) {
  const t  = (text||'').trim();
  const tl = t.toLowerCase();
  const session = getSession(sessionId);
  if (!session.data) session.data = {};
  if (!session.historial) session.historial = [];

  await conversationLog(phone, 'user', t);
  console.log(`[orch] step=${session.step} | "${t.substring(0,50)}"`);

  const send = async (msg) => { await conversationLog(phone, 'assistant', msg); return msg; };

  // ── Atajos globales ───────────────────────────────────────────────────────
  if (/^(\.?menu|menú|inicio|volver|start)$/i.test(tl)) {
    session.step = 'LIBRE'; session.data = {};
    const clientCtx = await intake.buildContext(phone);
    return send(await personal.greet({ clientCtx }));
  }
  if (/hablar.*persona|quiero.*humano|hablar.*alguien|agente/i.test(tl)) {
    return send('Te conecto con alguien del equipo — te responden en menos de 2 horas 💛');
  }

  // ── Menú numérico directo ─────────────────────────────────────────────────
  if (session.step === 'LIBRE' && /^[1-4]$/.test(t)) {
    const n = parseInt(t);
    if (n === 1) { session.step = 'RESERVANDO'; session.data = {}; return send('¡Dale! 💛 ¿Cuál es tu nombre?'); }
    if (n === 2) { session.step = 'BUSCANDO_TURNO'; session.data = {}; return send('Ingresá tu *código* (ej: #AB12) o tu nombre 🔍'); }
    if (n === 3) { return send(MSGS.precios()); }
    if (n === 4) { return send('Te conecto con alguien del equipo 💛'); }
  }

  // ── Steps críticos: sí/no sin pasar por Haiku ─────────────────────────────
  if (session.step === 'CONFIRM_TURNO') {
    if (/^(s[ií]|dale|ok|va|claro|confirmo|bueno|perfecto)/i.test(tl)) return await doCreateBooking(session, phone, send);
    if (/^(no\b|nop|mejor no)/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('Perfecto, no reservé nada 😊\n\nCuando quieras, acá estoy 💛'); }
    return send(MSGS.confirmar(session.data));
  }
  if (session.step === 'CONFIRM_CANCELAR') {
    if (/^(s[ií]|dale|ok|si cancelar)/i.test(tl)) return await doCancelBooking(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cancelé nada 😊');
  }
  if (session.step === 'CONFIRM_REPROGRAM') {
    if (/^(s[ií]|dale|ok|va|claro)/i.test(tl)) return await doReschedule(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cambié nada 😊');
  }

  // ── Post-confirmación: email, apellido, promo ─────────────────────────────
  if (session.step === 'PEDIR_EMAIL_RESERVA') {
    const emailMatch = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      session.data.email = emailMatch[0];
    }
    // Avanzar siempre (con o sin email)
    session.data.emailPreguntado = true;
    session.step = 'RESERVANDO';
    const clientCtx2 = await intake.buildContext(phone);
    return await avanzarReserva(session, phone, {}, send, clientCtx2);
  }

  if (session.step === 'PEDIR_EMAIL') {
    const emailMatch = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      session.data.email = emailMatch[0];
      const { addGuestToCalendarEvent } = require('../core/calendar');
      const { mailTurnoConfirmado } = require('./mailer');
      if (session.lastCalendarEventId) await addGuestToCalendarEvent(session.lastCalendarEventId, emailMatch[0]).catch(()=>{});
      if (session.lastBooking) {
        const b = session.lastBooking;
        mailTurnoConfirmado({ to: emailMatch[0], nombre: b.nombre, servicio: b.servicio, fecha: b.fecha, hora: b.hora, code: b.code, calendarLink: b.calLink, monto: b.monto, senaAmount: null }).catch(()=>{});
      }
      session.step = 'PEDIR_APELLIDO';
      return send(`✅ ¡Invitación enviada a *${emailMatch[0]}*! 📆\n\n¿Me decís tu apellido para sumarte al programa de beneficios? 💛\n_(o *no* para saltear)_`);
    }
    if (/^no\b/i.test(tl)) { session.step = 'PEDIR_APELLIDO'; return send('¿Me decís tu apellido? 💛 _(o *no* para saltear)_'); }
    return send('Escribí tu *mail* o *no* para saltear 😊');
  }
  if (session.step === 'PEDIR_APELLIDO') {
    if (/^no\b/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Todo listo! Te esperamos 💛'); }
    if (t.length > 1 && t.length < 60) {
      // Extraer solo el apellido — ignorar frases como "mi apellido es X"
      const apellidoMatch = t.match(/(?:es|apellido es|llamo|soy)\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)/i);
      session.data.apellido = apellidoMatch ? apellidoMatch[1].trim() : t.trim();
      session.step = 'PEDIR_PROMO';
      return send(`¿Querés que te avisemos de descuentos y sorteos? 🎁\n\n1 — Sí, me interesa\n2 — No, gracias`);
    }
    return send('¿Cuál es tu apellido? _(o *no* para saltear)_');
  }
  if (session.step === 'PEDIR_PROMO') {
    const si = /^(1|s[ií]|dale|ok|claro)/i.test(tl);
    const no = /^(2|no\b|nop)/i.test(tl);
    if (si || no) {
      await clientUpdateProfile(phone, { lastName: session.data.apellido||null, email: session.data.email||null, promoOptIn: si, profileComplete: !!(session.data.apellido && session.data.email) });
      syncClientesToSheet().catch(()=>{});
      console.log(`[orch] Perfil guardado: ${session.data.apellido} ${session.data.email} promo=${si}`);
      session.step = 'LIBRE'; session.data = {};
      return send(si ? '¡Genial! Ya estás en el programa de beneficios 🎉 Te avisamos de todo 💛' : 'Perfecto 👍');
    }
    return send('Respondé *1* para sí o *2* para no 😊');
  }

  // ── Loyalty: canjes y puntos ──────────────────────────────────────────────
  if (session.step === 'LOYALTY_CANJE') {
    const n = parseInt(tl);
    if (n > 0 && session.data.availableRewards) {
      const reward = session.data.availableRewards[n - 1];
      if (reward) {
        const result = await loyalty.redeem(phone, reward.id);
        session.step = 'LIBRE'; session.data = {};
        return send(result.msg);
      }
    }
    if (/^no\b|volver/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Cuando quieras! 💛'); }
  }

  // ── Buscar turno ──────────────────────────────────────────────────────────
  if (session.step === 'BUSCANDO_TURNO') {
    const found = await booking.findBooking(t, phone);
    if (found) {
      session.data.booking = found;
      session.step = 'OPCION_TURNO';
      return send(MSGS.turnoEncontrado(found));
    }
    return send('No encontré un turno 😅 Ingresá tu *código* (ej: #AB12) o tu *nombre completo*:');
  }
  if (session.step === 'OPCION_TURNO') {
    const n = parseInt(tl);
    const b = session.data.booking;
    if (n === 1 || /cambiar|reprograma/i.test(tl)) {
      session.step = 'REPROGRAM_DATOS';
      return send(`¿A qué *día y hora* querés cambiar?\n_Podés decirme todo junto: "el viernes a las 15"_ 📅`);
    }
    if (n === 2 || /cancelar/i.test(tl)) {
      session.step = 'CONFIRM_CANCELAR';
      return send(`⚠️ ¿Confirmás que querés *cancelar*?\n\n✂️ ${b?.servicio}\n📅 ${b?.fecha} · ⏰ ${b?.hora}\n\n*sí* / *no*`);
    }
    session.step = 'LIBRE'; session.data = {};
    return send('¡Listo! ¿En qué más te puedo ayudar? 💛');
  }

  // ── Reprogramar: Haiku extrae día y hora ─────────────────────────────────
  if (session.step === 'REPROGRAM_DATOS') {
    const clientCtx = await intake.buildContext(phone);
    const parsed = await personal.interpret({ text: t, clientCtx, historial: session.historial, step: session.step });
    if (parsed.dia)  session.data.newDia  = parsed.dia;
    if (parsed.hora) session.data.newHora = parsed.hora;
    if (session.data.newDia && session.data.newHora) {
      const b = session.data.booking;
      session.step = 'CONFIRM_REPROGRAM';
      return send(`📋 *Confirmá el cambio:*\n\n✂️ ${b?.servicio}\n📅 *${session.data.newDia}* · ⏰ *${session.data.newHora}*\n\n*sí* / *no*`);
    }
    if (!session.data.newDia) return send('¿Qué *día* te viene bien? (lunes a sábado)');
    return send(`¿A qué *hora* el ${session.data.newDia}? (10:00 a 20:00hs)`);
  }

  // Upsell — interceptar ANTES de Haiku
  if (session.step === 'UPSELL') {
    const u = session.data.pendingUpsell;
    const acepta = /^(1|s[ií]|dale|ok|claro|quiero|sí|si)$/i.test(tl);
    const rechaza = /^(2|no\b|nop|nel|paso)$/i.test(tl);
    if (acepta) {
      session.data.extra = SERVICIOS.findById(u?.targetId);
      console.log(`[orch] UPSELL aceptado: ${session.data.extra?.nombre}`);
    }
    session.data.pendingUpsell = null;
    session.step = 'CONFIRM_TURNO';
    return send(MSGS.confirmar(session.data));
  }

  // Charla libre / saludo
  const texto = parsed.texto || '¿En qué te puedo ayudar? 💛';
  if (session.step === 'LIBRE') {
    // Actualizar memoria en background
    memory.update(phone, clientCtx?.client, t).catch(()=>{});
    return send(texto);
  }
  return send(texto);
  // ── HAIKU interpreta todo lo demás ───────────────────────────────────────
  const clientCtx = await intake.buildContext(phone);
  const parsed = await personal.interpret({ text: t, clientCtx, historial: session.historial, step: session.step });

  // Acumular datos del cliente que vayan apareciendo
  if (parsed.nombre   && !session.data.nombre)   session.data.nombre   = parsed.nombre.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
  if (parsed.servicio && !session.data.servicio)  session.data.servicio = SERVICIOS.findByName(parsed.servicio);
  if (parsed.dia      && !session.data.dia)       session.data.dia      = parsed.dia;
  if (parsed.hora     && !session.data.hora)      session.data.hora     = parsed.hora;

  // Guardar en historial
  session.historial.push({ role: 'user', content: t });
  session.historial.push({ role: 'assistant', content: parsed.texto || '' });
  if (session.historial.length > 16) session.historial = session.historial.slice(-16);

  // ── Routing por intención ─────────────────────────────────────────────────
  const intent = parsed.intent;

  if (intent === 'PRECIO') {
    // parsed.texto ya puede mencionar precios — usarlo solo si no inventa valores
    const intro = parsed.texto && !/\$[0-9]/.test(parsed.texto) ? parsed.texto + '\n\n' : '';
    return send(intro + MSGS.precios());
  }

  if (intent === 'LOYALTY' || /puntos|beneficio|canje|premio/i.test(tl)) {
    const result = await loyalty.showBalance(phone);
    if (result.available.length > 0) {
      session.data.availableRewards = result.available;
      session.step = 'LOYALTY_CANJE';
      return send(result.msg + '\n\n_Respondé con el número para canjear, o *no* para volver_ 💛');
    }
    return send(result.msg);
  }

  if (intent === 'GESTIONAR' || intent === 'CANCELAR') {
    session.step = 'BUSCANDO_TURNO'; session.data = { accion: intent };
    if (parsed.codigo) {
      const found = await booking.findBooking(parsed.codigo, phone);
      if (found) { session.data.booking = found; session.step = 'OPCION_TURNO'; return send(MSGS.turnoEncontrado(found)); }
    }
    return send(`${parsed.texto || 'Claro'} 🔍 Ingresá tu *código* (ej: #AB12) o tu *nombre*:`);
  }

  if (intent === 'RESERVAR' || session.step === 'RESERVANDO') {
    session.step = 'RESERVANDO';
    return await avanzarReserva(session, phone, parsed, send, clientCtx);
  }

  // En estado RESERVANDO, seguir acumulando aunque intent no sea RESERVAR
  if (session.step === 'RESERVANDO') {
    return await avanzarReserva(session, phone, parsed, send, clientCtx);
  }


}

async function avanzarReserva(session, phone, parsed, send, clientCtx) {
  const d = session.data;
  const haikuTexto = parsed?.texto;

  if (d.servicio?.consulta && !d.consultaOk) {
    session.step = 'CONSULTA_PREVIA';
    return send(`Para *${d.servicio.nombre}* necesito preguntarte: ¿te hiciste alisado, keratina o botox en los últimos 6 meses?\n\n1 — No\n2 — Sí`);
  }

  if (!d.nombre) {
    return send(haikuTexto || '¿Cuál es tu nombre? 😊');
  }
  if (!d.servicio) {
    return send((haikuTexto ? haikuTexto + '\n\n' : '') + MSGS.servicios());
  }
  if (!d.dia) {
    return send((haikuTexto ? haikuTexto + '\n\n' : '') + `📅 ¿Qué día te viene bien?\n\nAtendemos *lunes a sábado, 10:00 a 20:00hs*\n\nEscribí: lunes · martes · miércoles · jueves · viernes · sábado`);
  }
  if (!d.hora) {
    return send((haikuTexto ? haikuTexto + '\n\n' : '') + `⏰ ¿A qué hora el ${d.dia}?\n\nHorario: 10:00 a 20:00hs\n\nEj: _"14:00"_ · _"4 de la tarde"_ · _"10 y media"_`);
  }
  // Pedir email antes de upsell (si no lo tenemos aún)
  if (!d.emailPreguntado) {
    d.emailPreguntado = true;
    // Chequear si ya lo tenemos del cliente o del mensaje de Haiku
    const clientEmail = clientCtx?.client?.email;
    if (parsed?.email) {
      d.email = parsed.email;
    } else if (clientEmail) {
      d.email = clientEmail;
    } else {
      session.step = 'PEDIR_EMAIL_RESERVA';
      return send(`¿Cuál es tu email? Te mando la confirmación del turno ✉️\n_(o *no* para saltear)_`);
    }
  }

  // Todo completo → upsell o confirmar
  const recentBookings = clientCtx?.recentBookings || [];
  const upsell = getPersonalizedUpsell(d.servicio.id, recentBookings);
  if (upsell && !d.upsellOfrecido) {
    d.pendingUpsell = upsell;
    d.upsellOfrecido = true;
    session.step = 'UPSELL';
    return send(upsell.msg);
  }

  session.step = 'CONFIRM_TURNO';
  return send(MSGS.confirmar(d));
}

// ── Ejecutar acciones ─────────────────────────────────────────────────────────
async function doCreateBooking(session, phone, send) {
  try {
    const d = session.data;
    const client = await clientGet(phone);
    const result = await booking.create({ sessionId: session.id, nombre: d.nombre, phone, servicio: d.servicio, extra: d.extra, dia: d.dia, hora: d.hora, email: null }); // email se manda después

    const { formatFecha } = require('../core/utils');
    const fechaDisplay = await formatFecha(result.fechaReal);

    session.lastCalendarEventId = result.calendarEventId;
    session.lastBooking = { nombre: d.nombre, servicio: d.servicio.nombre, fecha: result.fechaReal, hora: result.horaReal, code: result.code, calLink: result.calLink, monto: result.monto };
    session.step = 'PEDIR_EMAIL';

    const ptsMsg = result.pointsEarned > 0 ? `\n⭐ Ganaste *+${result.pointsEarned} puntos*` : '';
    return send(MSGS.turnoConfirmado(d.nombre, d.servicio.nombre + (d.extra ? ' + ' + d.extra.nombre : ''), fechaDisplay, result.horaReal, result.code)
      + ptsMsg
      + '\n\n¿Querés recibir la confirmación por mail? ✉️\nEscribí tu *mail* o *no* para saltear');
  } catch(e) {
    console.error('[orch] Error creando turno:', e.message);
    session.step = 'LIBRE';
    return send('Ups, hubo un problema técnico 😅 Intentá de nuevo o escribí "hablar con alguien".');
  }
}

async function doCancelBooking(session, phone, send) {
  try {
    const client = await clientGet(phone);
    await booking.cancel({ bookingData: session.data.booking, phone, email: session.data.email || client?.email });
    session.step = 'LIBRE'; session.data = {};
    return send('✅ Tu turno fue *cancelado* 💛\n\nCuando quieras reservar de nuevo, acá estamos.');
  } catch(e) {
    console.error('[orch] Error cancelando:', e.message);
    session.step = 'LIBRE';
    return send('Hubo un problema técnico 😅 Escribí "hablar con alguien".');
  }
}

async function doReschedule(session, phone, send) {
  try {
    const client = await clientGet(phone);
    const result = await booking.reschedule({ bookingData: session.data.booking, newDia: session.data.newDia, newHora: session.data.newHora, phone, email: session.data.email || client?.email, sessionId: session.id });
    const { formatFecha } = require('../core/utils');
    const fechaDisplay = await formatFecha(result.fechaReal);
    session.step = 'LIBRE'; session.data = {};
    return send(`✅ *¡Turno reprogramado!* 💛\n\n📅 ${fechaDisplay}\n⏰ ${result.horaReal}\n🔖 Nuevo código: *${result.code}*`);
  } catch(e) {
    console.error('[orch] Error reprogramando:', e.message);
    session.step = 'LIBRE';
    return send('Hubo un problema técnico 😅 Escribí "hablar con alguien".');
  }
}

module.exports = { handle, MSGS };
