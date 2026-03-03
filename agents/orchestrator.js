// ── AGENT: ORCHESTRATOR ─────────────────────────────────────────────────────
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

  precios: () => `💈 *Servicios y Precios*\n\n✂️ *Cortes*\n  • Corte de pelo: *$50.000* (incluye lavado y aireado)\n  • Corte + Brushing: *$70.000*\n  • Brushing / Planchita: *$20.000*\n  • Lavado + Aireado: *$15.000*\n\n🎨 *Color*\n  • Retoque / Raíz: *$60.000*\n  • Color entero: *desde $80.000*\n  • Balayage: *desde $200.000* ⚠️ requiere consulta\n  • Decoloración total: *desde $200.000*\n\n💐 *Peinados*\n  • Fiesta / 15 años: *desde $60.000*\n  • Novia: *desde $150.000*\n\n💆 *Head Spa*\n  • Ozono: *$30.000*\n  • Head Spa completo: *$120.000*\n\n✨ *Adicionales*\n  • Ampolla: *$30.000*\n\n_Escribí *reservar* para sacar un turno_ 💛`,

  turnoEncontrado: (b) => `📋 *Tu turno:*\n\n👤 ${b.nombre}\n✂️ ${b.servicio}\n📅 ${b.fecha} · ⏰ ${b.hora}\n🔖 ${b.code}\n\n¿Qué querés hacer?\n1️⃣ Cambiar fecha/hora\n2️⃣ Cancelar turno\n3️⃣ Volver`,

  confirmar: (d) => {
    const base = d.servicio.precio + (d.extra?.precio || 0);
    let msg = `📋 *Resumen de tu turno:*\n\n`;
    if (d.nombre) msg += `👤 *${d.nombre}*\n`;
    msg += `✂️ ${d.servicio.nombre}`;
    if (d.extra) msg += ` + ${d.extra.nombre}`;
    msg += `\n📅 ${d.dia} · ⏰ ${d.hora}\n`;
    msg += `💰 $${base.toLocaleString('es-AR')}`;
    if (d.extra) msg += ` _(${d.servicio.nombre} $${d.servicio.precio.toLocaleString('es-AR')} + ${d.extra.nombre} $${d.extra.precio.toLocaleString('es-AR')})_`;
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
    `✅ *¡Listo${nombre ? ', ' + nombre : ''}!* 💛\n\n📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n_Guardá el código — con ese podés cambiar o cancelar cuando quieras_ 😊`,
};

function extractEmail(text) {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return matches.sort((a, b) => b.length - a.length)[0] || null;
}

function extractEmail(text) {
  // Encuentra todos los emails posibles, devuelve el más largo (más probable que sea correcto)
  const matches = (text || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return matches.sort((a, b) => b.length - a.length)[0] || null;
}

async function handle({ sessionId, phone, text }) {
  const t   = (text || '').trim();
  const tl  = t.toLowerCase();
  const session = getSession(sessionId);
  if (!session.data)      session.data      = {};
  if (!session.historial) session.historial = [];
  if (!session.profile)   session.profile   = {}; // persiste entre reservas: nombre, email

  await conversationLog(phone, 'user', t);
  console.log(`[orch] step=${session.step} | "${t.substring(0, 50)}"`);

  const send = async (msg) => { await conversationLog(phone, 'assistant', msg); return msg; };

  // ── Atajos globales ───────────────────────────────────────────────────────
  if (/^(\.?menu|menú|inicio|volver|start)$/i.test(tl)) {
    session.step = 'LIBRE'; session.data = {};
    return send(await personal.greet({ clientCtx: await intake.buildContext(phone) }));
  }
  if (/hablar.*persona|quiero.*humano|hablar.*alguien|agente/i.test(tl)) {
    return send('Te conecto con alguien del equipo — te responden en menos de 2 horas 💛');
  }

  // ── Menú numérico en LIBRE ────────────────────────────────────────────────
  if (session.step === 'LIBRE' && /^[1-4]$/.test(t)) {
    const n = parseInt(t);
    if (n === 1) { session.step = 'RESERVANDO'; session.data = { nombre: session.profile?.nombre, email: session.profile?.email, emailPreguntado: !!session.profile?.email, nombrePreguntado: !!session.profile?.nombre }; return send('¡Dale! 💛 ¿Qué servicio te gustaría hacerte?'); }
    if (n === 2) { session.step = 'BUSCANDO_TURNO'; return send('Ingresá tu *código* (ej: #AB12) o tu nombre 🔍'); }
    if (n === 3) return send(MSGS.precios());
    if (n === 4) return send('Te conecto con alguien del equipo 💛');
  }

  // ── COLOR — consulta previa completa ────────────────────────────────────────
  // Flujo: TIPO → DETALLE_PROCESO → DETALLE_TIEMPO → DETALLE_COLOR → PEDIR_FOTOS → cerrar
  // SIEMPRE deriva a staff — el bot recopila info, nunca confirma turno de color solo

  if (session.step === 'COLOR_CONSULTA_TIPO') {
    session.data.consultaProceso1 = t;
    const noPrevios = /^(1|no\b|nop|natural|virgen)/i.test(tl);
    if (noPrevios) {
      session.data.consultaProcesos = 'Sin procesos previos';
      session.step = 'COLOR_DETALLE_COLOR';
      return send(`¡Genial, pelo natural es ideal para trabajar! 💛\n\n¿Cuál sería el resultado que buscás? (ej: "rubia platinada", "castaño con reflejos dorados", "roja vibrante")\n\nEso ayuda al equipo a preparar todo de antemano ✨`);
    }
    session.step = 'COLOR_DETALLE_PROCESO';
    return send(`Entendido 💛 ¿Qué tipo de proceso tenés actualmente?\n\n1 — Tintura (color entero o raíz)\n2 — Decoloración o mechitas\n3 — Alisado / Keratina / Botox\n4 — Varios de los anteriores`);
  }

  if (session.step === 'COLOR_DETALLE_PROCESO') {
    session.data.consultaProcesos = t;
    session.data.consultaTieneAlistado = /alisado|keratina|botox|3/i.test(tl);
    session.step = 'COLOR_DETALLE_TIEMPO';
    return send(`¿Hace cuánto te hiciste ese proceso? (ej: "hace 2 semanas", "hace 3 meses", "más de un año") 📅`);
  }

  if (session.step === 'COLOR_DETALLE_TIEMPO') {
    session.data.consultaTiempo = t;
    session.step = 'COLOR_DETALLE_COLOR';
    return send(`¡Gracias! 💛 ¿Y cuál es el resultado que estás buscando?\n\nEj: "quiero ser rubia", "mechitas caramelo sobre el castaño", "rojo vibrante"... Cuanto más detalle, mejor se preparan las estilistas ✨`);
  }

  if (session.step === 'COLOR_DETALLE_COLOR') {
    session.data.consultaColorDeseado = t;
    session.step = 'COLOR_PEDIR_FOTOS';
    return send(`¡Perfecto, eso ayuda muchísimo! 💛\n\nÚltimo paso — ¿podés mandarnos *2 fotos*?\n\n📸 *Foto 1:* Tu pelo *hoy* (con buena luz, lo más natural posible)\n📸 *Foto 2:* Una *referencia* del resultado que querés (puede ser de Pinterest, Instagram, etc.)\n\nEstas fotos van directo al equipo para que evalúen el caso y te contacten con fecha, hora y todo lo que necesitás saber 💛`);
  }

  if (session.step === 'COLOR_PEDIR_FOTOS') {
    const srv    = session.data.servicio?.nombre || 'Color';
    const nombre = session.data.nombre || '';
    const resumenProcesos = [
      session.data.consultaProcesos,
      session.data.consultaTiempo ? `(hace ${session.data.consultaTiempo})` : null,
    ].filter(Boolean).join(' ');
    const colorDeseado = session.data.consultaColorDeseado || 'No especificado';
    const notes = `Procesos: ${resumenProcesos || 'Sin procesos previos'} | Resultado buscado: ${colorDeseado}`;

    // Guardar en DB como Consulta Pendiente para el portal staff
    try {
      const db = require('../core/db');
      const saved = await db.bookingSave({
        sessionId, nombre, phone,
        servicio: srv, fecha: '', hora: '',
        monto: session.data.servicio?.precio || 0,
        senaPaid: false, calendarEventId: null, notes
      });
      if (saved?.id) {
        await db.getDB()?.query('UPDATE bookings SET status = $1, notes = $2 WHERE id = $3',
          ['Consulta Pendiente', notes, saved.id]).catch(() => {});
      }
    } catch(e) { console.error('[color-consulta] DB error:', e.message); }

    // Notificar al staff por WhatsApp del salón si está configurado
    try {
      const STAFF_WA = process.env.STAFF_WHATSAPP_PHONE;
      const WASS_TOKEN = process.env.WASSENGER_TOKEN;
      if (STAFF_WA && WASS_TOKEN) {
        const axios = require('axios');
        const msgStaff = `🔔 *NUEVA CONSULTA DE COLOR*\n\n👤 ${nombre || 'Sin nombre'} · 📱 ${phone}\n✂️ ${srv}\n💬 ${resumenProcesos || 'Sin procesos previos'}\n🎨 Busca: ${colorDeseado}\n\n_Ver fotos y confirmar turno:_\nhttps://peluqueria-bot.onrender.com/staff`;
        await axios.post('https://api.wassenger.com/v1/messages',
          { phone: STAFF_WA, message: msgStaff },
          { headers: { Token: WASS_TOKEN }, timeout: 8000 }
        ).catch(e => console.error('[color-consulta] WA staff error:', e.message));
      }
    } catch(e) { console.error('[color-consulta] WA notify error:', e.message); }

    console.log(`[color-consulta] NUEVA | ${nombre} | ${srv} | ${resumenProcesos} | buscado: ${colorDeseado}`);
    session.step = 'LIBRE';
    session.data = {};
    return send(`¡Perfecto! 💛 En cuanto el equipo revise las fotos te contactamos para confirmar fecha, hora y todos los detalles.\n\nNormalmente respondemos en menos de 24hs. ¡Gracias por consultarnos! 🌟`);
  }

  // ── UPSELL — antes de Haiku ───────────────────────────────────────────────
  if (session.step === 'UPSELL') {
    const u = session.data.pendingUpsell;
    const acepta  = /^(1|s[ií]|dale|ok|claro|quiero|si\b|sí\b|bueno|perfecto|venga|obvio|re\b)/i.test(tl);
    const rechaza = /^(2|no\b|nop|mejor no|paso\b|ahora no|gracias no)/i.test(tl);

    if (acepta && u) {
      session.data.extra = SERVICIOS.findById(u.targetId);
      console.log(`[orch] UPSELL aceptado: ${session.data.extra?.nombre}`);
      session.data.pendingUpsell = null;
      session.step = 'CONFIRM_TURNO';
      return send(MSGS.confirmar(session.data));
    }

    if (rechaza) {
      console.log('[orch] UPSELL rechazado');
      session.data.pendingUpsell = null;
      session.step = 'CONFIRM_TURNO';
      return send(MSGS.confirmar(session.data));
    }

    // Pregunta o comentario sobre el producto — Haiku responde y mantiene el step
    console.log('[orch] UPSELL pregunta — Haiku responde');
    const srvNombre = u ? (SERVICIOS.findById(u.targetId)?.nombre || 'el tratamiento') : 'el tratamiento';
    const clientCtxUpsell = await intake.buildContext(phone);
    const parsedUpsell = await personal.interpret({
      text,
      clientCtx: clientCtxUpsell,
      historial: session.historial,
      step: 'UPSELL',
      extraContext: `La clienta está preguntando sobre el servicio adicional que le ofreciste: "${srvNombre}". Respondé su pregunta con entusiasmo y conocimiento. La ampolla reparadora hidrata, repara y sella la cutícula — el pelo queda suave, brillante, sin frizz. El Head Spa limpia el cuero cabelludo en profundidad, activa la circulación y deja el pelo muy liviano. Al final de tu respuesta, invitala amablemente a decidir: *1 — Sí, lo agrego* o *2 — No, gracias*.`
    });
    // Mantener step en UPSELL — seguimos esperando la decisión
    return send(parsedUpsell?.texto || `La *${srvNombre}* es un tratamiento que potencia y protege el resultado de tu servicio ✨ ¿La sumamos?\n\n1 — Sí, la agrego\n2 — No, gracias`);
  }

  // ── Confirmaciones ────────────────────────────────────────────────────────
  if (session.step === 'CONFIRM_TURNO') {
    // Última barrera: si llegó acá con un servicio de color sin consulta, redirigir
    if (session.data.servicio?.consulta && !session.data.consultaOk) {
      session.step = 'COLOR_CONSULTA_TIPO';
      return send(`Un momento 💛 Antes de confirmar necesito hacerte unas preguntas sobre el *${session.data.servicio.nombre}*.\n\n¿Tenés tinturas, decoloraciones, alisados o algún tratamiento químico en el pelo actualmente?\n\n1 — No, pelo natural\n2 — Sí, tengo procesos previos`);
    }
    if (/^(s[ií]|dale|ok|va|claro|confirmo|bueno|perfecto)/i.test(tl)) return await doCreateBooking(session, phone, send);
    if (/^(no\b|nop|mejor no)/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('Perfecto, no reservé nada 😊 Cuando quieras, acá estoy 💛'); }
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

  // ── Email en flujo de reserva ─────────────────────────────────────────────
  if (session.step === 'PEDIR_EMAIL_RESERVA') {
    const em = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (em) session.data.email = em[0];
    if (/^no\b/i.test(tl)) session.data.emailSkipped = true;
    session.data.emailPreguntado = true;
    session.step = 'RESERVANDO';
    return await avanzarReserva(session, phone, {}, send, await intake.buildContext(phone));
  }

  // ── Post-confirmación: email, apellido, promo ─────────────────────────────
  if (session.step === 'PEDIR_EMAIL') {
    const em = extractEmail(t);
    if (em) {
      session.data.email = em;
      const { addGuestToCalendarEvent } = require('../core/calendar');
      const { mailTurnoConfirmado } = require('./mailer');
      if (session.lastCalendarEventId) await addGuestToCalendarEvent(session.lastCalendarEventId, em).catch(() => {});
      if (session.lastBooking) {
        const b = session.lastBooking;
        mailTurnoConfirmado({ to: em, nombre: b.nombre, servicio: b.servicio, fecha: b.fecha, hora: b.hora, code: b.code, calendarLink: b.calLink, monto: b.monto, senaAmount: null }).catch(() => {});
      }
      session.step = 'PEDIR_APELLIDO';
      return send(`✅ ¡Confirmación enviada a *${em}*! 📆\n\n¿Me decís tu apellido para sumarte al programa de beneficios? 💛\n_(o *no* para saltear)_`);
    }
    if (/^no\b/i.test(tl)) { session.step = 'PEDIR_APELLIDO'; return send('¿Me decís tu apellido? 💛 _(o *no* para saltear)_'); }
    return send('Escribí tu *mail* o *no* para saltear 😊');
  }
  if (session.step === 'PEDIR_APELLIDO') {
    if (/^no\b/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Todo listo! Te esperamos 💛'); }
    if (t.length > 1 && t.length < 60) {
      const m = t.match(/(?:apellido es|llamo|soy)\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i);
      session.data.apellido = m ? m[1].trim() : t.trim();
      session.profile.apellido = session.data.apellido;
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

  // ── Loyalty ───────────────────────────────────────────────────────────────
  if (session.step === 'LOYALTY_CANJE') {
    const n = parseInt(tl);
    if (n > 0 && session.data.availableRewards?.[n - 1]) {
      const result = await loyalty.redeem(phone, session.data.availableRewards[n - 1].id);
      session.step = 'LIBRE'; session.data = {};
      return send(result.msg);
    }
    if (/^(no\b|volver)/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Cuando quieras! 💛'); }
  }

  // ── Buscar turno ──────────────────────────────────────────────────────────
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

  // ── Reprogramar ───────────────────────────────────────────────────────────
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

  // ── Actualizar email ─────────────────────────────────────────────────────────
  if (session.step === 'ACTUALIZAR_EMAIL') {
    const em = extractEmail(t);
    if (em) {
      // Actualizar en DB y perfil
      await clientUpdateProfile(phone, { email: em });
      session.profile.email = em;
      session.data.email = em;
      session.step = 'LIBRE';
      syncClientesToSheet().catch(() => {});
      return send(`✅ ¡Listo! Tu email quedó actualizado a *${em}* 💛`);
    }
    if (/^no/i.test(tl)) { session.step = 'LIBRE'; return send('¡Sin problema! 💛'); }
    return send('Escribí tu nuevo email o *no* para cancelar 😊');
  }

  // ── Actualizar email ─────────────────────────────────────────────────────────
  if (session.step === 'ACTUALIZAR_EMAIL') {
    const em = extractEmail(t);
    if (em) {
      await clientUpdateProfile(phone, { email: em });
      session.profile.email = em;
      session.data.email = em;
      session.step = 'LIBRE';
      syncClientesToSheet().catch(e => console.error('[sheets] sync error:', e.message));
      return send(`✅ ¡Listo! Tu email quedó actualizado a *${em}* 💛`);
    }
    if (/^no/i.test(tl)) { session.step = 'LIBRE'; return send('¡Sin problema! 💛'); }
    return send('Escribí tu nuevo email o *no* para cancelar 😊');
  }

  // ── Haiku interpreta ──────────────────────────────────────────────────────
  const clientCtx = await intake.buildContext(phone);
  const parsed = await personal.interpret({ text: t, clientCtx, historial: session.historial, step: session.step });

  // Acumular datos
  if (parsed.nombre && !session.data.nombre) {
    session.data.nombre = parsed.nombre.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    session.profile.nombre = session.data.nombre;
  }
  if (parsed.servicio && !session.data.servicio) {
    let srv = SERVICIOS.findByName(parsed.servicio);
    // Si Haiku dice "color" genérico o "cambio de look" → Color entero por defecto
    if (!srv && /color|tintura|teñi|cambio.*look|look.*cambio|tinte/i.test(parsed.servicio)) {
      srv = SERVICIOS.findByName('Color entero');
    }
    if (!srv && /balayage|balaige|balay/i.test(parsed.servicio)) {
      srv = SERVICIOS.findByName('Balayage');
    }
    if (!srv && /mechas|mecha|decolor/i.test(parsed.servicio)) {
      srv = SERVICIOS.findByName('Decoloración total');
    }
    if (!srv && /raiz|raíz|retoque/i.test(parsed.servicio)) {
      srv = SERVICIOS.findByName('Retoque / Raíz');
    }
    session.data.servicio = srv;
    // Si el servicio recién asignado requiere consulta, resetear servicioConfirmado
    // para que el guard se dispare en el próximo avanzarReserva
    if (srv?.consulta) {
      session.data.servicioConfirmado = false;
      session.data.consultaOk = false;
    }
  }
  if (parsed.servicio2 && !session.data.extra) {
    const srv2 = SERVICIOS.findByName(parsed.servicio2);
    if (srv2) { session.data.extra = srv2; session.data.upsellOfrecido = true; console.log(`[orch] servicio2: ${srv2.nombre}`); }
  }
  if (parsed.dia && !session.data.dia) {
    if (/^hoy$/i.test(parsed.dia)) {
      const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      session.data.dia = dias[now.getDay()];
    } else {
      session.data.dia = parsed.dia;
    }
  }
  if (parsed.hora  && !session.data.hora)  session.data.hora  = parsed.hora;
  if (parsed.email && !session.data.email) session.data.email = parsed.email;

  session.historial.push({ role: 'user', content: t });
  session.historial.push({ role: 'assistant', content: parsed.texto || '' });
  if (session.historial.length > 16) session.historial = session.historial.slice(-16);

  const intent = parsed.intent;

  // ── Routing ───────────────────────────────────────────────────────────────
  if (intent === 'PRECIO') {
    const intro = parsed.texto && !/\$[0-9]/.test(parsed.texto) ? parsed.texto + '\n\n' : '';
    if (session.step === 'RESERVANDO') session.step = 'RESERVANDO'; // mantener estado
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

  // Detectar pedido de actualizar email
  if (/actualiz|correg|cambiar.*mail|mail.*mal|email.*mal|mail.*wrong/i.test(tl) || 
      (intent === 'CHARLA' && /email|mail/i.test(tl) && /cambiar|actualiz|correg|mal|error/i.test(tl))) {
    session.step = 'ACTUALIZAR_EMAIL';
    return send('¡Claro! 💛 Pasame tu email correcto y lo actualizamos ahora mismo 📧');
  }

  // Detectar pedido de alisado — servicio que no hacemos
  if (/alisado|keratina|botox|nanoplastia|progressiva/i.test(tl) && /quiero|hacer|sacar|turno|reservar/i.test(tl)) {
    return send(`¡Gracias por consultarnos! 💛 Los alisados y keratinas no son servicios que hagamos en el salón — nos especializamos en cortes, color y tratamientos capilares.\n\n¿Te puedo ayudar con algo de eso? ✨`);
  }

  // Detectar pedido de actualizar/corregir email — antes de cualquier otro routing
  if (/actualiz|correg|cambiar.*mail|mail.*mal|email.*mal|equivoc.*mail|mail.*equivoc|pase.*mal.*mail|mail.*error/i.test(tl) ||
      (session.step === 'LIBRE' && /email|mail/i.test(tl) && /cambiar|actualiz|correg|nuevo|mal|error|equivoc/i.test(tl))) {
    session.step = 'ACTUALIZAR_EMAIL';
    return send('¡Claro! 💛 Escribime tu email correcto y lo actualizamos ahora mismo 📧');
  }

  if (intent === 'GESTIONAR' || intent === 'CANCELAR') {
    // Si estamos en medio de una reserva y la pregunta es sobre horarios/disponibilidad,
    // NO interrumpir el flow — responder y seguir en RESERVANDO
    const esConsultaHorario = /qué día|que dia|qué días|que dias|cuándo|cuando|horario|atienden|están|estan|disponib|abierto/i.test(tl);
    if (session.step === 'RESERVANDO' && esConsultaHorario && intent === 'GESTIONAR') {
      // Responder la consulta de horario sin salir del flow de reserva
      return send(`${parsed.texto || 'Atendemos *lunes a sábado de 10:00 a 20:00hs* 💛'}\n\n¿Qué día te viene bien?`);
    }

    session.step = 'BUSCANDO_TURNO'; session.data = {};
    if (parsed.codigo) {
      const found = await booking.findBooking(parsed.codigo, phone);
      if (found) { session.data.booking = found; session.step = 'OPCION_TURNO'; return send(MSGS.turnoEncontrado(found)); }
    }
    return send(`${parsed.texto || 'Claro'} 🔍 Ingresá tu *código* (ej: #AB12) o tu *nombre*:`);
  }

  // Si el texto menciona color/balayage/etc → forzar servicio correcto y resetear confirmado
  if (intent === 'RESERVAR' || session.step === 'RESERVANDO') {
    let srvDetectado = null;
    if (/balayage|balaige/i.test(tl)) srvDetectado = SERVICIOS.findByName('Balayage');
    else if (/decolor|mechitas|mechas/i.test(tl)) srvDetectado = SERVICIOS.findByName('Decoloración total');
    else if (/raiz|raíz|retoque/i.test(tl)) srvDetectado = SERVICIOS.findByName('Retoque / Raíz');
    else if (/contorno/i.test(tl)) srvDetectado = SERVICIOS.findByName('Contorno');
    else if (/color|tintura|teñi|cambio.*look|tinte/i.test(tl)) srvDetectado = SERVICIOS.findByName('Color entero');

    if (srvDetectado && (!session.data.servicio || session.data.servicio.id !== srvDetectado.id)) {
      session.data.servicio = srvDetectado;
      // Siempre resetear cuando detectamos un servicio de color — garantiza que pase por consulta
      if (srvDetectado.consulta) {
        session.data.servicioConfirmado = false;
        session.data.consultaOk = false;
      }
    }
  }

  if (intent === 'RESERVAR' || session.step === 'RESERVANDO') {
    // Restaurar perfil si arrancamos una nueva reserva sin datos
    if (session.step !== 'RESERVANDO' && session.profile?.nombre && !session.data.nombre) {
      session.data.nombre        = session.profile.nombre;
      session.data.nombrePreguntado = true;
    }
    if (session.step !== 'RESERVANDO' && session.profile?.email && !session.data.email) {
      session.data.email          = session.profile.email;
      session.data.emailPreguntado = true;
    }
    session.step = 'RESERVANDO';
    const datoNuevo = parsed.servicio || parsed.dia || parsed.hora || parsed.nombre;
    // Pregunta libre dentro del flujo — Haiku responde, no avanzamos
    if (!datoNuevo && parsed.texto) return send(parsed.texto);
    return await avanzarReserva(session, phone, parsed, send, clientCtx);
  }

  memory.update(phone, clientCtx?.client, t).catch(() => {});
  return send(parsed.texto || '¿En qué te puedo ayudar? 💛');
}

// ── avanzarReserva ────────────────────────────────────────────────────────────
async function avanzarReserva(session, phone, parsed, send, clientCtx) {
  const d = session.data;
  const haiku = parsed?.texto && !parsed.texto.includes('$') ? parsed.texto : null;

  console.log(`[avanzar] srv=${d.servicio?.nombre} consulta=${d.servicio?.consulta} consultaOk=${d.consultaOk} srvConfirmado=${d.servicioConfirmado}`);

  if (!d.servicio) return send((haiku ? haiku + '\n\n' : '') + MSGS.servicios());

  // GUARD PRINCIPAL — servicios de color/químicos SIEMPRE requieren consulta previa
  // Se chequea en CUALQUIER punto del flujo, sin importar si ya pasó servicioConfirmado
  if (d.servicio?.consulta && !d.consultaOk) {
    session.step = 'COLOR_CONSULTA_TIPO';
    const srv = d.servicio.nombre;
    const saludo = d.nombre ? `${d.nombre}, a` : 'A';
    return send(`${saludo}ntes de agendar el *${srv}*, necesitamos hacer una consulta previa 💛\n\nTe hago unas preguntas rápidas para que las estilistas se preparen bien.\n\n¿Tenés tinturas, decoloraciones, alisados o algún tratamiento químico en el pelo actualmente?\n\n1 — No, pelo natural\n2 — Sí, tengo procesos previos`);
  }

  // Servicio recién elegido — Haiku celebra y pregunta el día
  if (!d.servicioConfirmado) {
    d.servicioConfirmado = true;
    return send(haiku || `¡Buena elección! ✨ ¿Qué día te viene bien?\n\nAtendemos *lunes a sábado de 10:00 a 20:00hs*`);
  }

  if (!d.dia)  return send((haiku ? haiku + '\n\n' : '') + `📅 ¿Qué día te viene bien?\n\nAtendemos *lunes a sábado, 10:00 a 20:00hs*`);
  if (!d.hora) return send((haiku ? haiku + '\n\n' : '') + `⏰ ¿A qué hora el ${d.dia}? (Horario: 10:00 a 20:00hs)`);

  // Nombre — justo antes de confirmar
  if (!d.nombre) {
    if (d.nombrePreguntado) {
      d.nombre = '';
    } else {
      d.nombrePreguntado = true;
      return send((haiku ? haiku + '\n\n' : '') + '¿Me decís tu nombre para anotar el turno? 😊');
    }
  }

  // Email
  if (!d.emailPreguntado) {
    d.emailPreguntado = true;
    const clientEmail = clientCtx?.client?.email;
    if (clientEmail) {
      d.email = clientEmail;
    } else {
      session.step = 'PEDIR_EMAIL_RESERVA';
      return send((haiku ? haiku + '\n\n' : '') + `¿Cuál es tu email? Te mando la confirmación ✉️\n_(o *no* para saltear)_`);
    }
  }

  // Upsell
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

// ── doCreateBooking ───────────────────────────────────────────────────────────
async function doCreateBooking(session, phone, send) {
  try {
    const d = session.data;
    const result = await booking.create({ sessionId: session.id, nombre: d.nombre || '', phone, servicio: d.servicio, extra: d.extra, dia: d.dia, hora: d.hora, email: null });
    const { formatFecha } = require('../core/utils');
    const fechaDisplay = await formatFecha(result.fechaReal);
    const srvDisplay = d.servicio.nombre + (d.extra ? ' + ' + d.extra.nombre : '');
    session.lastCalendarEventId = result.calendarEventId;
    session.lastBooking = { nombre: d.nombre, servicio: srvDisplay, fecha: result.fechaReal, hora: result.horaReal, code: result.code, calLink: result.calLink, monto: result.monto };
    const ptsMsg = result.pointsEarned > 0 ? `\n⭐ Ganaste *+${result.pointsEarned} puntos*` : '';
    const confirmMsg = MSGS.turnoConfirmado(d.nombre, srvDisplay, fechaDisplay, result.horaReal, result.code) + ptsMsg;

    // Si ya tenemos email, mandar directo sin preguntar
    if (d.email && !d.emailSkipped) {
      const { addGuestToCalendarEvent } = require('../core/calendar');
      const { mailTurnoConfirmado } = require('./mailer');
      await addGuestToCalendarEvent(result.calendarEventId, d.email).catch(() => {});
      mailTurnoConfirmado({ to: d.email, nombre: d.nombre, servicio: srvDisplay, fecha: result.fechaReal, hora: result.horaReal, code: result.code, calendarLink: result.calLink, monto: result.monto, senaAmount: null }).catch(() => {});
      session.step = 'PEDIR_APELLIDO';
      return send(confirmMsg + `\n\n✉️ Confirmación enviada a *${d.email}* 💌\n\n¿Me decís tu apellido para el programa de beneficios? 💛 _(o *no* para saltear)_`);
    }
    session.step = 'PEDIR_EMAIL';
    return send(confirmMsg + '\n\n¿Querés recibir la confirmación por mail? ✉️\nEscribí tu *mail* o *no* para saltear');
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
