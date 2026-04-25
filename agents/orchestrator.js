// agents/orchestrator.js — v3
// Regla fundamental: EL ESTADO MANDA. Haiku/Sonnet solo hablan cuando
// no hay respuesta hardcodeada. El state machine nunca pierde contra la IA.
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

// ── Mensajes hardcodeados ─────────────────────────────────────────────────────
const MSGS = {
  precios: () =>
    `💈 *Servicios y Precios — Estefan Peluquería*\n\n` +
    `✂️ *Cortes*\n  • Corte de pelo: *$50.000* _(incluye lavado y aireado)_\n  • Corte + Brushing: *$70.000*\n  • Brushing / Planchita: *$20.000*\n  • Lavado + Aireado: *$15.000*\n\n` +
    `🎨 *Color* _(consulta previa requerida)_\n  • Retoque / Raíz: *$60.000*\n  • Color entero: *desde $80.000*\n  • Contorno: *$80.000*\n  • Balayage: *desde $200.000*\n  • Decoloración total: *desde $200.000*\n\n` +
    `💆 *Tratamientos*\n  • Ozono capilar: *$30.000*\n  • Head Spa completo: *$120.000*\n  • Ampolla reparadora: *$30.000*\n\n` +
    `💐 *Peinados* _(requieren seña)_\n  • Fiesta / 15 años: *desde $60.000*\n  • Novia: *desde $150.000*\n\n` +
    `_Escribí *reservar* para sacar un turno 💛_`,

  turnoEncontrado: (b) =>
    `📋 *Tu turno:*\n\n👤 ${b.nombre}\n✂️ ${b.servicio}\n📅 ${b.fecha} · ⏰ ${b.hora}\n🔖 ${b.code}\n\n` +
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
    msg += `\n\n✅ *¿Confirmamos?* (sí / no)`;
    return msg;
  },

  turnoConfirmado: (nombre, servicio, fechaDisplay, hora, code) =>
    `✅ *¡Listo${nombre ? ', ' + nombre : ''}!* 💛\n\n📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n_Guardá el código — con ese podés cambiar o cancelar cuando quieras_ 😊`,

  senaRequerida: (nombre, servicio, fechaDisplay, hora, code, montoSena, mpLink) =>
    `⏳ *Tu turno está registrado${nombre ? ', ' + nombre : ''}*\n\n📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n` +
    `⚠️ *Para confirmar necesitamos la seña de $${montoSena}*\n` +
    (mpLink
      ? `Podés abonarlo acá 👇\n${mpLink}\n\n_Una vez recibido el pago te llega la confirmación_ 📧`
      : `Coordinamos el pago cuando vengas o por este chat 💛`),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractEmail(text) {
  const m = (text || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return m.sort((a, b) => b.length - a.length)[0] || null;
}

const SI_RE  = /^(si\b|sí\b|dale|ok|va|claro|confirmo|bueno|perfecto|listo|sip|obvio|re\b)/i;
const NO_RE  = /^(no\b|nop|mejor no|cancelar|no quiero|paso\b)/i;

// Extrae servicio del texto usando regex directos (más confiable que la IA para esto)
function detectarServicioTexto(tl, SERVICIOS) {
  if (/corte.*brushing|brushing.*corte/i.test(tl))       return SERVICIOS.findByName('Corte + Brushing');
  if (/\bcorte\b/i.test(tl))                              return SERVICIOS.findByName('Corte de pelo');
  if (/brushing|planchita/i.test(tl))                     return SERVICIOS.findByName('Brushing / Planchita');
  if (/lavado|aireado/i.test(tl))                         return SERVICIOS.findByName('Lavado + Aireado');
  if (/balayage|balaige/i.test(tl))                       return SERVICIOS.findByName('Balayage');
  if (/decolor|mechas|mechitas/i.test(tl))                return SERVICIOS.findByName('Decoloración total');
  if (/raiz|raíz|retoque/i.test(tl))                     return SERVICIOS.findByName('Retoque / Raíz');
  if (/\bcontorno\b/i.test(tl))                           return SERVICIOS.findByName('Contorno');
  if (/color entero|tintura|teñi|tinte/i.test(tl))       return SERVICIOS.findByName('Color entero');
  if (/head.?spa/i.test(tl))                              return SERVICIOS.findByName('Head Spa completo');
  if (/\bozono\b/i.test(tl))                              return SERVICIOS.findByName('Ozono');
  if (/ampolla/i.test(tl))                                return SERVICIOS.findByName('Ampolla');
  if (/\bnovia\b/i.test(tl))                              return SERVICIOS.findByName('Peinado novia');
  if (/fiesta|15\s*años/i.test(tl))                       return SERVICIOS.findByName('Peinado fiesta / 15');
  return null;
}

// Detecta segundo servicio (después del primero ya encontrado)
function detectarServicio2(tl, principal, SERVICIOS) {
  const candidatos = [
    { re: /brushing|planchita/i,  nombre: 'Brushing / Planchita' },
    { re: /lavado|aireado/i,      nombre: 'Lavado + Aireado' },
    { re: /\bozono\b/i,           nombre: 'Ozono' },
    { re: /ampolla/i,             nombre: 'Ampolla' },
    { re: /head.?spa/i,           nombre: 'Head Spa completo' },
  ];
  for (const c of candidatos) {
    if (c.nombre !== principal?.nombre && c.re.test(tl)) {
      return SERVICIOS.findByName(c.nombre);
    }
  }
  return null;
}

// Extrae día/hora del texto en forma simple
function extractDiaHora(tl) {
  const DIAS = ['lunes','martes','miércoles','miercoles','jueves','viernes','sábado','sabado'];
  const dia  = DIAS.find(d => tl.includes(d)) || (/\bhoy\b/.test(tl) ? 'hoy' : null);
  const horaMatch = tl.match(/(\d{1,2})[:.](\d{2})|(\d{1,2})\s*(?:hs?|horas?)/i);
  let hora = null;
  if (horaMatch) {
    const h  = parseInt(horaMatch[1] || horaMatch[3]);
    const m  = parseInt(horaMatch[2] || '0');
    hora = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  return { dia, hora };
}

// ── Handler principal ─────────────────────────────────────────────────────────
async function handle({ sessionId, phone, text }) {
  const t  = (text || '').trim();
  const tl = t.toLowerCase();
  const session = getSession(sessionId);

  // ⚠️ FIX CRÍTICO: inicializar step a 'LIBRE' si está undefined
  if (!session.step)    session.step    = 'LIBRE';
  if (!session.data)    session.data    = {};
  if (!session.historial) session.historial = [];
  if (!session.profile) session.profile = {};

  await conversationLog(phone, 'user', t);
  console.log(`[orch] step=${session.step} phone=${phone} msg="${t.substring(0,60)}"`);

  const send = async (msg) => {
    await conversationLog(phone, 'assistant', msg);
    session.historial.push({ role: 'assistant', content: msg });
    return msg;
  };

  // Agregar mensaje al historial ANTES de procesar
  session.historial.push({ role: 'user', content: t });
  if (session.historial.length > 20) session.historial = session.historial.slice(-20);

  // ── CEO MODE ────────────────────────────────────────────────────────────────
  const CEO_PHONE = process.env.CEO_PHONE || process.env.OWNER_PHONE;
  if (CEO_PHONE && phone === CEO_PHONE) {
    const reply = await personal.handleCEO(t, session.historial);
    return send(reply);
  }

  // ── FAQ SHORTCUT ────────────────────────────────────────────────────────────
  const clientCtxFAQ = await intake.buildContext(phone);
  const faqReply = personal.handleFAQ(t, clientCtxFAQ);
  if (faqReply) return send(faqReply);

  // ── COMANDOS GLOBALES (siempre disponibles) ─────────────────────────────────
  if (/^(\.?menu|menú|inicio|volver|start)$/i.test(tl)) {
    session.step = 'LIBRE'; session.data = {};
    const nombre = session.profile?.nombre || clientCtxFAQ?.profile?.nombre || null;
    return send(personal.greet(nombre));
  }

  if (/hablar.*persona|quiero.*humano|hablar.*alguien|necesito.*alguien|un agente/i.test(tl)) {
    _notificarStaffDerivacion(phone, session.profile?.nombre, t);
    session.step = 'LIBRE';
    return send('Te conecto con alguien del equipo — te responden en menos de 2 horas 💛');
  }

  // ── MENÚ NUMÉRICO (step LIBRE) ───────────────────────────────────────────────
  // FIX: acepta "3", "3.", "3 " — y funciona desde step LIBRE
  if (session.step === 'LIBRE' && /^[1-4][\s.]*$/.test(t)) {
    const n = parseInt(t);
    if (n === 1) {
      session.step = 'RESERVANDO';
      session.data = {
        nombre:           session.profile?.nombre || null,
        email:            session.profile?.email  || null,
        emailPreguntado:  !!session.profile?.email,
        nombrePreguntado: !!session.profile?.nombre,
        upsellOfrecido:   false,
      };
      // Si la clienta YA tiene nombre del perfil, no lo pedimos
      const ctxReserva = await intake.buildContext(phone);
      return send(
        await personal.responder({
          mensaje: 'La clienta quiere sacar un turno. Dales la bienvenida al proceso de reserva con entusiasmo y preguntá qué servicio quiere. Sé breve y cálida.',
          historial: [],
          contextoExtra: ctxReserva?.profile?.toPromptContext?.() || '',
        })
      );
    }
    if (n === 2) { session.step = 'BUSCANDO_TURNO'; return send('🔍 Ingresá tu *código* (ej: #AB12) o tu nombre completo:'); }
    if (n === 3) return send(MSGS.precios());
    if (n === 4) {
      _notificarStaffDerivacion(phone, session.profile?.nombre, 'Opción 4 del menú');
      return send('Te conecto con alguien del equipo 💛 Te responden a la brevedad.');
    }
  }

  // ── HOLA / SALUDOS (step LIBRE) ──────────────────────────────────────────────
  if (session.step === 'LIBRE' && /^(hola\b|buenas\b|buen dia|buenos dias|buenas tardes|buenas noches|hey\b|hi\b)/i.test(tl)) {
    const nombre = session.profile?.nombre || clientCtxFAQ?.profile?.nombre || null;
    return send(personal.greet(nombre));
  }

  // ── FLUJO RESERVA ────────────────────────────────────────────────────────────
  if (session.step === 'RESERVANDO' || (session.step === 'LIBRE' && /reservar|turno|sacar.*turno|quiero.*turno/i.test(tl))) {
    session.step = 'RESERVANDO';

    // Inicializar data si viene de LIBRE
    if (!session.data.servicio && !session.data.nombrePreguntado) {
      session.data = {
        nombre:           session.profile?.nombre || null,
        email:            session.profile?.email  || null,
        emailPreguntado:  !!session.profile?.email,
        nombrePreguntado: !!session.profile?.nombre,
        upsellOfrecido:   false,
        ...session.data,
      };
    }

    // Extracción directa por regex (más confiable que la IA)
    const d = session.data;

    // Servicio
    if (!d.servicio) {
      const srv = detectarServicioTexto(tl, SERVICIOS);
      if (srv) {
        d.servicio = srv;
        if (srv.consulta) { d.consultaOk = false; }
        console.log(`[orch] servicio detectado: ${srv.nombre}`);

        // Segundo servicio en el mismo mensaje
        const srv2 = detectarServicio2(tl, srv, SERVICIOS);
        if (srv2 && !d.extra) {
          d.extra = srv2;
          d.upsellOfrecido = true;
          console.log(`[orch] servicio2 detectado: ${srv2.nombre}`);
        }
      }
    }

    // Número como selección de servicio (cuando el bot mostró la lista)
    if (!d.servicio && /^\d{1,2}$/.test(t)) {
      const n = parseInt(t);
      const mapa = {
        1:'Corte de pelo', 2:'Corte + Brushing', 3:'Brushing / Planchita', 4:'Lavado + Aireado',
        5:'Ozono', 6:'Head Spa completo', 7:'Ampolla',
        8:'Retoque / Raíz', 9:'Color entero', 10:'Contorno', 11:'Balayage', 12:'Decoloración total',
        13:'Peinado fiesta / 15', 14:'Peinado novia',
      };
      if (mapa[n]) {
        const srv = SERVICIOS.findByName(mapa[n]);
        if (srv) { d.servicio = srv; if (srv.consulta) d.consultaOk = false; }
      }
    }

    // Día y hora
    const { dia, hora } = extractDiaHora(tl);
    if (dia && !d.dia)   d.dia  = dia;
    if (hora && !d.hora) d.hora = hora;

    // Nombre propio (simple heurística: texto corto sin palabras de servicio)
    if (!d.nombre && !d.nombrePreguntado) {
      const esPosibleNombre = t.length < 40 && /^[A-Za-záéíóúÁÉÍÓÚñÑ\s]+$/.test(t) && !d.servicio;
      if (esPosibleNombre) {
        d.nombre = t.trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      }
    }

    return await avanzarReserva(session, phone, send, await intake.buildContext(phone));
  }

  // ── SELECCIÓN NUMÉRICA DE SERVICIO (step RESERVANDO, sin servicio aún) ───────
  if (session.step === 'RESERVANDO' && !session.data.servicio && /^\d{1,2}$/.test(t)) {
    const n = parseInt(t);
    const mapa = {
      1:'Corte de pelo', 2:'Corte + Brushing', 3:'Brushing / Planchita', 4:'Lavado + Aireado',
      5:'Ozono', 6:'Head Spa completo', 7:'Ampolla',
      8:'Retoque / Raíz', 9:'Color entero', 10:'Contorno', 11:'Balayage', 12:'Decoloración total',
      13:'Peinado fiesta / 15', 14:'Peinado novia',
    };
    if (mapa[n]) {
      const srv = SERVICIOS.findByName(mapa[n]);
      if (srv) {
        session.data.servicio = srv;
        if (srv.consulta) session.data.consultaOk = false;
        return await avanzarReserva(session, phone, send, await intake.buildContext(phone));
      }
    }
  }

  // ── DERIVACIÓN A HUMANO ──────────────────────────────────────────────────────
  if (session.step === 'DERIVACION_HUMANO') {
    session.step = 'LIBRE';
    if (NO_RE.test(tl)) return send('¡Sin problema! 💛 ¿Puedo ayudarte con algo más?');
    return send('¡Perfecto! 💛 Una de nuestras representantes te escribe a la brevedad. ¡Gracias por consultarnos! 🌟');
  }

  // ── FLUJO CONSULTA COLOR ─────────────────────────────────────────────────────
  if (session.step === 'COLOR_CONSULTA_TIPO') {
    const noPrevios = /^(1|no\b|nop|natural|virgen|ninguno)/i.test(tl);
    if (noPrevios) {
      session.data.consultaProcesos = 'Sin procesos previos';
      session.step = 'COLOR_DETALLE_COLOR';
      return send('¡Genial, pelo natural es ideal para trabajar! 💛\n\n¿Cuál sería el resultado que buscás?\n\n_Ej: "rubia natural", "castaño oscuro", "mechitas caramelo"..._');
    }
    session.data.consultaProceso1 = t;
    session.step = 'COLOR_DETALLE_PROCESO';
    return send('¿Qué tipo de proceso tenés actualmente?\n\n1 — Tintura (color/raíz)\n2 — Decoloración o mechitas\n3 — Alisado / Keratina\n4 — Varios / no estoy segura');
  }

  if (session.step === 'COLOR_DETALLE_PROCESO') {
    session.data.consultaProcesos = t;
    session.data.consultaTieneAlistado = /alisado|keratina|botox|3/i.test(tl);
    session.step = 'COLOR_DETALLE_TIEMPO';
    return send('¿Hace cuánto te hiciste ese proceso?\n\n_Ej: "hace 2 semanas", "hace 3 meses"_ 📅');
  }

  if (session.step === 'COLOR_DETALLE_TIEMPO') {
    session.data.consultaTiempo = t;
    session.step = 'COLOR_DETALLE_COLOR';
    return send('¡Gracias! 💛 ¿Y cuál es el resultado que buscás?\n\n_Ej: "rubia platinada", "mechitas caramelo sobre castaño"..._');
  }

  if (session.step === 'COLOR_DETALLE_COLOR') {
    session.data.consultaColorDeseado = t;
    if (session.data.nombre) {
      session.step = 'COLOR_PEDIR_FOTOS';
      return send(`¡Perfecto, eso ayuda muchísimo! 💛\n\n📸 *Foto 1:* Tu pelo hoy (buena luz, natural)\n📸 *Foto 2:* Una referencia del resultado buscado (Pinterest, Instagram)\n\nEstas fotos van directo al equipo y te contactamos con todo listo 💛`);
    }
    session.step = 'COLOR_PEDIR_NOMBRE';
    return send('¡Perfecto! 💛 ¿Me decís tu nombre para que el equipo pueda contactarte? 😊');
  }

  if (session.step === 'COLOR_PEDIR_NOMBRE') {
    session.data.nombre = /^(no|nop|paso|skip|-)$/i.test(tl) ? '' : t.trim();
    session.step = 'COLOR_PEDIR_EMAIL';
    const saludo = session.data.nombre ? `¡Gracias, ${session.data.nombre.split(' ')[0]}! ` : '¡Gracias! ';
    return send(`${saludo}💛 ¿Me dejás un mail o número de contacto?\n_(o *no* para saltear)_`);
  }

  if (session.step === 'COLOR_PEDIR_EMAIL') {
    if (/[@.]/.test(t)) session.data.email = t.trim().toLowerCase();
    else if (!/^(no|nop|paso|skip|-)$/i.test(tl)) session.data.telefono = t.trim();
    session.step = 'COLOR_PEDIR_FOTOS';
    return send('¡Perfecto! 💛\n\n📸 *Foto 1:* Tu pelo hoy (buena luz)\n📸 *Foto 2:* Una referencia del resultado buscado\n\nEstas fotos van directo al equipo 💛');
  }

  if (session.step === 'COLOR_PEDIR_FOTOS') {
    await _guardarConsultaColor(session, phone);
    session.step = 'LIBRE'; session.data = {};
    return send('¡Perfecto! 💛 En cuanto el equipo revise las fotos te contactamos para confirmar todo.\n\nNormalmente respondemos dentro de las 24hs. ¡Gracias! 🌟');
  }

  // ── UPSELL ───────────────────────────────────────────────────────────────────
  if (session.step === 'UPSELL') {
    const u = session.data.pendingUpsell;
    if (SI_RE.test(tl) && u) {
      session.data.extra = SERVICIOS.findById(u.targetId);
      session.data.pendingUpsell = null;
      session.step = 'CONFIRM_TURNO';
      return send(MSGS.confirmar(session.data));
    }
    if (NO_RE.test(tl) || /^2/.test(t)) {
      session.data.pendingUpsell = null;
      session.step = 'CONFIRM_TURNO';
      return send(MSGS.confirmar(session.data));
    }
    // Pregunta sobre el upsell — Sonnet responde
    const srvNombre = u ? (SERVICIOS.findById(u.targetId)?.nombre || 'el tratamiento') : 'el tratamiento';
    return send(await personal.responder({
      mensaje: session.historial[session.historial.length - 2]?.content || t,
      historial: session.historial.slice(-6),
      contextoExtra: `La clienta pregunta sobre "${srvNombre}". Explicá brevemente el beneficio y preguntá si lo suma. Terminá con "¿Lo sumamos?" o similar.`,
    }));
  }

  // ── CONFIRMACIONES ────────────────────────────────────────────────────────────
  if (session.step === 'CONFIRM_TURNO') {
    if (session.data.servicio?.consulta && !session.data.consultaOk) {
      session.step = 'COLOR_CONSULTA_TIPO';
      const nombre = session.data.nombre?.split(' ')[0] || '';
      return send(`${nombre ? nombre + ', a' : 'A'}ntes de agendar el *${session.data.servicio.nombre}* necesitamos una consulta previa 💛\n\n¿Tenés tinturas, decoloraciones, alisados o algún proceso químico en el pelo?\n\n1 — No, pelo natural\n2 — Sí, tengo procesos previos`);
    }
    if (SI_RE.test(tl)) return await doCreateBooking(session, phone, send);
    if (NO_RE.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('Perfecto, no reservé nada 😊 Cuando quieras, acá estoy 💛'); }
    return send(MSGS.confirmar(session.data));
  }

  if (session.step === 'CONFIRM_CANCELAR') {
    if (SI_RE.test(tl)) return await doCancelBooking(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cancelé nada 😊');
  }

  if (session.step === 'CONFIRM_REPROGRAM') {
    if (SI_RE.test(tl)) return await doReschedule(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cambié nada 😊');
  }

  // ── EMAIL EN RESERVA ─────────────────────────────────────────────────────────
  if (session.step === 'PEDIR_EMAIL_RESERVA') {
    const em = extractEmail(t);
    if (em) {
      session.data.email = em;
      await clientUpsert(phone, session.data.nombre || null, em).catch(() => {});
    }
    if (/^no\b/i.test(tl)) session.data.emailSkipped = true;
    session.data.emailPreguntado = true;
    session.step = 'RESERVANDO';
    return await avanzarReserva(session, phone, send, await intake.buildContext(phone));
  }

  // ── POST-CONFIRMACIÓN ─────────────────────────────────────────────────────────
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
      const mS = t.match(/^([A-Za-záéíóúÁÉÍÓÚñÑ]+)$/i);
      session.data.apellido = mS ? mS[1].trim() : t.trim();
      session.profile.apellido = session.data.apellido;
      session.step = 'PEDIR_PROMO';
      return send('¿Querés que te avisemos de descuentos y sorteos? 🎁\n\n1 — Sí, me interesa\n2 — No, gracias');
    }
    return send('¿Cuál es tu apellido? _(o *no* para saltear)_');
  }

  if (session.step === 'PEDIR_PROMO') {
    const si = SI_RE.test(tl) || /^1/.test(t);
    const no = NO_RE.test(tl) || /^2/.test(t);
    if (si || no) {
      await clientUpdateProfile(phone, { lastName: session.data.apellido || null, email: session.data.email || null, promoOptIn: si, profileComplete: !!(session.data.apellido && session.data.email) });
      syncClientesToSheet().catch(() => {});
      session.step = 'LIBRE'; session.data = {};
      return send(si ? '¡Genial! Ya estás en el programa de beneficios 🎉 💛' : '¡Perfecto! Te esperamos 💛');
    }
    return send('Respondé *1* para sí o *2* para no 😊');
  }

  // ── LOYALTY ───────────────────────────────────────────────────────────────────
  if (session.step === 'LOYALTY_CANJE') {
    const n = parseInt(tl);
    if (n > 0 && session.data.availableRewards?.[n - 1]) {
      const result = await loyalty.redeem(phone, session.data.availableRewards[n - 1].id);
      session.step = 'LIBRE'; session.data = {};
      return send(result.msg);
    }
    if (/^(no\b|volver|salir)/i.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Cuando quieras! 💛'); }
  }

  if (/puntos|beneficio|canje|premio|mis puntos/i.test(tl)) {
    const result = await loyalty.showBalance(phone);
    if (result.available?.length > 0) {
      session.data.availableRewards = result.available;
      session.step = 'LOYALTY_CANJE';
      return send(result.msg + '\n\n_Respondé con el número para canjear, o *no* para volver_ 💛');
    }
    return send(result.msg);
  }

  // ── BUSCAR TURNO ──────────────────────────────────────────────────────────────
  if (session.step === 'BUSCANDO_TURNO') {
    const found = await booking.findBooking(t, phone);
    if (found) { session.data.booking = found; session.step = 'OPCION_TURNO'; return send(MSGS.turnoEncontrado(found)); }
    return send('No encontré un turno 😅 Ingresá tu *código* (ej: #AB12) o tu *nombre completo*:');
  }

  if (session.step === 'OPCION_TURNO') {
    const n = parseInt(tl);
    const b = session.data.booking;
    if (n === 1 || /cambiar|reprograma/i.test(tl)) { session.step = 'REPROGRAM_DATOS'; return send('¿A qué *día y hora* querés cambiar?\n_Ej: "el viernes a las 15"_ 📅'); }
    if (n === 2 || /cancelar/i.test(tl)) { session.step = 'CONFIRM_CANCELAR'; return send(`⚠️ ¿Confirmás que querés *cancelar*?\n\n✂️ ${b?.servicio}\n📅 ${b?.fecha} · ⏰ ${b?.hora}\n\n*sí* / *no*`); }
    session.step = 'LIBRE'; session.data = {};
    return send('¡Listo! ¿En qué más te puedo ayudar? 💛');
  }

  if (session.step === 'REPROGRAM_DATOS') {
    const { dia, hora } = extractDiaHora(tl);
    if (dia)  session.data.newDia  = dia;
    if (hora) session.data.newHora = hora;
    if (session.data.newDia && session.data.newHora) {
      const b = session.data.booking;
      session.step = 'CONFIRM_REPROGRAM';
      return send(`📋 *Confirmá el cambio:*\n\n✂️ ${b?.servicio}\n📅 *${session.data.newDia}* · ⏰ *${session.data.newHora}*\n\n*sí* / *no*`);
    }
    if (!session.data.newDia) return send('¿Qué *día* te viene bien? (lunes a sábado)');
    return send(`¿A qué *hora* el ${session.data.newDia}?`);
  }

  // ── ACTUALIZAR EMAIL ──────────────────────────────────────────────────────────
  if (session.step === 'ACTUALIZAR_EMAIL') {
    const em = extractEmail(t);
    if (em) {
      await clientUpdateProfile(phone, { email: em });
      session.profile.email = em; session.data.email = em; session.step = 'LIBRE';
      syncClientesToSheet().catch(() => {});
      return send(`✅ ¡Email actualizado a *${em}*! 💛`);
    }
    if (/^no\b/i.test(tl)) { session.step = 'LIBRE'; return send('¡Sin problema! 💛'); }
    return send('Escribí tu nuevo email o *no* para cancelar 😊');
  }

  if (/actualiz|correg|cambiar.*mail|mail.*mal|email.*mal/i.test(tl)) {
    session.step = 'ACTUALIZAR_EMAIL';
    return send('¡Claro! 💛 Pasame tu email correcto y lo actualizamos 📧');
  }

  // ── ALISADOS/KERATINA → derivar ───────────────────────────────────────────────
  if (/alisado|keratina|botox|nanoplastia|progressiva|formol/i.test(tl)) {
    _notificarStaffDerivacion(phone, session.profile?.nombre, t);
    session.step = 'DERIVACION_HUMANO';
    return send(
      '¡Buenísima consulta! 💛 En el salón trabajamos sin formol ni químicos agresivos, pero tenemos tratamientos que dan resultados increíbles:\n\n' +
      '✨ *Head Spa completo* — hidrata, suaviza y da brillo real ($120.000)\n' +
      '🌿 *Ozono capilar* — revitaliza y mejora la textura progresivamente ($30.000)\n' +
      '💧 *Ampolla reparadora* — nutrición intensiva para cabello con frizz ($30.000)\n\n' +
      '¿Está bien si una de nuestras representantes te escribe para asesorarte mejor? 😊'
    );
  }

  // ── PRECIOS ESPECÍFICOS ────────────────────────────────────────────────────────
  if (/precio|cuánto|cuanto|cuesta|vale|cobran/i.test(tl) || /reservar|turno|sacar/i.test(tl) === false) {
    const PRECIOS_LISTA = [
      { re: /corte.*brushing|brushing.*corte/i, txt: '✂️ *Corte + Brushing:* $70.000' },
      { re: /\bcorte\b/i,           txt: '✂️ *Corte de pelo:* $50.000 _(incluye lavado y aireado)_' },
      { re: /brushing|planchita/i,  txt: '💇 *Brushing / Planchita:* $20.000' },
      { re: /lavado|aireado/i,      txt: '💧 *Lavado + Aireado:* $15.000' },
      { re: /balayage/i,            txt: '🎨 *Balayage:* desde $200.000 _(requiere consulta previa)_' },
      { re: /decolor|mechas/i,      txt: '🎨 *Decoloración total:* desde $200.000' },
      { re: /raiz|raíz|retoque/i,  txt: '🎨 *Retoque / Raíz:* $60.000' },
      { re: /\bcontorno\b/i,        txt: '🎨 *Contorno:* $80.000' },
      { re: /color entero|tintura/i,txt: '🎨 *Color entero:* desde $80.000' },
      { re: /\bnovia\b/i,           txt: '💐 *Peinado novia:* desde $150.000' },
      { re: /fiesta|15/i,           txt: '💐 *Peinado fiesta / 15:* desde $60.000' },
      { re: /head.?spa/i,           txt: '💆 *Head Spa completo:* $120.000' },
      { re: /\bozono\b/i,           txt: '💆 *Ozono capilar:* $30.000' },
      { re: /ampolla/i,             txt: '✨ *Ampolla reparadora:* $30.000' },
    ];
    const mencionados = PRECIOS_LISTA.filter(s => s.re.test(t));
    if (mencionados.length > 0) {
      const lista = mencionados.map(s => '  • ' + s.txt).join('\n');
      return send(lista + '\n\n_¿Querés reservar? Escribí *reservar* 💛_');
    }
  }

  // ── FALLBACK: Sonnet responde libremente ──────────────────────────────────────
  const clientCtx = await intake.buildContext(phone);
  memory.update(phone, clientCtx?.client, t).catch(() => {});

  const respuesta = await personal.responder({
    mensaje: t,
    historial: session.historial.slice(-10),
    contextoExtra: clientCtx?.profile?.toPromptContext?.() || '',
  });
  return send(respuesta);
}

// ── avanzarReserva ────────────────────────────────────────────────────────────
async function avanzarReserva(session, phone, send, clientCtx) {
  const d = session.data;
  console.log(`[avanzar] srv=${d.servicio?.nombre} consulta=${d.servicio?.consulta} consultaOk=${d.consultaOk} dia=${d.dia} hora=${d.hora} nombre=${d.nombre}`);

  // Servicio de color → consulta previa obligatoria
  if (!d.servicio?.consulta && d.extra?.consulta) {
    const tmp = d.servicio; d.servicio = d.extra; d.extra = tmp;
    d.consultaOk = false;
    console.log(`[avanzar] extra con consulta promovido a principal`);
  }

  if (d.servicio?.consulta && !d.consultaOk) {
    session.step = 'COLOR_CONSULTA_TIPO';
    const nombre = d.nombre?.split(' ')[0] || '';
    return send(
      `${nombre ? nombre + ', a' : 'A'}ntes de agendar el *${d.servicio.nombre}* necesitamos hacer una consulta previa 💛\n\n` +
      `Te hago unas preguntas rápidas para que las estilistas se preparen.\n\n` +
      `¿Tenés tinturas, decoloraciones, alisados o algún proceso químico en el pelo?\n\n` +
      `1 — No, pelo natural\n2 — Sí, tengo procesos previos`
    );
  }

  // Construir respuesta contextual con Sonnet (sabe lo que ya tiene)
  if (!d.servicio) {
    // Sin servicio — Sonnet pregunta de forma conversacional
    const ctx = [`Estás en el flujo de reserva.`];
    if (d.nombre) ctx.push(`Nombre: ${d.nombre}`);
    return send(await personal.responder({
      mensaje: 'La clienta quiere sacar un turno pero aún no dijo qué servicio quiere. Preguntale de forma cálida y breve.',
      historial: session.historial.slice(-6),
      contextoExtra: ctx.join('\n'),
    }));
  }

  if (!d.dia) {
    // Tiene servicio, falta día
    const ctx = [`Servicio elegido: ${d.servicio.nombre}${d.extra ? ' + ' + d.extra.nombre : ''}. Falta: día.`];
    if (d.nombre) ctx.push(`Nombre: ${d.nombre}`);
    return send(await personal.responder({
      mensaje: `La clienta eligió ${d.servicio.nombre}. Celebrá la elección y preguntá qué día le viene bien. Recordale que atendemos lunes a sábado de 10 a 20hs. Sé breve.`,
      historial: session.historial.slice(-6),
      contextoExtra: ctx.join('\n'),
    }));
  }

  if (!d.hora) {
    return send(await personal.responder({
      mensaje: `La clienta eligió ${d.servicio.nombre} para el ${d.dia}. Preguntá a qué hora. Horario: 10:00 a 20:00hs.`,
      historial: session.historial.slice(-4),
      contextoExtra: '',
    }));
  }

  if (!d.nombre) {
    d.nombrePreguntado = true;
    return send(await personal.responder({
      mensaje: 'Tenemos servicio, día y hora. Solo falta el nombre para anotar el turno. Pedilo de forma breve y cálida.',
      historial: session.historial.slice(-4),
      contextoExtra: '',
    }));
  }

  // Email
  if (!d.emailPreguntado) {
    d.emailPreguntado = true;
    const clientEmail = clientCtx?.client?.email;
    if (clientEmail) {
      d.email = clientEmail;
    } else {
      session.step = 'PEDIR_EMAIL_RESERVA';
      return send('¿Cuál es tu email? Te mando la confirmación ✉️\n_(o *no* para saltear)_');
    }
  }

  // Upsell
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
      code: result.code, calLink: result.calLink, monto: result.monto,
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
  } catch (e) {
    console.error('[orch] Error creando turno:', e.message);
    session.step = 'LIBRE';
    return send('Ups, hubo un problema técnico 😅 Intentá de nuevo o escribí "hablar con alguien".');
  }
}

async function doCancelBooking(session, phone, send) {
  try {
    const cl = await clientGet(phone);
    await booking.cancel({ bookingData: session.data.booking, phone, email: session.data.email || cl?.email });
    session.step = 'LIBRE'; session.data = {};
    return send('✅ Tu turno fue *cancelado* 💛\n\nCuando quieras reservar de nuevo, acá estamos.');
  } catch (e) {
    console.error('[orch] Error cancelando:', e.message);
    session.step = 'LIBRE';
    return send('Hubo un problema técnico 😅 Escribí "hablar con alguien".');
  }
}

async function doReschedule(session, phone, send) {
  try {
    const cl = await clientGet(phone);
    const result = await booking.reschedule({ bookingData: session.data.booking, newDia: session.data.newDia, newHora: session.data.newHora, phone, email: session.data.email || cl?.email, sessionId: session.id });
    const { formatFecha } = require('../core/utils');
    const fechaDisplay = await formatFecha(result.fechaReal);
    session.step = 'LIBRE'; session.data = {};
    return send(`✅ *¡Turno reprogramado!* 💛\n\n📅 ${fechaDisplay}\n⏰ ${result.horaReal}\n🔖 Nuevo código: *${result.code}*`);
  } catch (e) {
    console.error('[orch] Error reprogramando:', e.message);
    session.step = 'LIBRE';
    return send('Hubo un problema técnico 😅 Escribí "hablar con alguien".');
  }
}

// ── Color consulta helpers ────────────────────────────────────────────────────
async function _guardarConsultaColor(session, phone) {
  const d = session.data;
  const srv    = d.servicio?.nombre || 'Color';
  const nombre = d.nombre || '';
  const resumenProcesos = [d.consultaProcesos, d.consultaTiempo ? `(hace ${d.consultaTiempo})` : null].filter(Boolean).join(' ');
  const colorDeseado    = d.consultaColorDeseado || 'No especificado';
  const contacto        = d.email || d.telefono || 'No dejó contacto';
  const alistado        = d.consultaTieneAlistado ? ' ⚠️ Tiene alisado/keratina' : '';
  const notes = `Procesos: ${resumenProcesos || 'Sin procesos previos'}${alistado} | Resultado: ${colorDeseado} | Contacto: ${contacto}`;

  try {
    const db = require('../core/db');
    await db.bookingSave({ sessionId: session.id, nombre, phone, servicio: srv, fecha: '', hora: '', monto: d.servicio?.precio || 0, senaPaid: false, calendarEventId: null, email: d.email || null, notes, status: 'Consulta Pendiente' });
  } catch (e) { console.error('[color-consulta] DB error:', e.message); }

  _notificarStaffColor(phone, nombre, srv, resumenProcesos, colorDeseado, contacto, alistado);
}

function _notificarStaffColor(phone, nombre, srv, resumenProcesos, colorDeseado, contacto, alistado) {
  const STAFF_WA   = process.env.STAFF_WHATSAPP_PHONE;
  const WASS_TOKEN = process.env.WASSENGER_TOKEN || process.env.WASSENGER_API_KEY;
  if (!STAFF_WA || !WASS_TOKEN) return;
  const axios = require('axios');
  const msg = `🎨 *NUEVA CONSULTA DE COLOR*\n\n👤 ${nombre || 'Sin nombre'} · 📱 ${phone}\n✂️ ${srv}\n💬 Procesos: ${resumenProcesos || 'pelo natural'}${alistado ? '\n' + alistado : ''}\n🎯 Busca: ${colorDeseado}\n📬 Contacto: ${contacto}\n\nhttps://peluqueria-bot.onrender.com/staff`;
  axios.post('https://api.wassenger.com/v1/messages', { phone: STAFF_WA, message: msg }, { headers: { Token: WASS_TOKEN }, timeout: 8000 }).catch(e => console.error('[color] WA error:', e.message));
}

function _notificarStaffDerivacion(phone, nombre, msgOriginal) {
  const STAFF_WA   = process.env.STAFF_WHATSAPP_PHONE;
  const WASS_TOKEN = process.env.WASSENGER_TOKEN || process.env.WASSENGER_API_KEY;
  if (!STAFF_WA || !WASS_TOKEN) return;
  const axios = require('axios');
  const msg = `💬 *DERIVACIÓN*\n\n👤 ${nombre || 'Sin nombre'} · 📱 ${phone}\nConsultó: "_${msgOriginal}_"`;
  axios.post('https://api.wassenger.com/v1/messages', { phone: STAFF_WA, message: msg }, { headers: { Token: WASS_TOKEN }, timeout: 8000 }).catch(e => console.error('[derivacion] WA error:', e.message));
}

module.exports = { handle, MSGS };