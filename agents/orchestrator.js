// agents/orchestrator.js — v5
// State machine determinista: NUNCA saltea un paso del workflow.
// Sonnet genera el texto de cada mensaje — cálido y humano.
// El state machine garantiza: servicio → día → hora → nombre → email → confirmación → código.
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

// ── Constantes ────────────────────────────────────────────────────────────────
const SI_RE = /^(si\b|sí\b|dale|ok|va\b|claro|confirmo|bueno|perfecto|listo|sip|obvio|re\b|sisi|sísi|yes|yep)/i;
const NO_RE = /^(no\b|nop|mejor no|cancelar|no quiero|paso\b|nel)/i;

// ── Detectar servicio desde texto (regex directo, confiable) ──────────────────
function detectarServicio(tl) {
  if (/corte.*brushing|brushing.*corte/i.test(tl))  return SERVICIOS.findByName('Corte + Brushing');
  if (/\bcorte\b/i.test(tl))                         return SERVICIOS.findByName('Corte de pelo');
  if (/brushing|planchita/i.test(tl))                return SERVICIOS.findByName('Brushing / Planchita');
  if (/lavado|aireado/i.test(tl))                    return SERVICIOS.findByName('Lavado + Aireado');
  if (/balayage|balaige/i.test(tl))                  return SERVICIOS.findByName('Balayage');
  if (/decolor|mechas\b|mechitas/i.test(tl))         return SERVICIOS.findByName('Decoloración total');
  if (/raiz|raíz|retoque/i.test(tl))                return SERVICIOS.findByName('Retoque / Raíz');
  if (/\bcontorno\b/i.test(tl))                      return SERVICIOS.findByName('Contorno');
  if (/color entero|tintura|teñi|tinte/i.test(tl))  return SERVICIOS.findByName('Color entero');
  if (/\bcolor\b/i.test(tl))                         return SERVICIOS.findByName('Color entero');
  if (/head.?spa/i.test(tl))                         return SERVICIOS.findByName('Head Spa completo');
  if (/\bozono\b/i.test(tl))                         return SERVICIOS.findByName('Ozono');
  if (/ampolla/i.test(tl))                           return SERVICIOS.findByName('Ampolla');
  if (/\bnovia\b/i.test(tl))                         return SERVICIOS.findByName('Peinado novia');
  if (/fiesta|15\s*años/i.test(tl))                  return SERVICIOS.findByName('Peinado fiesta / 15');
  return null;
}

// Detectar segundo servicio distinto al principal
function detectarServicio2(tl, principal) {
  const candidatos = [
    { re: /brushing|planchita/i,    nombre: 'Brushing / Planchita' },
    { re: /lavado|aireado/i,        nombre: 'Lavado + Aireado' },
    { re: /\bozono\b/i,             nombre: 'Ozono' },
    { re: /ampolla/i,               nombre: 'Ampolla' },
    { re: /head.?spa/i,             nombre: 'Head Spa completo' },
  ];
  for (const c of candidatos) {
    if (c.nombre !== principal?.nombre && c.re.test(tl)) {
      return SERVICIOS.findByName(c.nombre);
    }
  }
  return null;
}

// Detectar número como selección de servicio del menú
const MAPA_NUMERO_SERVICIO = {
  1:'Corte de pelo', 2:'Corte + Brushing', 3:'Brushing / Planchita', 4:'Lavado + Aireado',
  5:'Ozono', 6:'Head Spa completo', 7:'Ampolla',
  8:'Retoque / Raíz', 9:'Color entero', 10:'Contorno', 11:'Balayage', 12:'Decoloración total',
  13:'Peinado fiesta / 15', 14:'Peinado novia',
};

// Detectar día y hora del texto
function detectarDiaHora(tl) {
  const DIAS = ['lunes','martes','miércoles','miercoles','jueves','viernes','sábado','sabado'];
  let dia = DIAS.find(d => tl.includes(d)) || null;
  if (!dia && /\bhoy\b/.test(tl)) dia = 'hoy';

  const horaMatch = tl.match(/(\d{1,2})[:.,](\d{2})(?:\s*hs?)?|(\d{1,2})\s*(?:hs?|horas?)\b/i);
  let hora = null;
  if (horaMatch) {
    const h = parseInt(horaMatch[1] || horaMatch[3]);
    const m = parseInt(horaMatch[2] || '0');
    if (h >= 10 && h <= 20) hora = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  return { dia, hora };
}

// Extraer email del texto
function extractEmail(text) {
  const m = (text || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return m[0] || null;
}

// ── Handler principal ─────────────────────────────────────────────────────────
async function handle({ sessionId, phone, text }) {
  const t  = (text || '').trim();
  const tl = t.toLowerCase();
  const session = getSession(sessionId);

  // Garantizar inicialización
  if (!session.step)     session.step     = 'LIBRE';
  if (!session.data)     session.data     = {};
  if (!session.historial) session.historial = [];
  if (!session.profile)  session.profile  = {};

  await conversationLog(phone, 'user', t);
  console.log(`[orch] step=${session.step} phone=${phone} msg="${t.substring(0,60)}"`);

  const send = async (msg) => {
    await conversationLog(phone, 'assistant', msg);
    session.historial.push({ role: 'assistant', content: msg });
    return msg;
  };

  session.historial.push({ role: 'user', content: t });
  if (session.historial.length > 30) session.historial = session.historial.slice(-30);

  // ── CEO MODE ────────────────────────────────────────────────────────────────
  const CEO_PHONE = process.env.CEO_PHONE || process.env.OWNER_PHONE;
  if (CEO_PHONE && phone === CEO_PHONE) {
    return send(await personal.handleCEO(t, session.historial));
  }

  // ── FAQ SHORTCUT ────────────────────────────────────────────────────────────
  const clientCtx = await intake.buildContext(phone);
  const profile   = clientCtx?.profile || null;
  const faqReply  = personal.handleFAQ(t, clientCtx);
  if (faqReply) return send(faqReply);

  // ── COMANDOS GLOBALES ────────────────────────────────────────────────────────
  if (/^(\.?menu|menú|inicio|volver|start)$/i.test(tl)) {
    session.step = 'LIBRE'; session.data = {};
    return send(await personal.generarSaludo(profile));
  }

  if (/hablar.*persona|quiero.*humano|hablar.*alguien|un agente/i.test(tl)) {
    _notificarStaff(phone, session.profile?.nombre, t, 'DERIVACION');
    session.step = 'LIBRE';
    return send('¡Dale! Le aviso al equipo y te escriben en menos de 2 horas 💛');
  }

  // ── MENÚ PRINCIPAL (step LIBRE) ──────────────────────────────────────────────
  if (session.step === 'LIBRE') {

    // Saludos → regenerar menú
    if (/^(hola\b|buenas\b|buenos días|buen dia|buenas tardes|buenas noches|hey\b|hi\b)/i.test(tl)) {
      return send(await personal.generarSaludo(profile));
    }

    // Opciones numéricas
    if (/^[1-4][\s.]*$/.test(t)) {
      const n = parseInt(t);
      if (n === 1) return await _iniciarReserva(session, phone, profile, send);
      if (n === 2) { session.step = 'BUSCANDO_TURNO'; return send('🔍 Ingresá tu *código de reserva* (ej: #AB12) o tu nombre completo:'); }
      if (n === 3) return send(await personal.responderPrecios(t, session.historial.slice(-4)));
      if (n === 4) {
        _notificarStaff(phone, session.profile?.nombre, 'Opción 4 — quiere hablar con alguien', 'DERIVACION');
        return send('¡Dale! Le aviso al equipo y te escriben a la brevedad 💛');
      }
    }

    // "Quiero reservar / turno / sacar turno"
    if (/reservar|sacar.*turno|quiero.*turno|pedir.*turno/i.test(tl)) {
      return await _iniciarReserva(session, phone, profile, send);
    }

    // Pregunta de precios
    if (/precio|cuánto|cuanto|cuesta|vale|cobran|servicios/i.test(tl)) {
      return send(await personal.responderPrecios(t, session.historial.slice(-4)));
    }

    // Alisado / keratina → derivar
    if (/alisado|keratina|botox capilar|nanoplastia|progressiva|formol/i.test(tl)) {
      return await _derivarAlistado(session, phone, send);
    }
  }

  // ── FLUJO RESERVA ────────────────────────────────────────────────────────────
  if (session.step === 'RESERVANDO') {
    const d = session.data;

    // Detectar y acumular datos del mensaje actual
    if (!d.servicio) {
      // Intento por número de menú
      const numSrv = /^\d{1,2}$/.test(t) ? parseInt(t) : null;
      if (numSrv && MAPA_NUMERO_SERVICIO[numSrv]) {
        d.servicio = SERVICIOS.findByName(MAPA_NUMERO_SERVICIO[numSrv]);
        if (d.servicio?.consulta) d.consultaOk = false;
      } else {
        const srv = detectarServicio(tl);
        if (srv) {
          d.servicio = srv;
          if (srv.consulta) d.consultaOk = false;
          // Segundo servicio en el mismo mensaje
          const srv2 = detectarServicio2(tl, srv);
          if (srv2 && !d.extra) { d.extra = srv2; d.upsellOfrecido = true; }
        }
      }
    }

    // Detectar día y hora del mensaje actual
    const { dia, hora } = detectarDiaHora(tl);
    if (dia  && !d.dia)  d.dia  = dia;
    if (hora && !d.hora) d.hora = hora;

    // Nombre: validación estricta para evitar capturar preguntas como nombres
    if (d._esperandoNombre && !d.nombre) {
      // Rechazar si: tiene signos de pregunta, verbos comunes, es muy corta o muy larga,
      // contiene palabras que claramente no son nombres propios
      const esNombre = (
        !/[¿?!]/.test(t) &&                          // sin signos de pregunta/exclamación
        !/\b(para|porque|por qué|cómo|cuánto|cuándo|qué|quien|quién|cuál|tenés|tengo|hacés|hacen|querés|quiero|puedo|sirve|necesito)\b/i.test(t) &&
        !/\d/.test(t) &&                             // sin números
        t.length >= 2 &&                              // mínimo 2 caracteres
        t.length <= 40 &&                             // máximo 40
        /^[A-Za-záéíóúÁÉÍÓÚüÜñÑ\s'-]+$/.test(t)  // solo letras, espacios, guión, apóstrofe
      );
      if (esNombre) {
        d.nombre = t.trim().split(' ')
          .filter(Boolean)
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
        d._esperandoNombre = false;
      } else {
        // No es un nombre — dejar _esperandoNombre=true y dejar que avanzarReserva lo vuelva a pedir
        console.log(`[orch] texto rechazado como nombre: "${t}"`);
      }
    }

    return await avanzarReserva(session, phone, profile, clientCtx, send);
  }

  // ── UPSELL ───────────────────────────────────────────────────────────────────
  if (session.step === 'UPSELL') {
    const u = session.data.pendingUpsell;
    if (SI_RE.test(tl)) {
      if (u) session.data.extra = SERVICIOS.findById(u.targetId);
      session.data.pendingUpsell = null;
      session.step = 'CONFIRM_TURNO';
      return send(personal.resumenConfirmar(session.data));
    }
    if (NO_RE.test(tl) || /^2/.test(t)) {
      session.data.pendingUpsell = null;
      session.step = 'CONFIRM_TURNO';
      return send(personal.resumenConfirmar(session.data));
    }
    // Pregunta sobre el upsell
    const srvNombre = u ? (SERVICIOS.findById(u.targetId)?.nombre || 'el complemento') : 'el complemento';
    return send(await personal.responderLibre(
      `La clienta pregunta sobre "${srvNombre}". Explicá el beneficio brevemente y preguntá si lo suma.`,
      session.historial.slice(-6)
    ));
  }

  // ── CONFIRMACIÓN TURNO ───────────────────────────────────────────────────────
  if (session.step === 'CONFIRM_TURNO') {
    // Servicio de color → consulta previa antes de confirmar
    if (session.data.servicio?.consulta && !session.data.consultaOk) {
      session.step = 'COLOR_CONSULTA_TIPO';
      const nombre = session.data.nombre?.split(' ')[0] || '';
      return send(`${nombre ? nombre + ', a' : 'A'}ntes de agendar el *${session.data.servicio.nombre}* necesito hacerte unas preguntas rápidas 💛\n\n¿Tenés tinturas, decoloraciones, alisados o algún proceso químico en el pelo actualmente?\n\n1 — No, pelo natural\n2 — Sí, tengo algo`);
    }
    if (SI_RE.test(tl)) return await _crearTurno(session, phone, clientCtx, send);
    if (NO_RE.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Perfecto, no reservé nada! 😊 Cuando quieras, acá estoy 💛'); }
    return send(personal.resumenConfirmar(session.data));
  }

  // ── EMAIL POST-CONFIRMACIÓN ──────────────────────────────────────────────────
  if (session.step === 'PEDIR_EMAIL') {
    const em = extractEmail(t);
    if (em) {
      session.data.email = em;
      await clientUpsert(phone, session.data.nombre || null, em).catch(() => {});
      // Actualizar booking con email
      const { getDB } = require('../core/db');
      const db = getDB();
      if (db && session.lastBooking?.code) {
        await db.query('UPDATE bookings SET email=$1 WHERE booking_code=$2', [em, session.lastBooking.code]).catch(() => {});
      }
      // Mandar email de confirmación
      const { addGuestToCalendarEvent } = require('../core/calendar');
      const { mailTurnoConfirmado } = require('./mailer');
      if (session.lastCalendarEventId) await addGuestToCalendarEvent(session.lastCalendarEventId, em).catch(() => {});
      const b = session.lastBooking;
      if (b && !b.senaRequired) {
        mailTurnoConfirmado({ to: em, nombre: b.nombre, servicio: b.servicio, fecha: b.fecha, hora: b.hora, code: b.code, calendarLink: b.calLink, monto: b.monto, senaAmount: null }).catch(() => {});
      }
      session.step = 'PEDIR_APELLIDO';
      return send(`✅ ¡Confirmación enviada a *${em}*! 📧\n\n¿Me decís tu apellido para sumarte al programa de beneficios? 💛\n_(o *no* para saltear)_`);
    }
    if (/^no\b/i.test(tl) || /^-$/.test(t)) {
      session.data.emailSkipped = true;
      session.step = 'PEDIR_APELLIDO';
      return send('¡Sin problema! 😊 ¿Me decís tu apellido para el programa de beneficios?\n_(o *no* para saltear)_');
    }
    return send('Escribí tu *email* o *no* para saltear 📧');
  }

  // ── APELLIDO ──────────────────────────────────────────────────────────────────
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

  // ── PROMO OPT-IN ──────────────────────────────────────────────────────────────
  if (session.step === 'PEDIR_PROMO') {
    const si = SI_RE.test(tl) || /^1/.test(t);
    const no = NO_RE.test(tl) || /^2/.test(t);
    if (si || no) {
      await clientUpdateProfile(phone, { lastName: session.data.apellido || null, email: session.data.email || null, promoOptIn: si, profileComplete: !!(session.data.apellido && session.data.email) });
      syncClientesToSheet().catch(() => {});
      session.step = 'LIBRE'; session.data = {};
      return send(si ? '¡Genial! Ya estás en el programa 🎉 Te avisamos de todo 💛' : '¡Perfecto! Te esperamos 💛');
    }
    return send('Respondé *1* para sí o *2* para no 😊');
  }

  // ── CONSULTA COLOR ────────────────────────────────────────────────────────────
  if (session.step === 'COLOR_CONSULTA_TIPO') {
    const noPrevios = /^(1|no\b|nop|natural|virgen|ninguno)/i.test(tl);
    session.data.consultaProcesos = noPrevios ? 'Sin procesos previos' : t;
    session.data.consultaTieneAlistado = /alisado|keratina|botox/i.test(tl);
    if (noPrevios) {
      session.step = 'COLOR_DETALLE_COLOR';
      return send('¡Genial, pelo natural es ideal para trabajar! 💛\n\n¿Cuál sería el resultado que buscás?\n_Ej: "rubia natural", "mechitas caramelo", "castaño oscuro"..._');
    }
    session.step = 'COLOR_DETALLE_PROCESO';
    return send('¿Qué tipo de proceso tenés actualmente?\n\n1 — Tintura (color/raíz)\n2 — Decoloración o mechitas\n3 — Alisado / Keratina\n4 — Varios / no estoy segura');
  }

  if (session.step === 'COLOR_DETALLE_PROCESO') {
    session.data.consultaProcesos = t;
    session.data.consultaTieneAlistado = /alisado|keratina|botox|3/i.test(tl);
    session.step = 'COLOR_DETALLE_COLOR';
    return send('¿Y cuál es el resultado que buscás?\n_Ej: "rubia platinada", "mechitas caramelo sobre castaño"..._');
  }

  if (session.step === 'COLOR_DETALLE_COLOR') {
    session.data.consultaColorDeseado = t;
    session.step = 'COLOR_PEDIR_NOMBRE';
    if (session.data.nombre) {
      session.step = 'COLOR_PEDIR_FOTOS';
      return send('¡Perfecto! 💛\n\n📸 *Foto 1:* Tu pelo hoy (buena luz, sin filtros)\n📸 *Foto 2:* Una referencia del resultado buscado\n\nEstas fotos van directo al equipo y te contactamos con todo listo 💛');
    }
    return send('¡Perfecto! 💛 ¿Me decís tu nombre para que el equipo pueda contactarte? 😊');
  }

  if (session.step === 'COLOR_PEDIR_NOMBRE') {
    session.data.nombre = /^(no|nop|paso|-)$/i.test(tl) ? '' : t.trim();
    session.step = 'COLOR_PEDIR_FOTOS';
    const saludo = session.data.nombre ? `¡Gracias, ${session.data.nombre.split(' ')[0]}! ` : '¡Gracias! ';
    return send(`${saludo}💛\n\n📸 *Foto 1:* Tu pelo hoy (buena luz)\n📸 *Foto 2:* Referencia del resultado buscado\n\nEstas fotos van directo al equipo 💛`);
  }

  if (session.step === 'COLOR_PEDIR_FOTOS') {
    await _guardarConsultaColor(session, phone);
    session.step = 'LIBRE'; session.data = {};
    return send('¡Perfecto! 💛 En cuanto el equipo revise las fotos te contactamos con fecha, hora y todos los detalles. Normalmente respondemos dentro de las 24hs. ¡Gracias! 🌟');
  }

  // ── BUSCAR TURNO ──────────────────────────────────────────────────────────────
  if (session.step === 'BUSCANDO_TURNO') {
    const found = await booking.findBooking(t, phone);
    if (found) { session.data.booking = found; session.step = 'OPCION_TURNO'; return send(personal.turnoEncontrado(found)); }
    return send('No encontré ningún turno 😅 Ingresá tu *código* (ej: #AB12) o tu *nombre completo*:');
  }

  if (session.step === 'OPCION_TURNO') {
    const n = parseInt(tl);
    const b = session.data.booking;
    if (n === 1 || /cambiar|reprograma/i.test(tl)) { session.step = 'REPROGRAM_DATOS'; return send('¿A qué *día y hora* querés cambiar?\n_Ej: "el viernes a las 15"_ 📅'); }
    if (n === 2 || /cancelar/i.test(tl)) {
      session.step = 'CONFIRM_CANCELAR';
      return send(`⚠️ ¿Confirmás que querés *cancelar* este turno?\n\n✂️ ${b?.servicio}\n📅 ${b?.fecha} · ⏰ ${b?.hora}\n\n*sí* / *no*`);
    }
    session.step = 'LIBRE'; session.data = {};
    return send('¡Listo! ¿En qué más te puedo ayudar? 💛');
  }

  if (session.step === 'REPROGRAM_DATOS') {
    const { dia, hora } = detectarDiaHora(tl);
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

  if (session.step === 'CONFIRM_CANCELAR') {
    if (SI_RE.test(tl)) return await _cancelarTurno(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cancelé nada 😊 ¿Puedo ayudarte con algo más?');
  }

  if (session.step === 'CONFIRM_REPROGRAM') {
    if (SI_RE.test(tl)) return await _reprogramarTurno(session, phone, send);
    session.step = 'LIBRE';
    return send('Perfecto, no cambié nada 😊');
  }

  // ── LOYALTY ───────────────────────────────────────────────────────────────────
  if (/puntos|beneficio|canje|mis puntos/i.test(tl)) {
    const result = await loyalty.showBalance(phone);
    if (result.available?.length > 0) {
      session.data.availableRewards = result.available;
      session.step = 'LOYALTY_CANJE';
      return send(result.msg + '\n\n_Respondé con el número para canjear, o *no* para volver_ 💛');
    }
    return send(result.msg);
  }

  if (session.step === 'LOYALTY_CANJE') {
    const n = parseInt(tl);
    if (n > 0 && session.data.availableRewards?.[n - 1]) {
      const result = await loyalty.redeem(phone, session.data.availableRewards[n - 1].id);
      session.step = 'LIBRE'; session.data = {};
      return send(result.msg);
    }
    if (NO_RE.test(tl)) { session.step = 'LIBRE'; session.data = {}; return send('¡Cuando quieras! 💛'); }
  }

  // ── ALISADO/KERATINA ──────────────────────────────────────────────────────────
  if (/alisado|keratina|botox capilar|nanoplastia|progressiva|formol/i.test(tl)) {
    return await _derivarAlistado(session, phone, send);
  }

  // ── FALLBACK — Sonnet responde libremente ────────────────────────────────────
  memory.update(phone, clientCtx?.client, t).catch(() => {});
  return send(await personal.responderLibre(t, session.historial.slice(-10), profile?.toPromptContext?.() || ''));
}

// ── _iniciarReserva ───────────────────────────────────────────────────────────
async function _iniciarReserva(session, phone, profile, send) {
  session.step = 'RESERVANDO';
  session.data = {
    nombre:           profile?.firstName || null,
    email:            profile?.email     || null,
    emailPreguntado:  !!profile?.email,
    nombrePreguntado: !!profile?.firstName,
    upsellOfrecido:   false,
  };
  return send(await personal.iniciarReserva(profile, session.historial.slice(-4)));
}

// ── avanzarReserva ────────────────────────────────────────────────────────────
async function avanzarReserva(session, phone, profile, clientCtx, send) {
  const d = session.data;
  const h = session.historial.slice(-6);

  // Promover extra con consulta a principal
  if (!d.servicio?.consulta && d.extra?.consulta) {
    [d.servicio, d.extra] = [d.extra, d.servicio];
    d.consultaOk = false;
  }

  // Servicio de color → consulta previa
  if (d.servicio?.consulta && !d.consultaOk) {
    session.step = 'COLOR_CONSULTA_TIPO';
    const nombre = d.nombre?.split(' ')[0] || '';
    return send(`${nombre ? nombre + ', a' : 'A'}ntes de agendar el *${d.servicio.nombre}* necesito hacerte unas preguntas rápidas 💛\n\n¿Tenés tinturas, decoloraciones, alisados o algún proceso químico en el pelo?\n\n1 — No, pelo natural\n2 — Sí, tengo algo`);
  }

  // Sin servicio → preguntar
  if (!d.servicio) {
    return send(await personal.iniciarReserva(profile, h));
  }

  // Celebrar servicio (solo una vez)
  if (!d._servicioFestejado) {
    d._servicioFestejado = true;
    // Si ya tiene día en el mismo mensaje, pasar directo
    if (!d.dia) {
      return send(await personal.celebrarServicioYPedirDia(d.servicio, d.extra, profile, h));
    }
  }

  if (!d.dia) return send(await personal.celebrarServicioYPedirDia(d.servicio, d.extra, profile, h));
  if (!d.hora) return send(await personal.pedirHora(d.dia, d.servicio, profile, h));

  // Nombre
  if (!d.nombre) {
    d._esperandoNombre = true;
    return send(await personal.pedirNombre(d.servicio, d.dia, d.hora, h));
  }

  // Email
  if (!d.emailPreguntado) {
    const clientEmail = clientCtx?.client?.email;
    if (clientEmail) {
      d.email = clientEmail;
      d.emailPreguntado = true;
    } else {
      d.emailPreguntado = true;
      session.step = 'RESERVANDO'; // permanece en reservando hasta que avanzarReserva siga
      // Pedimos email dentro del flujo reserva (antes de confirmar)
      return send(await personal.pedirEmail(d.nombre, h));
    }
  }

  // Capturar email si el paso anterior lo pidió
  if (d._esperandoEmail) {
    const em = extractEmail(session.historial[session.historial.length - 2]?.content || '');
    if (em) { d.email = em; await clientUpsert(phone, d.nombre, em).catch(() => {}); }
    d._esperandoEmail = false;
  }

  // Upsell personalizado
  if (!d.upsellOfrecido) {
    const upsell = getPersonalizedUpsell(d.servicio.id, clientCtx?.recentBookings || []);
    if (upsell) {
      d.pendingUpsell  = upsell;
      d.upsellOfrecido = true;
      session.step = 'UPSELL';
      const srvUpsell = SERVICIOS.findById(upsell.targetId);
      if (srvUpsell) return send(await personal.ofrecerUpsell(d.servicio, srvUpsell, h));
    }
    d.upsellOfrecido = true;
  }

  // Todo completo → mostrar resumen
  session.step = 'CONFIRM_TURNO';
  return send(personal.resumenConfirmar(d));
}

// ── _crearTurno ───────────────────────────────────────────────────────────────
async function _crearTurno(session, phone, clientCtx, send) {
  try {
    const d = session.data;
    const result = await booking.create({
      sessionId: session.id, nombre: d.nombre || '', phone,
      servicio: d.servicio, extra: d.extra || null,
      dia: d.dia, hora: d.hora,
      email: d.email || clientCtx?.client?.email || null,
    });

    const { formatFecha } = require('../core/utils');
    const fechaDisplay = await formatFecha(result.fechaReal);
    const srvDisplay   = d.servicio.nombre + (d.extra ? ' + ' + d.extra.nombre : '');

    session.lastCalendarEventId = result.calendarEventId;
    session.lastBooking = {
      nombre: d.nombre, servicio: srvDisplay,
      fecha: result.fechaReal, hora: result.horaReal,
      code: result.code, calLink: result.calLink, monto: result.monto,
      senaRequired: d.servicio?.seña && result.senaAmount > 0,
    };

    const ptsEarned = result.pointsEarned || 0;

    // Seña requerida
    if (d.servicio?.seña && result.senaAmount > 0) {
      const montoSena = result.senaAmount.toLocaleString('es-AR');
      const msg = personal.senaRequerida(d.nombre, srvDisplay, fechaDisplay, result.horaReal, result.code, montoSena, result.mpLink || null);
      session.step = 'PEDIR_APELLIDO';
      return send(msg + (ptsEarned > 0 ? `\n\n⭐ Ganaste *+${ptsEarned} puntos*` : '') + `\n\n¿Me decís tu apellido para el programa de beneficios? 💛 _(o *no* para saltear)_`);
    }

    // Turno confirmado sin seña
    const confirmMsg = personal.turnoConfirmado(d.nombre, srvDisplay, fechaDisplay, result.horaReal, result.code, ptsEarned);

    // Si ya tiene email → mandar confirmación inmediatamente
    const email = d.email || clientCtx?.client?.email;
    if (email && !d.emailSkipped) {
      const { addGuestToCalendarEvent } = require('../core/calendar');
      const { mailTurnoConfirmado } = require('./mailer');
      await addGuestToCalendarEvent(result.calendarEventId, email).catch(() => {});
      mailTurnoConfirmado({ to: email, nombre: d.nombre, servicio: srvDisplay, fecha: result.fechaReal, hora: result.horaReal, code: result.code, calendarLink: result.calLink, monto: result.monto, senaAmount: null }).catch(() => {});
      session.step = 'PEDIR_APELLIDO';
      return send(confirmMsg + `\n\n✉️ Confirmación enviada a *${email}* 💌\n\n¿Me decís tu apellido para el programa de beneficios? 💛 _(o *no* para saltear)_`);
    }

    // No tiene email → pedirlo
    session.step = 'PEDIR_EMAIL';
    return send(confirmMsg + '\n\n' + await personal.pedirEmail(d.nombre, session.historial.slice(-4)));

  } catch (e) {
    console.error('[orch] Error creando turno:', e.message);
    session.step = 'LIBRE';
    return send('Ups, tuve un problema técnico 😅 Intentá de nuevo o escribí "hablar con alguien".');
  }
}

// ── _cancelarTurno / _reprogramarTurno ────────────────────────────────────────
async function _cancelarTurno(session, phone, send) {
  try {
    const cl = await clientGet(phone);
    await booking.cancel({ bookingData: session.data.booking, phone, email: cl?.email });
    session.step = 'LIBRE'; session.data = {};
    return send('✅ Turno *cancelado* 💛\n\nCuando quieras reservar de nuevo, acá estamos.');
  } catch (e) {
    console.error('[orch] Error cancelando:', e.message);
    session.step = 'LIBRE';
    return send('Hubo un problema técnico 😅 Escribí "hablar con alguien".');
  }
}

async function _reprogramarTurno(session, phone, send) {
  try {
    const cl = await clientGet(phone);
    const result = await booking.reschedule({ bookingData: session.data.booking, newDia: session.data.newDia, newHora: session.data.newHora, phone, email: cl?.email, sessionId: session.id });
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

// ── _derivarAlistado ──────────────────────────────────────────────────────────
async function _derivarAlistado(session, phone, send) {
  _notificarStaff(phone, session.profile?.nombre, 'Consulta alisado/keratina', 'DERIVACION');
  session.step = 'LIBRE';
  return send(
    '¡Buena consulta! 💛 En el salón trabajamos sin formol ni químicos agresivos, pero tenemos opciones que dan resultados increíbles:\n\n' +
    '✨ *Head Spa completo* — hidrata, suaviza y da brillo real desde la raíz ($120.000)\n' +
    '🌿 *Ozono capilar* — revitaliza y mejora la textura de forma progresiva ($30.000)\n' +
    '💧 *Ampolla reparadora* — nutrición intensiva para cabello con frizz ($30.000)\n\n' +
    'Para la combinación perfecta según tu tipo de pelo, ¿querés que te escriba alguien del equipo?'
  );
}

// ── _guardarConsultaColor ─────────────────────────────────────────────────────
async function _guardarConsultaColor(session, phone) {
  const d = session.data;
  const alistado = d.consultaTieneAlistado ? ' ⚠️ Tiene alisado/keratina' : '';
  const notes    = `Procesos: ${d.consultaProcesos || 'sin procesos previos'}${alistado} | Resultado: ${d.consultaColorDeseado || 'no especificado'} | Contacto: ${d.email || d.telefono || 'no dejó'}`;
  try {
    const db = require('../core/db');
    await db.bookingSave({ sessionId: session.id, nombre: d.nombre || '', phone, servicio: d.servicio?.nombre || 'Color', fecha: '', hora: '', monto: d.servicio?.precio || 0, senaPaid: false, calendarEventId: null, email: d.email || null, notes, status: 'Consulta Pendiente' }).catch(() => {});
  } catch {}
  _notificarStaff(phone, d.nombre, `Color: ${d.servicio?.nombre} | ${notes}`, 'COLOR');
}

// ── Notificaciones staff ──────────────────────────────────────────────────────
function _notificarStaff(phone, nombre, info, tipo) {
  const STAFF_WA   = process.env.STAFF_WHATSAPP_PHONE;
  const WASS_TOKEN = process.env.WASSENGER_TOKEN || process.env.WASSENGER_API_KEY;
  if (!STAFF_WA || !WASS_TOKEN) return;
  const axios = require('axios');
  const ICONOS = { COLOR: '🎨', DERIVACION: '💬', DEFAULT: '📋' };
  const icono  = ICONOS[tipo] || ICONOS.DEFAULT;
  const msg = `${icono} *${tipo === 'COLOR' ? 'CONSULTA COLOR' : 'DERIVACIÓN'}*\n\n👤 ${nombre||'Sin nombre'} · 📱 ${phone}\n${info}\n\nhttps://peluqueria-bot.onrender.com/staff`;
  axios.post('https://api.wassenger.com/v1/messages', { phone: STAFF_WA, message: msg }, { headers: { Token: WASS_TOKEN }, timeout: 8000 }).catch(() => {});
}

module.exports = { handle };