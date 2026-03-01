// ── AGENT: ORCHESTRATOR ───────────────────────────────────────────────────────
'use strict';

const intake   = require('./intake');
const personal = require('./personal');
const booking  = require('./booking');
const loyalty  = require('./loyalty');
const memory   = require('./memory');
const { getPersonalizedUpsell } = require('./upsell');
const SERVICIOS = require('../core/servicios');
const { getSession } = require('../core/session');
const { conversationLog, clientGet, clientUpdateProfile } = require('../core/db');
const { syncClientesToSheet } = require('../core/sheets');

const MSGS = {
  servicios: () => `💇 *¿Qué servicio querés?*\n\n✂️ *Cortes*\n  1 — Corte de pelo · $50.000\n  2 — Corte + Brushing · $70.000\n  3 — Brushing / Planchita · $20.000\n  4 — Lavado + Aireado · $15.000\n\n💆 *Spa & Tratamientos*\n  5 — Ozono · $30.000\n  6 — Head Spa completo · $120.000\n  7 — Ampolla · $30.000\n\n🎨 *Color*\n  8 — Retoque / Raíz · $60.000\n  9 — Color entero · desde $80.000\n  10 — Contorno · $80.000\n  11 — Balayage · desde $200.000\n  12 — Decoloración total · desde $200.000\n\n💐 *Peinados*\n  13 — Fiesta / 15 años · desde $60.000\n  14 — Novia · desde $150.000\n\n_Respondé con el número_ 👆`,

  precios: () => `💈 *Servicios y Precios*\n\n✂️ *Cortes*\n  • Corte de pelo: *$50.000*\n  • Brushing / Planchita: *+$20.000*\n  • Lavado + Aireado: *$15.000*\n\n🎨 *Color*\n  • Retoque / Raíz: *$60.000*\n  • Color entero: *desde $80.000*\n  • Balayage: *desde $200.000* ⚠️ requiere consulta\n  • Decoloración total: *desde $200.000*\n\n💐 *Peinados*\n  • Fiesta / 15 años: *desde $60.000*\n  • Novia: *desde $150.000*\n\n💆 *Head Spa*\n  • Ozono: *$30.000*\n  • Head Spa completo: *$120.000*\n\n✨ *Adicionales*\n  • Ampolla: *$30.000*\n\n_Escribí *reservar* para sacar un turno_ 💛`,

  turnoEncontrado: (b) => `📋 *Tu turno:*\n\n👤 ${b.nombre}\n✂️ ${b.servicio}\n📅 ${b.fecha} · ⏰ ${b.hora}\n🔖 ${b.code}\n\n¿Qué querés hacer?\n1️⃣ Cambiar fecha/hora\n2️⃣ Cancelar turno\n3️⃣ Volver`,

  confirmar: (d) => {
    const base = d.servicio.precio + (d.extra?.precio || 0);
    let msg = `📋 *Resumen de tu turno:*\n\n`;
    msg += `👤 *${d.nombre}*\n`;
    msg += `✂️ ${d.servicio.nombre}`;
    if (d.extra) msg += ` + ${d.extra.nombre}`;
    msg += `\n📅 ${d.dia} · ⏰ ${d.hora}\n`;
    msg += `💰 $${base.toLocaleString('es-AR')}`;
    if (d.extra) msg += ` _(corte $${d.servicio.precio.toLocaleString('es-AR')} + ${d.extra.nombre} $${d.extra.precio.toLocaleString('es-AR')})_`;
    if (d.servicio.seña) {
      const seña = Math.round(base * (d.servicio.pct || 10) / 100).toLocaleString('es-AR');
      msg += `\n⚠️ Requiere seña del ${d.servicio.pct}% — $${seña}`;
    }
    const pts = Math.floor(base / 1000);
    if (pts > 0) msg += `\n⭐ Ganás *+${pts} puntos* con este turno`;
    msg += `\n\n✅ *¿Confirmamos?* · sí / no`;
    return msg;
  },

  turnoConfirmado: (nombre, servicio, fechaDisplay, hora, code) =>
    `✅ *¡Listo, ${nombre}!* 💛\n\n📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n_Guardá el código — con ese podés cambiar o cancelar cuando quieras_ 😊`,
};

async function handle({ sessionId, phone, text }) {
  const t   = (text || '').trim();
  const tl  = t.toLowerCase();
  const session = getSession(sessionId);
  if (!session.data)      session.data      = {};
  if (!session.historial) session.historial = [];

  await conversationLog(phone, 'user', t);
  console.log(`[orch] step=${session.step} | "${t.substring(0, 50)}"`);

  const send = async (msg) => { await conversationLog(phone, 'assistant', msg); return msg; };

  // 1. Atajos globales
  if (/^(\.?menu|menú|inicio|volver|start)$/i.test(tl)) {
    session.step = 'LIBRE'; session.data = {};
    return send(await personal.greet({ clientCtx: await intake.buildContext(phone) }));
  }
  if (/hablar.*persona|quiero.*humano|hablar.*alguien|agente/i.test(tl)) {
    return send('Te conecto con alguien del equipo — te responden en menos de 2 horas 💛');
  }

  // 2. Menú numérico en LIBRE
  if (session.step === 'LIBRE' && /^[1-4]$/.test(t)) {
    const n = parseInt(t);
    if (n === 1) { session.step = 'RESERVANDO'; session.data = {}; return send('¡Dale! 💛 ¿Cuál es tu nombre?'); }
    if (n === 2) { session.step = 'BUSCANDO_TURNO'; return send('Ingresá tu *código* (ej: #AB12) o tu nombre 🔍'); }
    if (n === 3) return send(MSGS.precios());
    if (n === 4) return send('Te conecto con alguien del equipo 💛');
  }

  // 3. UPSELL — siempre antes de Haiku
  if (session.step === 'UPSELL') {
    const u = session.data.pendingUpsell;
    const acepta = /^(1|s[ií]|dale|ok|claro|quiero|si\b|sí\b|bueno|perfecto)/i.test(tl);
    if (acepta && u) {
      session.data.extra = SERVICIOS.findById(u.targetId);
      console.log(`[orch] UPSELL aceptado: ${session.data.extra?.nombre}`);
    } else {
      console.log('[orch] UPSELL rechazado');
    }
    session.data.pendingUpsell = null;
    session.step = 'CONFIRM_TURNO';
    return send(MSGS.confirmar(session.data));
  }

  // 4. Confirmaciones
  if (session.step === 'CONFIRM_TURNO') {
    if (/^(s[ií]|dale|ok|va|claro|confirmo|bueno|perfecto)/i.test(tl)) return await doCreateBooking(session, phone, send);
    if (/^(no\b|nop|mejor no)/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('Perfecto, no reservé nada 😊\n\nCuando quieras, acá estoy 💛'); }
    return send(MSGS.confirmar(session.data));
  }
  if (session.step === 'CONFIRM_CANCELAR') {
    if (/^(s[ií]|dale|ok)/i.test(tl)) return await doCancelBooking(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cancelé nada 😊');
  }
  if (session.step === 'CONFIRM_REPROGRAM') {
    if (/^(s[ií]|dale|ok|va|claro)/i.test(tl)) return await doReschedule(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cambié nada 😊');
  }

  // 5. Email dentro del flujo de reserva
  if (session.step === 'PEDIR_EMAIL_RESERVA') {
    const em = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (em) { session.data.email = em[0]; session.emailCollected = em[0]; }
    if (/^no/i.test(tl)) session.data.emailSkipped = true;
    session.data.emailPreguntado = true;
    session.step = 'RESERVANDO';
    return await avanzarReserva(session, phone, {}, send, await intake.buildContext(phone));
  }

  // 6. Post-confirmación
  if (session.step === 'PEDIR_EMAIL') {
    const em = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (em) {
      session.data.email = em[0];
      const { addGuestToCalendarEvent } = require('../core/calendar');
      const { mailTurnoConfirmado } = require('./mailer');
      if (session.lastCalendarEventId) await addGuestToCalendarEvent(session.lastCalendarEventId, em[0]).catch(() => {});
      if (session.lastBooking) {
        const b = session.lastBooking;
        mailTurnoConfirmado({ to: em[0], nombre: b.nombre, servicio: b.servicio, fecha: b.fecha, hora: b.hora, code: b.code, calendarLink: b.calLink, monto: b.monto, senaAmount: null }).catch(() => {});
      }
      session.step = 'PEDIR_APELLIDO';
      return send(`✅ ¡Invitación enviada a *${em[0]}*! 📆\n\n¿Me decís tu apellido para sumarte al programa de beneficios? 💛\n_(o *no* para saltear)_`);
    }
    if (/^no\b/i.test(tl)) { session.step = 'PEDIR_APELLIDO'; return send('¿Me decís tu apellido? 💛 _(o *no* para saltear)_'); }
    return send('Escribí tu *mail* o *no* para saltear 😊');
  }
  if (session.step === 'PEDIR_APELLIDO') {
    if (/^no\b/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Todo listo! Te esperamos 💛'); }
    if (t.length > 1 && t.length < 60) {
      const m = t.match(/(?:es|apellido es|llamo|soy)\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)/i);
      session.data.apellido = m ? m[1].trim() : t.trim();
      session.step = 'PEDIR_PROMO';
      return send(`¿Querés que te avisemos de descuentos y sorteos? 🎁\n\n1 — Sí, me interesa\n2 — No, gracias`);
    }
    return send('¿Cuál es tu apellido? _(o *no* para saltear)_');
  }
  if (session.step === 'PEDIR_PROMO') {
    const si = /^(1|s[ií]|dale|ok|claro)/i.test(tl);
    const no = /^(2|no\b|nop)/i.test(tl);
    if (si || no) {
      await clientUpdateProfile(phone, { lastName: session.data.apellido || null, email: session.data.email || null, promoOptIn: si, profileComplete: !!(session.data.apellido && session.data.email) });
      syncClientesToSheet().catch(e => console.error('[sheets] sync error:', e.message));
      session.step = 'LIBRE'; session.data = {};
      return send(si ? '¡Genial! Ya estás en el programa de beneficios 🎉 Te avisamos de todo 💛' : 'Perfecto 👍');
    }
    return send('Respondé *1* para sí o *2* para no 😊');
  }

  // 7. Loyalty
  if (session.step === 'LOYALTY_CANJE') {
    const n = parseInt(tl);
    if (n > 0 && session.data.availableRewards?.[n - 1]) {
      const result = await loyalty.redeem(phone, session.data.availableRewards[n - 1].id);
      session.step = 'LIBRE'; session.data = {};
      return send(result.msg);
    }
    if (/^(no\b|volver)/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Cuando quieras! 💛'); }
  }

  // 8. Buscar turno
  if (session.step === 'BUSCANDO_TURNO') {
    const found = await booking.findBooking(t, phone);
    if (found) { session.data.booking = found; session.step = 'OPCION_TURNO'; return send(MSGS.turnoEncontrado(found)); }
    return send('No encontré un turno 😅 Ingresá tu *código* (ej: #AB12) o tu *nombre completo*:');
  }
  if (session.step === 'OPCION_TURNO') {
    const n = parseInt(tl);
    const b = session.data.booking;
    if (n === 1 || /cambiar|reprograma/i.test(tl)) { session.step = 'REPROGRAM_DATOS'; return send(`¿A qué *día y hora* querés cambiar?\n_Ej: "el viernes a las 15"_ 📅`); }
    if (n === 2 || /cancelar/i.test(tl)) { session.step = 'CONFIRM_CANCELAR'; return send(`⚠️ ¿Confirmás que querés *cancelar*?\n\n✂️ ${b?.servicio}\n📅 ${b?.fecha} · ⏰ ${b?.hora}\n\n*sí* / *no*`); }
    session.step = 'LIBRE'; session.data = {};
    return send('¡Listo! ¿En qué más te puedo ayudar? 💛');
  }

  // 9. Reprogramar
  if (session.step === 'REPROGRAM_DATOS') {
    const p2 = await personal.interpret({ text: t, clientCtx: await intake.buildContext(phone), historial: session.historial, step: session.step });
    if (p2.dia)  session.data.newDia  = p2.dia;
    if (p2.hora) session.data.newHora = p2.hora;
    if (session.data.newDia && session.data.newHora) {
      const b = session.data.booking;
      session.step = 'CONFIRM_REPROGRAM';
      return send(`📋 *Confirmá el cambio:*\n\n✂️ ${b?.servicio}\n📅 *${session.data.newDia}* · ⏰ *${session.data.newHora}*\n\n*sí* / *no*`);
    }
    if (!session.data.newDia) return send('¿Qué *día* te viene bien? (lunes a sábado)');
    return send(`¿A qué *hora* el ${session.data.newDia}?`);
  }

  // 10. Haiku interpreta
  const clientCtx = await intake.buildContext(phone);
  const parsed = await personal.interpret({ text: t, clientCtx, historial: session.historial, step: session.step });

  if (parsed.nombre   && !session.data.nombre)   session.data.nombre   = parsed.nombre.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  if (parsed.servicio && !session.data.servicio)  session.data.servicio = SERVICIOS.findByName(parsed.servicio);
  // servicio2: cliente pide dos servicios a la vez
  if (parsed.servicio2 && !session.data.extra) {
    const srv2 = SERVICIOS.findByName(parsed.servicio2);
    if (srv2) { session.data.extra = srv2; session.data.upsellOfrecido = true; console.log(`[orch] servicio2 capturado: ${srv2.nombre}`); }
  }
  // Si pide dos servicios juntos (ej: "corte y ozono"), el segundo va como extra
  if (parsed.servicio2 && !session.data.extra) {
    const srv2 = SERVICIOS.findByName(parsed.servicio2);
    if (srv2) { session.data.extra = srv2; session.data.upsellOfrecido = true; }
  }
  if (parsed.dia      && !session.data.dia) {
    // Convertir "hoy" al nombre real del día en Argentina
    if (/^hoy$/i.test(parsed.dia)) {
      const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      session.data.dia = dias[now.getDay()];
    } else {
      session.data.dia = parsed.dia;
    }
  }
  if (parsed.hora     && !session.data.hora)      session.data.hora     = parsed.hora;
  if (parsed.email    && !session.data.email)     session.data.email    = parsed.email;

  session.historial.push({ role: 'user', content: t });
  session.historial.push({ role: 'assistant', content: parsed.texto || '' });
  if (session.historial.length > 16) session.historial = session.historial.slice(-16);

  const intent = parsed.intent;

  if (intent === 'PRECIO') {
    // Si ya tiene servicio acumulado y quiere reservar, combinar precio + avanzar
    if (session.data.servicio || session.data.nombre) {
      session.step = 'RESERVANDO';
      const intro = parsed.texto && !/\$[0-9]/.test(parsed.texto) ? parsed.texto + '\n\n' : '';
      const precios = MSGS.precios();
      // Devolver precios y en el próximo mensaje avanzar la reserva
      return send(intro + precios);
    }
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
    session.step = 'BUSCANDO_TURNO'; session.data = {};
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

  memory.update(phone, clientCtx?.client, t).catch(() => {});
  return send(parsed.texto || '¿En qué te puedo ayudar? 💛');
}

async function avanzarReserva(session, phone, parsed, send, clientCtx) {
  const d = session.data;
  if (d.servicio?.consulta && !d.consultaOk) {
    session.step = 'CONSULTA_PREVIA';
    return send(`Para *${d.servicio.nombre}* necesito preguntarte: ¿te hiciste alisado, keratina o botox en los últimos 6 meses?\n\n1 — No\n2 — Sí`);
  }
  if (!d.nombre) {
    // Si ya preguntamos el nombre y no lo dio, seguir igual sin nombre
    if (d.nombrePreguntado) {
      d.nombre = 'linda'; // placeholder para que fluya — se reemplaza si lo da después
    } else {
      d.nombrePreguntado = true;
      return send(parsed?.texto || '¿Cuál es tu nombre? 😊');
    }
  }
  if (!d.servicio) return send(MSGS.servicios());
  if (!d.dia)      return send(`📅 ¿Qué día te viene bien?\n\nAtendemos *lunes a sábado, 10:00 a 20:00hs*`);
  if (!d.hora)     return send(`⏰ ¿A qué hora el ${d.dia}?\n\nHorario: 10:00 a 20:00hs · Ej: _"14:00"_ · _"4 de la tarde"_`);

  if (!d.emailPreguntado) {
    d.emailPreguntado = true;
    const clientEmail = clientCtx?.client?.email || parsed?.email;
    if (clientEmail) {
      d.email = clientEmail;
    } else {
      session.step = 'PEDIR_EMAIL_RESERVA';
      return send(`¿Cuál es tu email? Te mando la confirmación del turno ✉️\n_(o *no* para saltear)_`);
    }
  }

  const upsell = getPersonalizedUpsell(d.servicio.id, clientCtx?.recentBookings || []);
  if (upsell && !d.upsellOfrecido) {
    d.pendingUpsell = upsell;
    d.upsellOfrecido = true;
    session.step = 'UPSELL';
    return send(upsell.msg);
  }

  session.step = 'CONFIRM_TURNO';
  return send(MSGS.confirmar(d));
}

async function doCreateBooking(session, phone, send) {
  try {
    const d = session.data;
    const result = await booking.create({ sessionId: session.id, nombre: d.nombre, phone, servicio: d.servicio, extra: d.extra, dia: d.dia, hora: d.hora, email: null });
    const { formatFecha } = require('../core/utils');
    const fechaDisplay = await formatFecha(result.fechaReal);
    session.lastCalendarEventId = result.calendarEventId;
    session.lastBooking = { nombre: d.nombre, servicio: d.servicio.nombre + (d.extra ? ' + ' + d.extra.nombre : ''), fecha: result.fechaReal, hora: result.horaReal, code: result.code, calLink: result.calLink, monto: result.monto };
    session.step = 'PEDIR_EMAIL';
    const ptsMsg = result.pointsEarned > 0 ? `\n⭐ Ganaste *+${result.pointsEarned} puntos*` : '';
    const srvDisplay = d.servicio.nombre + (d.extra ? ' + ' + d.extra.nombre : '');
    return send(MSGS.turnoConfirmado(d.nombre, srvDisplay, fechaDisplay, result.horaReal, result.code) + ptsMsg + '\n\n¿Querés recibir la confirmación por mail? ✉️\nEscribí tu *mail* o *no* para saltear');
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
