// ── AGENT: ORCHESTRATOR v2 ────────────────────────────────────────────────────
// Máquina de estados conversacional para Estefan Peluquería.
// Maneja: saludo, reservas, reprogramación, cancelación, consulta de color,
//         derivación a humano, loyalty, upsell, precios, email y perfil.
'use strict';

const intake   = require('./intake');
const personal = require('./personal');
const booking  = require('./booking');
const loyalty  = require('./loyalty');
const memory   = require('./memory');
const { getPersonalizedUpsell } = require('./upsell');
const SERVICIOS = require('../core/servicios');
const { getSession } = require('../core/session');
const { conversationLog, clientGet, clientUpsert, clientUpdateProfile } = require('../core/db');
const { syncClientesToSheet } = require('../core/sheets');

// ── Mensajes predefinidos ─────────────────────────────────────────────────────
const MSGS = {
  servicios: () =>
    `💇 *¿Qué servicio querés?*\n\n` +
    `✂️ *Cortes*\n  1 — Corte de pelo · $50.000\n  2 — Corte + Brushing · $70.000\n  3 — Brushing / Planchita · $20.000\n  4 — Lavado + Aireado · $15.000\n\n` +
    `💆 *Spa & Tratamientos*\n  5 — Ozono · $30.000\n  6 — Head Spa completo · $120.000\n  7 — Ampolla · $30.000\n\n` +
    `🎨 *Color (con consulta previa)*\n  8 — Retoque / Raíz · $60.000\n  9 — Color entero · desde $80.000\n  10 — Contorno · $80.000\n  11 — Balayage · desde $200.000\n  12 — Decoloración total · desde $200.000\n\n` +
    `💐 *Peinados*\n  13 — Fiesta / 15 años · desde $60.000\n  14 — Novia · desde $150.000\n\n` +
    `_Respondé con el número o escribí el servicio_ 👆`,

  precios: () =>
    `💈 *Servicios y Precios — Estefan Peluquería*\n\n` +
    `✂️ *Cortes*\n  • Corte de pelo: *$50.000* _(incluye lavado y aireado)_\n  • Corte + Brushing: *$70.000*\n  • Brushing / Planchita: *$20.000*\n  • Lavado + Aireado: *$15.000*\n\n` +
    `🎨 *Color* _(requiere consulta previa)_\n  • Retoque / Raíz: *$60.000*\n  • Color entero: *desde $80.000*\n  • Contorno: *$80.000*\n  • Balayage: *desde $200.000*\n  • Decoloración total: *desde $200.000*\n\n` +
    `💆 *Tratamientos*\n  • Ozono capilar: *$30.000*\n  • Head Spa completo: *$120.000*\n  • Ampolla reparadora: *$30.000*\n\n` +
    `💐 *Peinados* _(requiere seña)_\n  • Fiesta / 15 años: *desde $60.000*\n  • Novia: *desde $150.000*\n\n` +
    `_Escribí *reservar* para sacar un turno 💛_`,

  turnoEncontrado: (b) =>
    `📋 *Tu turno:*\n\n` +
    `👤 ${b.nombre}\n✂️ ${b.servicio}\n📅 ${b.fecha} · ⏰ ${b.hora}\n🔖 ${b.code}\n\n` +
    `¿Qué querés hacer?\n1️⃣ Cambiar fecha/hora\n2️⃣ Cancelar turno\n3️⃣ Volver`,

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

  senaRequerida: (nombre, servicio, fechaDisplay, hora, code, montoSena, mpLink) =>
    `⏳ *Tu turno está registrado${nombre ? ', ' + nombre : ''}*\n\n📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n` +
    `⚠️ *Para confirmar necesitamos la seña de $${montoSena}*\n` +
    (mpLink
      ? `Podés abonarlo acá 👇\n${mpLink}\n\n_Una vez recibido el pago te llega la confirmación por mail_ 📧`
      : `Coordinamos el pago de la seña cuando vengas o por este chat 💛\n\n_El turno se confirma una vez recibida la seña_ ✅`),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractEmail(text) {
  const matches = (text || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return matches.sort((a, b) => b.length - a.length)[0] || null;
}

// Detectar servicio de color/químico a partir de texto crudo
function detectarServicioColor(tl) {
  if (/balayage|balaige|belaish/i.test(tl))           return SERVICIOS.findByName('Balayage');
  if (/decolor|mechitas|mechas/i.test(tl))             return SERVICIOS.findByName('Decoloración total');
  if (/raiz|raíz|retoque/i.test(tl))                  return SERVICIOS.findByName('Retoque / Raíz');
  if (/contorno/i.test(tl))                            return SERVICIOS.findByName('Contorno');
  if (/\bcolor\b|tintura|teñi|cambio.*look|tinte/i.test(tl)) return SERVICIOS.findByName('Color entero');
  return null;
}

// ── Handler principal ─────────────────────────────────────────────────────────
async function handle({ sessionId, phone, text }) {
  const t   = (text || '').trim();
  const tl  = t.toLowerCase();
  const session = getSession(sessionId);
  if (!session.data)      session.data      = {};
  if (!session.historial) session.historial = [];
  if (!session.profile)   session.profile   = {};

  await conversationLog(phone, 'user', t);
  console.log(`[orch] step=${session.step} phone=${phone} msg="${t.substring(0, 60)}"`);

  const send = async (msg) => { await conversationLog(phone, 'assistant', msg); return msg; };

  // CEO MODE — if message comes from the owner, switch to data mode
const CEO_PHONE = process.env.CEO_PHONE || process.env.OWNER_PHONE;
if (CEO_PHONE && phone === CEO_PHONE) {
  const { handleCEO } = require('./personal');
  const reply = await handleCEO(t, session.historial || []);
  session.historial = session.historial || [];
  session.historial.push({ role: 'user', content: t });
  session.historial.push({ role: 'assistant', content: reply });
  return send(reply);
}
 
// FAQ SHORTCUT — answer directly from profile, no AI needed
const { handleFAQ } = require('./personal');
const clientCtxFAQ = await intake.buildContext(phone);
const faqReply = handleFAQ(t, clientCtxFAQ);
if (faqReply) return send(faqReply);
 
// ── END PATCH ─────────────────────────────────────────────────────────────────

  // ── Comandos globales ─────────────────────────────────────────────────────
  if (/^(\.?menu|menú|inicio|volver|start|hola\.?|buenas\.?)$/i.test(tl)) {
    session.step = 'LIBRE'; session.data = {};
    const saludoMsg = await personal.greet({ clientCtx: await intake.buildContext(phone) });
    const menuOpciones = `\n\n¿Qué querés hacer?\n\n1️⃣ Sacar un turno\n2️⃣ Ver / cambiar mi turno\n3️⃣ Ver precios\n4️⃣ Hablar con alguien del equipo`;
    return send(saludoMsg + menuOpciones);
  }
  if (/hablar.*persona|quiero.*humano|hablar.*alguien|necesito.*alguien|un agente/i.test(tl)) {
    return send('Te conecto con alguien del equipo — te responden en menos de 2 horas 💛');
  }

  // ── Menú numérico (step LIBRE) ────────────────────────────────────────────
  if (session.step === 'LIBRE' && /^[1-4]$/.test(t)) {
    const n = parseInt(t);
    if (n === 1) {
      session.step = 'RESERVANDO';
      session.data = {
        nombre:          session.profile?.nombre || null,
        email:           session.profile?.email  || null,
        emailPreguntado: !!session.profile?.email,
        nombrePreguntado: !!session.profile?.nombre
      };
      return send('¡Dale! 💛 ¿Qué servicio te gustaría hoy?');
    }
    if (n === 2) { session.step = 'BUSCANDO_TURNO'; return send('Ingresá tu *código* (ej: #AB12) o tu nombre 🔍'); }
    if (n === 3) return send(MSGS.precios());
    if (n === 4) return send('Te conecto con alguien del equipo 💛');
  }

  // ── Selección numérica de servicio durante RESERVANDO ────────────────────
  if (session.step === 'RESERVANDO' && !session.data.servicio && /^\d{1,2}$/.test(t)) {
    const n = parseInt(t);
    const mapaNumeros = {
      1: 'Corte de pelo', 2: 'Corte + Brushing', 3: 'Brushing / Planchita', 4: 'Lavado + Aireado',
      5: 'Ozono', 6: 'Head Spa completo', 7: 'Ampolla',
      8: 'Retoque / Raíz', 9: 'Color entero', 10: 'Contorno', 11: 'Balayage', 12: 'Decoloración total',
      13: 'Peinado fiesta / 15', 14: 'Peinado novia'
    };
    if (mapaNumeros[n]) {
      const srv = SERVICIOS.findByName(mapaNumeros[n]);
      if (srv) {
        session.data.servicio = srv;
        if (srv.consulta) { session.data.servicioConfirmado = false; session.data.consultaOk = false; }
      }
    }
  }

  // ── DERIVACION A HUMANO ───────────────────────────────────────────────────
  if (session.step === 'DERIVACION_HUMANO') {
    const positivo = /si|sí|dale|ok|bueno|claro|perfecto|genial|de acuerdo/i.test(tl);
    const negativo = /^(no|ahora no|después|luego|nop)/i.test(tl);
    session.step = 'LIBRE';
    if (negativo) return send('¡Sin problema! 💛 Si en algún momento querés que te asesoren, escribinos. ¿Puedo ayudarte con algo más?');
    return send('¡Perfecto! 💛 Una de nuestras representantes te escribe a la brevedad para guiarte con la mejor opción para tu cabello. ¡Gracias por consultarnos! 🌟');
  }

  // ── FLUJO DE CONSULTA DE COLOR ────────────────────────────────────────────
  // El bot recopila info antes de derivar — NUNCA confirma turno de color solo

  if (session.step === 'COLOR_CONSULTA_TIPO') {
    session.data.consultaProceso1 = t;
    const noPrevios = /^(1|no\b|nop|natural|virgen|ninguno|recién nacido)/i.test(tl);
    if (noPrevios) {
      session.data.consultaProcesos = 'Sin procesos previos (pelo natural)';
      session.step = 'COLOR_DETALLE_COLOR';
      return send(`¡Genial, pelo natural es ideal para trabajar! 💛\n\n¿Cuál sería el resultado que buscás?\n\n_Ejemplo: "rubia natural con reflejos", "castaño oscuro", "mechitas caramelo"..._\n\nCuanto más detalle, mejor se preparan las estilistas ✨`);
    }
    session.step = 'COLOR_DETALLE_PROCESO';
    return send(`Entendido 💛 ¿Qué tipo de proceso tenés actualmente?\n\n1 — Tintura (color entero o raíz)\n2 — Decoloración o mechitas\n3 — Alisado / Keratina / Botox\n4 — Varios / no estoy segura`);
  }

  if (session.step === 'COLOR_DETALLE_PROCESO') {
    session.data.consultaProcesos = t;
    session.data.consultaTieneAlistado = /alisado|keratina|botox|3/i.test(tl);
    session.step = 'COLOR_DETALLE_TIEMPO';
    return send(`¿Hace cuánto te hiciste ese proceso?\n\n_Ej: "hace 2 semanas", "hace 3 meses", "más de un año"_ 📅`);
  }

  if (session.step === 'COLOR_DETALLE_TIEMPO') {
    session.data.consultaTiempo = t;
    session.step = 'COLOR_DETALLE_COLOR';
    return send(`¡Gracias! 💛 ¿Y cuál es el resultado que buscás?\n\n_Ej: "rubia platinada", "mechitas caramelo sobre castaño", "castaño oscuro con luces"..._\n\nCuanto más detalle mejor se preparan las estilistas ✨`);
  }

  if (session.step === 'COLOR_DETALLE_COLOR') {
    session.data.consultaColorDeseado = t;
    if (session.data.nombre || session.profile?.nombre) {
      session.data.nombre = session.data.nombre || session.profile.nombre;
      session.step = 'COLOR_PEDIR_FOTOS';
      return send(`¡Perfecto, eso ayuda muchísimo! 💛\n\nÚltimo paso — ¿podés mandarnos *2 fotos*?\n\n📸 *Foto 1:* Tu pelo *hoy* (con buena luz, lo más natural posible)\n📸 *Foto 2:* Una *referencia* del resultado que buscás (Pinterest, Instagram, etc.)\n\nEstas fotos van directo al equipo para que evalúen y te contacten con fecha, hora y todo lo que necesitás 💛`);
    }
    session.step = 'COLOR_PEDIR_NOMBRE';
    return send(`¡Perfecto! 💛 ¿Me decís tu nombre para que el equipo pueda contactarte personalmente? 😊`);
  }

  if (session.step === 'COLOR_PEDIR_NOMBRE') {
    session.data.nombre = /^(no|nop|paso|skip|-)$/i.test(tl) ? '' : t.trim();
    session.step = 'COLOR_PEDIR_EMAIL';
    const saludo = session.data.nombre ? `¡Gracias, ${session.data.nombre.split(' ')[0]}! ` : '¡Gracias! ';
    return send(`${saludo}💛 ¿Me dejás un mail o número de contacto? Así el equipo te avisa cuando revisen las fotos 📩\n\n_(o *no* para saltear)_`);
  }

  if (session.step === 'COLOR_PEDIR_EMAIL') {
    const esEmail = /[@.]/.test(t);
    const esNo    = /^(no|nop|paso|skip|-)$/i.test(tl);
    if (!esNo) {
      if (esEmail) session.data.email = t.trim().toLowerCase();
      else session.data.telefono = t.trim();
    }
    session.step = 'COLOR_PEDIR_FOTOS';
    return send(`¡Perfecto! 💛\n\n📸 *Foto 1:* Tu pelo *hoy* (buena luz, natural)\n📸 *Foto 2:* Una *referencia* del resultado que buscás\n\nEstas fotos van directo al equipo para evaluarlas y contactarte con todo listo 💛`);
  }

  if (session.step === 'COLOR_PEDIR_FOTOS') {
    await _guardarConsultaColor(session, phone);
    session.step = 'LIBRE'; session.data = {};
    return send(`¡Perfecto! 💛 En cuanto el equipo revise las fotos te contactamos para confirmar fecha, hora y todos los detalles.\n\nNormalmente respondemos dentro de las 24hs. ¡Gracias por consultarnos! 🌟`);
  }

  // ── UPSELL ────────────────────────────────────────────────────────────────
  if (session.step === 'UPSELL') {
    const u        = session.data.pendingUpsell;
    const acepta   = /^(1|si\b|sí\b|dale|ok|claro|quiero|bueno|perfecto|venga|obvio|re\b|agrego|sumalo)/i.test(tl);
    const rechaza  = /^(2|no\b|nop|mejor no|paso\b|ahora no|gracias no|sin el|no gracias)/i.test(tl);

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
    // Pregunta sobre el upsell — Haiku responde con info y vuelve a ofrecer
    const srvNombre = u ? (SERVICIOS.findById(u.targetId)?.nombre || 'el tratamiento') : 'el tratamiento';
    const clientCtxUp = await intake.buildContext(phone);
    const parsedUp = await personal.interpret({
      text,
      clientCtx: clientCtxUp,
      historial: session.historial,
      step: 'UPSELL',
      extraContext: `La clienta pregunta sobre el complemento ofrecido: "${srvNombre}". Respondé con entusiasmo y conocimiento.\n- Ampolla: hidrata, repara y sella la cutícula — pelo suave, brillante, sin frizz.\n- Head Spa completo: limpieza profunda del cuero cabelludo, masajes, hidratación — pelo muy liviano.\n- Ozono: revitaliza el cuero cabelludo, mejora textura y brillo de forma progresiva.\nAl final invitala a decidir: *1 — Sí, lo agrego* o *2 — No, gracias*.`
    });
    return send(parsedUp?.texto || `La *${srvNombre}* potencia y protege el resultado de tu servicio ✨ ¿La sumamos?\n\n1 — Sí, la agrego\n2 — No, gracias`);
  }

  // ── Confirmaciones ────────────────────────────────────────────────────────
  if (session.step === 'CONFIRM_TURNO') {
    if (session.data.servicio?.consulta && !session.data.consultaOk) {
      session.step = 'COLOR_CONSULTA_TIPO';
      return send(`Un momento 💛 Antes de confirmar necesito hacerte unas preguntas sobre el *${session.data.servicio.nombre}*.\n\n¿Tenés tinturas, decoloraciones, alisados o algún tratamiento químico en el pelo actualmente?\n\n1 — No, pelo natural\n2 — Sí, tengo procesos previos`);
    }
    if (/^(si\b|sí\b|dale|ok|va|claro|confirmo|bueno|perfecto|listo|sip)/i.test(tl)) return await doCreateBooking(session, phone, send);
    if (/^(no\b|nop|mejor no|cancelar|no quiero)/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('Perfecto, no reservé nada 😊 Cuando quieras, acá estoy 💛'); }
    return send(MSGS.confirmar(session.data));
  }
  if (session.step === 'CONFIRM_CANCELAR') {
    if (/^(si\b|sí\b|dale|ok|sip)/i.test(tl)) return await doCancelBooking(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cancelé nada 😊');
  }
  if (session.step === 'CONFIRM_REPROGRAM') {
    if (/^(si\b|sí\b|dale|ok|va|claro|sip)/i.test(tl)) return await doReschedule(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cambié nada 😊');
  }

  // ── Email en flujo de reserva ─────────────────────────────────────────────
  if (session.step === 'PEDIR_EMAIL_RESERVA') {
    const em = extractEmail(t);
    if (em) {
      session.data.email = em;
      await clientUpsert(phone, session.data.nombre || null, em).catch(() => {});
    }
    if (/^no\b/i.test(tl)) session.data.emailSkipped = true;
    session.data.emailPreguntado = true;
    session.step = 'RESERVANDO';
    return await avanzarReserva(session, phone, {}, send, await intake.buildContext(phone));
  }

  // ── Post-confirmación: email, apellido, promo ────────────────────────────
  if (session.step === 'PEDIR_EMAIL') {
    const em = extractEmail(t);
    if (em) {
      session.data.email = em;
      await clientUpsert(phone, session.data.nombre || null, em).catch(() => {});
      const { getDB } = require('../core/db');
      const dbConn = getDB();
      if (dbConn && session.lastBooking?.code) {
        await dbConn.query('UPDATE bookings SET email=$1 WHERE booking_code=$2', [em, session.lastBooking.code]).catch(() => {});
      }
      const { addGuestToCalendarEvent } = require('../core/calendar');
      const { mailTurnoConfirmado } = require('./mailer');
      if (session.lastCalendarEventId) await addGuestToCalendarEvent(session.lastCalendarEventId, em).catch(() => {});
      if (session.lastBooking && !session.lastBooking.senaRequired) {
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
      const mA = t.match(/apellido(?:\s+es)?\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i);
      const mN = t.match(/(?:nombre(?:\s+completo)?(?:\s+es)?|llamo|soy)\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i);
      const mS = t.match(/^([A-Za-záéíóúÁÉÍÓÚñÑ]+)$/i);
      session.data.apellido = mA ? mA[1].trim() : mN ? mN[1].trim() : mS ? mS[1].trim() : t.trim();
      session.profile.apellido = session.data.apellido;
      session.step = 'PEDIR_PROMO';
      return send(`¿Querés que te avisemos de descuentos y sorteos? 🎁\n\n1 — Sí, me interesa\n2 — No, gracias`);
    }
    return send('¿Cuál es tu apellido? _(o *no* para saltear)_');
  }

  if (session.step === 'PEDIR_PROMO') {
    const si = /^(1|si\b|sí\b|dale|ok|claro)/i.test(tl);
    const no = /^(2|no\b|nop)/i.test(tl);
    if (si || no) {
      await clientUpdateProfile(phone, { lastName: session.data.apellido || null, email: session.data.email || null, promoOptIn: si, profileComplete: !!(session.data.apellido && session.data.email) });
      syncClientesToSheet().catch(e => console.error('[sheets] sync error:', e.message));
      session.step = 'LIBRE'; session.data = {};
      return send(si ? '¡Genial! Ya estás en el programa de beneficios 🎉 Te avisamos de todo 💛' : 'Perfecto 👍 ¡Te esperamos!');
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
    if (/^(no\b|volver|salir)/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Cuando quieras! 💛'); }
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

  // ── Actualizar email ──────────────────────────────────────────────────────
  if (session.step === 'ACTUALIZAR_EMAIL') {
    const em = extractEmail(t);
    if (em) {
      await clientUpdateProfile(phone, { email: em });
      session.profile.email = em;
      session.data.email = em;
      session.step = 'LIBRE';
      syncClientesToSheet().catch(() => {});
      return send(`✅ ¡Listo! Tu email quedó actualizado a *${em}* 💛`);
    }
    if (/^no\b/i.test(tl)) { session.step = 'LIBRE'; return send('¡Sin problema! 💛'); }
    return send('Escribí tu nuevo email o *no* para cancelar 😊');
  }

  // ── Haiku interpreta ──────────────────────────────────────────────────────
  const clientCtx = await intake.buildContext(phone);
  const parsed = await personal.interpret({ text: t, clientCtx, historial: session.historial, step: session.step });

  // ── Acumular datos del mensaje ────────────────────────────────────────────
  if (parsed.nombre && !session.data.nombre) {
    session.data.nombre = parsed.nombre.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    session.profile.nombre = session.data.nombre;
  }
  if (parsed.email && !session.data.email) {
    session.data.email = parsed.email;
  }

  // Detección de servicio — con fallback de regex sobre el texto original
  if (!session.data.servicio) {
    let srv = null;
    if (parsed.servicio) srv = SERVICIOS.findByName(parsed.servicio);
    if (!srv) srv = detectarServicioColor(tl);
    if (!srv && /corte.*brushing|brushing.*corte/i.test(tl)) srv = SERVICIOS.findByName('Corte + Brushing');
    if (!srv && /\bcorte\b/i.test(tl)) srv = SERVICIOS.findByName('Corte de pelo');
    if (!srv && /head.spa/i.test(tl)) srv = SERVICIOS.findByName('Head Spa completo');
    if (!srv && /\bozono\b/i.test(tl)) srv = SERVICIOS.findByName('Ozono');
    if (!srv && /ampolla/i.test(tl)) srv = SERVICIOS.findByName('Ampolla');
    if (!srv && /\bnovia\b/i.test(tl)) srv = SERVICIOS.findByName('Peinado novia');
    if (!srv && /fiesta|15\s*años/i.test(tl)) srv = SERVICIOS.findByName('Peinado fiesta / 15');
    if (srv) {
      session.data.servicio = srv;
      if (srv.consulta) { session.data.servicioConfirmado = false; session.data.consultaOk = false; }
    }
  }

  // Segundo servicio (upsell explícito de la clienta)
  if (parsed.servicio2 && !session.data.extra) {
    const srv2 = SERVICIOS.findByName(parsed.servicio2);
    if (srv2) {
      if (srv2.consulta && !session.data.servicio?.consulta) {
        // Color debe ser principal para pasar por consulta
        session.data.extra = session.data.servicio;
        session.data.servicio = srv2;
        session.data.servicioConfirmado = false;
        session.data.consultaOk = false;
        console.log(`[orch] servicio2 con consulta → invertido: principal=${srv2.nombre}`);
      } else {
        session.data.extra = srv2;
      }
      session.data.upsellOfrecido = true;
    }
  }

  // Día y hora
  if (parsed.dia && !session.data.dia) {
    if (/^hoy$/i.test(parsed.dia)) {
      const diasSem = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      session.data.dia = diasSem[now.getDay()];
    } else {
      session.data.dia = parsed.dia;
    }
  }
  if (parsed.hora && !session.data.hora) session.data.hora = parsed.hora;

  // Redetección de color si está en flujo de reserva
  if ((parsed.intent === 'RESERVAR' || session.step === 'RESERVANDO') && !session.data.servicio) {
    const srvColor = detectarServicioColor(tl);
    if (srvColor) {
      session.data.servicio = srvColor;
      session.data.servicioConfirmado = false;
      session.data.consultaOk = false;
    }
  }

  // Historial
  session.historial.push({ role: 'user', content: t });
  session.historial.push({ role: 'assistant', content: parsed.texto || '' });
  if (session.historial.length > 20) session.historial = session.historial.slice(-20);

  const intent = parsed.intent;

  // ── Routing por intent ────────────────────────────────────────────────────

  // PRECIO
  if (intent === 'PRECIO') {
    const PRECIOS_LISTA = [
      { re: /corte.*brushing|brushing.*corte/i, txt: '✂️ *Corte + Brushing:* $70.000' },
      { re: /corte/i,             txt: '✂️ *Corte de pelo:* $50.000 _(incluye lavado y aireado)_' },
      { re: /brushing|planchita/i, txt: '💇 *Brushing / Planchita:* $20.000' },
      { re: /lavado|aireado/i,    txt: '💧 *Lavado + Aireado:* $15.000' },
      { re: /balayage|balaige/i,  txt: '🎨 *Balayage:* desde $200.000 _(requiere consulta previa)_' },
      { re: /decolor|mechas|mechitas/i, txt: '🎨 *Decoloración total:* desde $200.000' },
      { re: /raiz|raíz|retoque/i, txt: '🎨 *Retoque / Raíz:* $60.000' },
      { re: /contorno/i,          txt: '🎨 *Contorno:* $80.000' },
      { re: /color entero|tintura|teñi|tinte/i, txt: '🎨 *Color entero:* desde $80.000' },
      { re: /\bcolor\b/i,         txt: '🎨 *Color entero:* desde $80.000' },
      { re: /novia/i,             txt: '💐 *Peinado novia:* desde $150.000' },
      { re: /fiesta|15/i,         txt: '💐 *Peinado fiesta / 15:* desde $60.000' },
      { re: /head.?spa|spa/i,     txt: '💆 *Head Spa completo:* $120.000' },
      { re: /ozono/i,             txt: '💆 *Ozono capilar:* $30.000' },
      { re: /ampolla/i,           txt: '✨ *Ampolla reparadora:* $30.000' },
    ];
    const mencionados = PRECIOS_LISTA.filter(s => s.re.test(t));
    const intro = parsed.texto && !/\$[0-9]/.test(parsed.texto) ? parsed.texto + '\n\n' : '';
    if (mencionados.length > 0) {
      const lista = mencionados.map(s => '  • ' + s.txt).join('\n');
      return send(intro + lista + '\n\n_¿Querés ver todos los precios o reservar? 💛_');
    }
    return send(intro + MSGS.precios());
  }

  // LOYALTY
  if (intent === 'LOYALTY' || /puntos|beneficio|canje|premio|mis puntos/i.test(tl)) {
    const result = await loyalty.showBalance(phone);
    if (result.available.length > 0) {
      session.data.availableRewards = result.available;
      session.step = 'LOYALTY_CANJE';
      return send(result.msg + '\n\n_Respondé con el número para canjear, o *no* para volver_ 💛');
    }
    return send(result.msg);
  }

  // Actualizar email
  if (/actualiz|correg|cambiar.*mail|mail.*mal|email.*mal|email.*wrong|mail.*error|equivoc.*mail/i.test(tl)) {
    session.step = 'ACTUALIZAR_EMAIL';
    return send('¡Claro! 💛 Pasame tu email correcto y lo actualizamos ahora mismo 📧');
  }

  // Alisado / keratina / formol → derivar con alternativas
  if (/alisado|keratina|botox|nanoplastia|progressiva|formol/i.test(tl)) {
    _notificarStaffDerivacion(phone, session.profile?.nombre, t);
    session.step = 'DERIVACION_HUMANO';
    return send(
      `¡Buenísima consulta! 💛 En el salón trabajamos con técnicas que dan resultados increíbles *sin formol ni químicos agresivos*.\n\n` +
      `Para ese objetivo tenemos:\n\n` +
      `✨ *Head Spa completo* — tratamiento profundo que hidrata, suaviza y da brillo real desde la raíz ($120.000)\n` +
      `🌿 *Ozono capilar* — revitaliza el cuero cabelludo y mejora la textura con resultados progresivos ($30.000)\n` +
      `💧 *Ampolla reparadora* — nutrición intensiva para cabello dañado o con frizz ($30.000)\n\n` +
      `Estas opciones cuidan el cabello *de verdad* y el resultado se nota. Para darte la combinación perfecta según tu tipo de pelo, una de nuestras representantes te va a contactar personalmente 😊\n\n` +
      `¿Está bien si te escribe pronto?`
    );
  }

  // GESTIONAR / CANCELAR
  if (intent === 'GESTIONAR' || intent === 'CANCELAR') {
    // Si estamos en reserva y es consulta de horario, no interrumpir
    const esConsultaHorario = /qué día|que dia|cuándo|cuando|horario|atienden|disponib|abierto/i.test(tl);
    if (session.step === 'RESERVANDO' && esConsultaHorario && intent === 'GESTIONAR') {
      return send(`${parsed.texto || 'Atendemos *lunes a sábado de 10:00 a 20:00hs* 💛'}\n\n¿Qué día te viene bien?`);
    }
    session.step = 'BUSCANDO_TURNO'; session.data = {};
    if (parsed.codigo) {
      const found = await booking.findBooking(parsed.codigo, phone);
      if (found) { session.data.booking = found; session.step = 'OPCION_TURNO'; return send(MSGS.turnoEncontrado(found)); }
    }
    return send(`${parsed.texto || 'Claro'} 🔍 Ingresá tu *código* (ej: #AB12) o tu *nombre*:`);
  }

  // RESERVAR
  if (intent === 'RESERVAR' || session.step === 'RESERVANDO') {
    // Restaurar perfil en nueva reserva
    if (session.step !== 'RESERVANDO') {
      if (session.profile?.nombre && !session.data.nombre) {
        session.data.nombre = session.profile.nombre;
        session.data.nombrePreguntado = true;
      }
      if (session.profile?.email && !session.data.email) {
        session.data.email = session.profile.email;
        session.data.emailPreguntado = true;
      }
    }
    session.step = 'RESERVANDO';
    const datoNuevo = parsed.servicio || parsed.dia || parsed.hora || parsed.nombre;
    if (!datoNuevo && parsed.texto) return send(parsed.texto);
    return await avanzarReserva(session, phone, parsed, send, clientCtx);
  }

  // SALUDO
  if (intent === 'SALUDO') {
    const saludoMsg = await personal.greet({ clientCtx });
    const menuOpciones = `\n\n¿Qué querés hacer?\n\n1️⃣ Sacar un turno\n2️⃣ Ver / cambiar mi turno\n3️⃣ Ver precios\n4️⃣ Hablar con alguien del equipo`;
    return send(saludoMsg + menuOpciones);
  }

  // Memory update y fallback
  memory.update(phone, clientCtx?.client, t).catch(() => {});
  return send(parsed.texto || '¿En qué te puedo ayudar? 💛');
}

// ── avanzarReserva ────────────────────────────────────────────────────────────
async function avanzarReserva(session, phone, parsed, send, clientCtx) {
  const d    = session.data;
  const haiku = parsed?.texto && !parsed.texto.includes('$') ? parsed.texto : null;

  console.log(`[avanzar] srv=${d.servicio?.nombre} consulta=${d.servicio?.consulta} consultaOk=${d.consultaOk} srvConf=${d.servicioConfirmado} dia=${d.dia} hora=${d.hora} nombre=${d.nombre}`);

  if (!d.servicio) return send((haiku ? haiku + '\n\n' : '') + MSGS.servicios());

  // GUARD: servicios de color SIEMPRE necesitan consulta previa
  // Si el extra requiere consulta y el principal no, promoverlo
  if (!d.servicio?.consulta && d.extra?.consulta) {
    const tmp = d.servicio;
    d.servicio = d.extra;
    d.extra = tmp;
    d.servicioConfirmado = false;
    d.consultaOk = false;
    console.log(`[avanzar] extra con consulta promovido a principal: ${d.servicio.nombre}`);
  }

  if (d.servicio?.consulta && !d.consultaOk) {
    session.step = 'COLOR_CONSULTA_TIPO';
    const srv    = d.servicio.nombre;
    const saludo = d.nombre ? `${d.nombre.split(' ')[0]}, a` : 'A';
    return send(
      `${saludo}ntes de agendar el *${srv}* necesitamos hacer una consulta previa 💛\n\n` +
      `Te hago unas preguntas rápidas para que las estilistas se preparen con todo lo necesario.\n\n` +
      `¿Tenés tinturas, decoloraciones, alisados o algún tratamiento químico en el pelo actualmente?\n\n` +
      `1 — No, pelo natural\n2 — Sí, tengo procesos previos`
    );
  }

  // Celebrar el servicio elegido
  if (!d.servicioConfirmado) {
    d.servicioConfirmado = true;
    return send(haiku || `¡Buena elección! ✨ ¿Qué día te viene bien?\n\nAtendemos *lunes a sábado de 10:00 a 20:00hs*`);
  }

  if (!d.dia)  return send((haiku ? haiku + '\n\n' : '') + `📅 ¿Qué día te viene bien?\n\nAtendemos *lunes a sábado, 10:00 a 20:00hs*`);
  if (!d.hora) return send((haiku ? haiku + '\n\n' : '') + `⏰ ¿A qué hora el ${d.dia}? (10:00 a 20:00hs)`);

  // Nombre — justo antes de confirmar
  if (!d.nombre) {
    d.nombrePreguntado = true;
    return send((haiku ? haiku + '\n\n' : '') + '¿Me decís tu nombre para anotar el turno? 😊');
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

  // Upsell inteligente
  const upsell = getPersonalizedUpsell(d.servicio.id, clientCtx?.recentBookings || []);
  if (upsell && !d.upsellOfrecido) {
    d.pendingUpsell  = upsell;
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
    const result = await booking.create({
      sessionId: session.id, nombre: d.nombre || '', phone,
      servicio: d.servicio, extra: d.extra,
      dia: d.dia, hora: d.hora, email: d.email || null
    });
    const { formatFecha } = require('../core/utils');
    const fechaDisplay = await formatFecha(result.fechaReal);
    const srvDisplay   = d.servicio.nombre + (d.extra ? ' + ' + d.extra.nombre : '');
    session.lastCalendarEventId = result.calendarEventId;
    session.lastBooking = {
      nombre: d.nombre, servicio: srvDisplay,
      fecha: result.fechaReal, hora: result.horaReal,
      code: result.code, calLink: result.calLink,
      monto: result.monto,
      senaRequired: d.servicio?.seña && result.senaAmount > 0
    };

    const ptsMsg = result.pointsEarned > 0 ? `\n⭐ Ganaste *+${result.pointsEarned} puntos*` : '';
    const tieneSeña = d.servicio?.seña && result.senaAmount > 0;

    if (tieneSeña) {
      const montoSena = result.senaAmount.toLocaleString('es-AR');
      const senaMsg = MSGS.senaRequerida(d.nombre, srvDisplay, fechaDisplay, result.horaReal, result.code, montoSena, result.mpLink || null);
      session.step = 'PEDIR_APELLIDO';
      return send(senaMsg + (ptsMsg ? `\n\n${ptsMsg}` : '') + `\n\n¿Me decís tu apellido para el programa de beneficios? 💛 _(o *no* para saltear)_`);
    }

    const confirmMsg = MSGS.turnoConfirmado(d.nombre, srvDisplay, fechaDisplay, result.horaReal, result.code) + ptsMsg;
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

// ── Guardar consulta de color en DB y notificar staff ────────────────────────
async function _guardarConsultaColor(session, phone) {
  const d      = session.data;
  const srv    = d.servicio?.nombre || 'Color';
  const nombre = d.nombre || '';
  const resumenProcesos = [d.consultaProcesos, d.consultaTiempo ? `(hace ${d.consultaTiempo})` : null].filter(Boolean).join(' ');
  const colorDeseado    = d.consultaColorDeseado || 'No especificado';
  const contacto        = d.email || d.telefono || 'No dejó contacto';
  const alistado        = d.consultaTieneAlistado ? ' ⚠️ Tiene alisado/keratina' : '';
  const notes = `Procesos: ${resumenProcesos || 'Sin procesos previos'}${alistado} | Resultado buscado: ${colorDeseado} | Contacto: ${contacto}`;

  try {
    const db = require('../core/db');
    const saved = await db.bookingSave({
      sessionId: session.id, nombre, phone, servicio: srv,
      fecha: '', hora: '', monto: d.servicio?.precio || 0,
      senaPaid: false, calendarEventId: null,
      email: d.email || null, notes, status: 'Consulta Pendiente'
    });
    console.log(`[color-consulta] guardado id=${saved?.id} code=${saved?.code}`);
  } catch(e) { console.error('[color-consulta] DB error:', e.message); }

  // Notificar al staff por WhatsApp si está configurado
  _notificarStaffColor(phone, nombre, srv, resumenProcesos, colorDeseado, contacto, alistado);
}

function _notificarStaffColor(phone, nombre, srv, resumenProcesos, colorDeseado, contacto, alistado) {
  const STAFF_WA   = process.env.STAFF_WHATSAPP_PHONE;
  const WASS_TOKEN = process.env.WASSENGER_TOKEN || process.env.WASSENGER_API_KEY;
  if (!STAFF_WA || !WASS_TOKEN) return;
  const axios = require('axios');
  const msg = `🎨 *NUEVA CONSULTA DE COLOR*\n\n👤 ${nombre || 'Sin nombre'} · 📱 ${phone}\n✂️ ${srv}\n💬 Procesos: ${resumenProcesos || 'pelo natural'}${alistado ? '\n' + alistado : ''}\n🎯 Busca: ${colorDeseado}\n📬 Contacto: ${contacto}\n\n_Ver consulta en el panel:_\nhttps://peluqueria-bot.onrender.com/staff`;
  axios.post('https://api.wassenger.com/v1/messages',
    { phone: STAFF_WA, message: msg },
    { headers: { Token: WASS_TOKEN }, timeout: 8000 }
  ).catch(e => console.error('[color-consulta] WA staff error:', e.message));
}

function _notificarStaffDerivacion(phone, nombre, msgOriginal) {
  const STAFF_WA   = process.env.STAFF_WHATSAPP_PHONE;
  const WASS_TOKEN = process.env.WASSENGER_TOKEN || process.env.WASSENGER_API_KEY;
  if (!STAFF_WA || !WASS_TOKEN) return;
  const axios = require('axios');
  const msg = `💬 *DERIVACIÓN A REPRESENTANTE*\n\n👤 ${nombre || 'Sin nombre'} · 📱 ${phone}\nConsultó: "_${msgOriginal}_"\n\nRequiere atención manual para asesorar sobre alternativas sin formol 💛`;
  axios.post('https://api.wassenger.com/v1/messages',
    { phone: STAFF_WA, message: msg },
    { headers: { Token: WASS_TOKEN }, timeout: 8000 }
  ).catch(e => console.error('[derivacion] WA staff error:', e.message));
}

module.exports = { handle, MSGS };
