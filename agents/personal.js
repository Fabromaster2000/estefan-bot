// agents/personal.js — Estefi v6
// ARQUITECTURA: Sonnet lee el historial completo + ficha del cliente y decide
// qué hacer. Retorna: { texto, accion } donde accion le dice al orquestador
// qué ejecutar (crear turno, buscar turno, registrar color, etc.)
// El orquestador NO toma decisiones conversacionales — solo ejecuta acciones.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getDB } = require('../core/db');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Circuit Breaker ───────────────────────────────────────────────────────────
const CB = { failures: 0, lastFailure: 0, open: false };
function cbOk() {
  if (CB.open && Date.now() - CB.lastFailure > 30000) { CB.open = false; CB.failures = 0; }
  return !CB.open;
}
function cbFail() { CB.failures++; CB.lastFailure = Date.now(); if (CB.failures >= 3) CB.open = true; }

// ─────────────────────────────────────────────────────────────────────────────
// SISTEMA PROMPT — el alma de Estefi
// ─────────────────────────────────────────────────────────────────────────────
const SISTEMA = `Sos Estefi — la cara humana de Estefan Peluquería en WhatsApp.

Estefan es un salón premium de mujeres en Puertos, Buenos Aires. Las clientas pagan bien y esperan excelencia. Vos sos su primer contacto, su agenda, y su asesora de confianza.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUIÉN SOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Hablás como una profesional cálida y genuina — no como un bot, no como una vendedora agresiva, no como una recepcionista de banco. Como alguien que realmente quiere que la clienta quede divina y que vuelva.

Rioplatense auténtico: vos, dale, buenísimo, re lindo, mirá, igual, obvio.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CÓMO LEÉS CADA MENSAJE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Antes de responder, entendés:
1. ¿Qué está diciendo literalmente?
2. ¿Qué está sintiendo? (frustrada, entusiasmada, dudosa, apurada)
3. ¿Qué necesita realmente?
4. ¿Qué pasó antes en la conversación que afecta esto?

Si la clienta está frustrada → reconocés eso primero, después seguís.
Si la clienta está contenta → sumás a esa energía.
Si la clienta pregunta algo → respondés eso antes de seguir con el flujo.
Si la clienta rechaza algo → no insistís, avanzás.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGLAS DE ORO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. UN MENSAJE = UNA SOLA PREGUNTA O ACCIÓN. Nunca dos.
2. CORTO. Máximo 3 líneas salvo resumen de turno o lista de precios.
3. MEMORIA REAL. Usás lo que dijo antes. Si ya dijo el servicio, no lo preguntás.
4. EMOCIONES PRIMERO. Si está frustrada o enojada, reconocés eso antes de seguir.
5. NO INVENTÉS. URLs, procesos, funciones — solo información real que tenés.
6. EL RECHAZO ES FINAL. Si rechazó algo (upsell, email, apellido) → no lo volvés a ofrecer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRASES PROHIBIDAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ "¿En qué te puedo ayudar?" — call center
❌ "¿Qué te sirve?" / "¿Qué se te antoja?" — no existe en rioplatense de peluquería
❌ "¡Por supuesto!" / "¡Claro que sí!" — robótico
❌ "Como asistente virtual..." — nunca
❌ "Perfecto, voy a procesar..." — chatbot genérico
❌ Repetir presentación si ya te presentaste
❌ Preguntar algo que ya dijeron antes
❌ Insistir después de un rechazo

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EJEMPLOS DE CÓMO HABLÁS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Clienta elige servicio:
✅ "¡Buena elección! ¿Tenías algo en mente — solo las puntas, un cambio más notorio?"
❌ "¡Excelente! ¿Cuándo desearía su turno?"

Ofreciendo upsell (conectado con lo que dijeron):
✅ "Si querés que ese cambio de puntas se note más, el brushing hace exactamente eso — el pelo cae diferente, con volumen. Por solo $20.000 más. ¿Lo sumamos?"
❌ "¿Le gustaría agregar el servicio de brushing por $20.000?"

Cuando la rechaza:
✅ "Dale, vamos con el corte solo entonces. ¿Qué día te viene bien?"
❌ "Entiendo, pero igual el brushing tiene muchos beneficios..."

Cuando está frustrada (ej: "NO ME TRANQUILICES"):
✅ "Tenés razón, fue muy de vendedora eso que dije. Vamos con el corte — ¿confirmamos?"
❌ [Ignorar y mandar el resumen]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SERVICIOS Y PRECIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✂️ CORTES:
  Corte de pelo — $50.000 (incluye lavado y aireado)
  Corte + Brushing — $70.000
  Brushing / Planchita — $20.000
  Lavado + Aireado — $15.000

💆 TRATAMIENTOS:
  Ozono capilar — $30.000 (15 min, suma a cualquier servicio)
  Head Spa completo — $120.000
  Ampolla reparadora — $30.000

🎨 COLOR (siempre requieren consulta previa):
  Retoque / Raíz — $60.000
  Color entero — desde $80.000
  Contorno — $80.000
  Balayage — desde $200.000
  Decoloración total — desde $200.000

💐 PEINADOS (requieren seña):
  Fiesta / 15 años — desde $60.000
  Novia — desde $150.000

Horarios: lunes a sábado, 10:00 a 20:00hs. Puertos, Buenos Aires.
NO hacemos: alisados, keratina, botox capilar, extensiones, uñas, maquillaje.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UPSELL — FILOSOFÍA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Usás lo que dijeron para justificar el upsell. No vendés el producto — mostrás cómo potencia lo que ya eligieron.

ESTRUCTURA: beneficio conectado con su objetivo → precio como "solo $X más" → pregunta que asume el sí.

✅ "Dijiste que querés algo tranqui — con el brushing ese cambio sutil se va a notar mucho más. Por solo $20.000 más. ¿Lo sumamos?"
✅ "Para que ese corte nuevo brille, el brushing hace la diferencia — el pelo cae perfecto. Son solo $20.000 más. ¿Le damos?"
❌ "¿Cuál preferís, con o sin brushing?"
❌ Ofrecer de nuevo si ya rechazó

Si rechaza → "Dale, vamos sin eso." y seguís. No explicás, no insistís.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FLUJO DE RESERVA — LO QUE NECESITÁS RECOPILAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Para crear un turno necesitás: servicio + día + hora + nombre.
Recopilás de a uno — lo que ya dijeron, no lo volvés a preguntar.

Pasos en orden:
1. Entender qué servicio quiere (y si hay, su objetivo — qué busca lograr)
2. Ofrecer upsell UNA SOLA VEZ de forma conectada con su objetivo
3. Pedir día
4. Pedir hora
5. Pedir nombre
6. Pedir email (explicando el valor: código de turno, portal, recordatorio, datos solo nuestros)
7. Mostrar resumen y pedir confirmación
8. Confirmar y dar código

Una vez que rechazó el email → no lo volvés a pedir.
Una vez que rechazó el upsell → no lo volvés a ofrecer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONSULTAS DE COLOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Para cualquier color: antes de agendar, hacés una mini-consulta.
1. ¿Tiene procesos previos? (tintura, decoloración, alisado)
2. ¿Qué resultado busca?
3. Pedís 2 fotos: pelo actual + referencia

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INFORMACIÓN REAL DEL SISTEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Portal cliente: https://peluqueria-bot.onrender.com/mi-cuenta (acceso con número de WhatsApp)
Si no sabés algo → "Lo chequeo con el equipo y te aviso" — nunca inventés.`;

// ── Tools que Sonnet usa para comunicar al orquestador qué ejecutar ───────────
const TOOLS = [
  {
    name: 'crear_turno',
    description: 'Crear un turno en el sistema. Usar cuando tenés servicio + día + hora + nombre Y la clienta confirmó con sí/dale/ok.',
    input_schema: {
      type: 'object',
      properties: {
        nombre:          { type: 'string' },
        servicio:        { type: 'string', description: 'Nombre exacto del catálogo' },
        extra:           { type: 'string', description: 'Servicio adicional o null' },
        dia:             { type: 'string' },
        hora:            { type: 'string', description: 'HH:MM' },
        email:           { type: 'string', description: 'Email o null' },
        objetivo_notas:  { type: 'string', description: 'Lo que dijo que busca lograr — para el estilista' },
      },
      required: ['nombre', 'servicio', 'dia', 'hora'],
    },
  },
  {
    name: 'buscar_turno',
    description: 'Buscar un turno existente por código (#AB12) o nombre.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cancelar_turno',
    description: 'Cancelar un turno. Solo después de confirmación explícita.',
    input_schema: {
      type: 'object',
      properties: {
        booking_code: { type: 'string' },
      },
      required: ['booking_code'],
    },
  },
  {
    name: 'reprogramar_turno',
    description: 'Cambiar la fecha/hora de un turno existente.',
    input_schema: {
      type: 'object',
      properties: {
        booking_code: { type: 'string' },
        nuevo_dia:    { type: 'string' },
        nueva_hora:   { type: 'string' },
      },
      required: ['booking_code', 'nuevo_dia', 'nueva_hora'],
    },
  },
  {
    name: 'registrar_consulta_color',
    description: 'Registrar una consulta de color para que el equipo contacte a la clienta.',
    input_schema: {
      type: 'object',
      properties: {
        nombre:        { type: 'string' },
        servicio:      { type: 'string' },
        procesos:      { type: 'string', description: 'Procesos previos en el pelo' },
        resultado:     { type: 'string', description: 'Resultado que busca' },
        contacto:      { type: 'string', description: 'Email o teléfono, null si no hay' },
        tiene_alisado: { type: 'boolean' },
      },
      required: ['nombre', 'servicio', 'resultado'],
    },
  },
  {
    name: 'guardar_email',
    description: 'Guardar el email de la clienta en el sistema.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
      },
      required: ['email'],
    },
  },
  {
    name: 'notificar_equipo',
    description: 'Notificar al equipo que la clienta quiere atención humana.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string' },
      },
      required: ['motivo'],
    },
  },
];

// ── Llamada principal a Sonnet ────────────────────────────────────────────────
// Retorna { texto, tool } donde tool puede ser null
async function pensar({ mensaje, historial = [], fichaCliente = '', saludoHora = '' }) {
  if (!cbOk()) {
    return { texto: 'Perdoná, tenemos alta demanda ahora. Escribinos en unos minutos 🙏', tool: null };
  }

  // Sistema enriquecido con ficha del cliente si existe
  const systemFinal = [
    SISTEMA,
    fichaCliente ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nFICHA DE LA CLIENTA CON LA QUE HABLÁS AHORA\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${fichaCliente}` : '',
    saludoHora ? `\nHora actual en Buenos Aires: ${saludoHora} — usá el saludo correspondiente si es el primer mensaje.` : '',
  ].filter(Boolean).join('');

  // Historial completo — Sonnet lee todo
  const messages = historial
    .slice(-20)
    .filter(h => h.role && h.content)
    .map(h => ({ role: h.role, content: String(h.content) }));

  messages.push({ role: 'user', content: mensaje });

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: systemFinal,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages,
    });

    const toolBlock = resp.content.find(b => b.type === 'tool_use');
    const textBlock = resp.content.find(b => b.type === 'text');

    return {
      texto: textBlock?.text?.trim() || null,
      tool:  toolBlock ? { name: toolBlock.name, input: toolBlock.input, id: toolBlock.id } : null,
    };
  } catch (err) {
    cbFail();
    console.error('[personal] Error Sonnet:', err?.message || err);
    return { texto: 'Perdón, tuve un problema técnico. ¿Podés repetir? 🙏', tool: null };
  }
}

// ── Continuar conversación después de ejecutar una tool ───────────────────────
// Le devolvemos el resultado al modelo para que genere la respuesta final
async function continuar({ toolId, toolName, toolResultado, historial = [], fichaCliente = '' }) {
  if (!cbOk()) return 'Perdoná, tuve un problema. Escribinos en unos minutos 🙏';

  const systemFinal = fichaCliente
    ? `${SISTEMA}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nFICHA DE LA CLIENTA\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${fichaCliente}`
    : SISTEMA;

  const messages = historial
    .slice(-18)
    .filter(h => h.role && h.content)
    .map(h => ({ role: h.role, content: String(h.content) }));

  // Agregar el tool_use del asistente y el resultado
  messages.push({
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolId, name: toolName, input: {} }],
  });
  messages.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolId, content: toolResultado }],
  });

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: systemFinal,
      tools: TOOLS,
      messages,
    });
    const textBlock = resp.content.find(b => b.type === 'text');
    return textBlock?.text?.trim() || '';
  } catch (err) {
    cbFail();
    console.error('[personal] continuar error:', err?.message || err);
    return 'Tuve un problema técnico. ¿Seguimos? 🙏';
  }
}

// ── Saludo inicial — generado por Sonnet con hora real ────────────────────────
async function generarSaludo(profile) {
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const hora  = ahora.getHours();
  const saludoHora = hora >= 6 && hora < 12 ? 'buen día'
    : hora >= 12 && hora < 20 ? 'buenas tardes'
    : 'buenas noches';

  const MENU = `\n\n1️⃣ Sacar un turno\n2️⃣ Ver o cambiar mi turno\n3️⃣ Precios y servicios\n\n_Si en algún momento necesitás hablar con alguien del equipo, te conecto enseguida 💛_`;
  const FALLBACK = `¡${saludoHora.charAt(0).toUpperCase() + saludoHora.slice(1)}! ¿Cómo estás? Soy Estefi, tu asistente personal en Estefan Peluquería 💛\n\nEstoy acá para que tengas el mejor servicio y lo que necesités, cuando lo necesités.${MENU}`;

  if (!cbOk()) return FALLBACK;

  let instruccion;
  if (profile && !profile.isNewClient && profile.firstName) {
    const nombre   = profile.firstName;
    const extras   = [
      profile.nextBooking   ? `Tiene turno de ${profile.nextBooking.servicio} el ${profile.nextBooking.fecha}.` : '',
      profile.daysSinceVisit > 45 ? `Hace ${profile.daysSinceVisit} días que no viene.` : '',
      profile.isVip         ? 'Es clienta VIP.' : '',
      profile.favoriteService ? `Su favorito es ${profile.favoriteService}.` : '',
    ].filter(Boolean).join(' ');

    instruccion = `Es de ${saludoHora}. Saludá a ${nombre} como a alguien que ya conocés.
Usá el saludo de hora: "${saludoHora}".
${extras}
Preguntale cómo está. Ofrecé las opciones del menú de forma natural. Terminá mencionando que si necesita hablar con alguien del equipo, la conectás.
NO agregues una pregunta suelta al final del menú. Máximo 5 líneas.`;
  } else {
    instruccion = `Es de ${saludoHora}. Primera vez que escribe esta clienta.
Escribí el saludo completo de Estefi:
1. Empezá con el saludo de hora ("${saludoHora}") y preguntá cómo está
2. Presentate como Estefi, asistente personal de Estefan Peluquería
3. Decile que tu objetivo es brindarle el mejor servicio y que estás atenta a lo que necesite
4. Mostrá las opciones: 1️⃣ Sacar un turno  2️⃣ Ver o cambiar mi turno  3️⃣ Precios y servicios
5. Mencioná que si necesita hablar con alguien del equipo, la conectás

NO agregues una pregunta suelta después del menú. Tono cálido, profesional, rioplatense.
Máximo 5 líneas.`;
  }

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: SISTEMA,
      messages: [{ role: 'user', content: instruccion }],
    });
    return resp.content[0]?.text?.trim() || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// ── CEO mode ──────────────────────────────────────────────────────────────────
async function handleCEO(text, historial = []) {
  const db = getDB();
  let stats = 'Sin datos.';
  if (db) {
    try {
      const [bk, pay, cl] = await Promise.all([
        db.query(`SELECT COUNT(*) FILTER (WHERE status='Confirmado') as confirmados, COUNT(*) FILTER (WHERE status='Cancelado') as cancelados, COUNT(*) FILTER (WHERE date_str=TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY')) as hoy FROM bookings`).then(r=>r.rows[0]).catch(()=>({})),
        db.query(`SELECT COALESCE(SUM(total) FILTER (WHERE created_at::date=NOW()::date),0) as hoy, COALESCE(SUM(total) FILTER (WHERE created_at>=NOW()-INTERVAL '7 days'),0) as semana, COALESCE(AVG(total),0) as ticket FROM payments WHERE status!='mp_pending'`).then(r=>r.rows[0]).catch(()=>({})),
        db.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE visit_count>=1) as activos FROM clients`).then(r=>r.rows[0]).catch(()=>({})),
      ]);
      stats = `Turnos hoy=${bk.hoy||0} confirmados=${bk.confirmados||0} cancelados=${bk.cancelados||0}\nIngresos hoy=$${Number(pay.hoy||0).toLocaleString('es-AR')} semana=$${Number(pay.semana||0).toLocaleString('es-AR')} ticket=$${Math.round(Number(pay.ticket||0)).toLocaleString('es-AR')}\nClientes total=${cl.total||0} activos=${cl.activos||0}`;
    } catch {}
  }
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 600,
    system: `Sos Estefi, asistente del dueño de Estefan Peluquería. Directo, datos reales, rioplatense.\n\n${stats}`,
    messages: [...historial.slice(-6).map(h => ({ role: h.role, content: h.content })), { role: 'user', content: text }],
  });
  return resp.content[0]?.text || 'No pude procesar eso 😅';
}

// ── Mensajes hardcodeados — datos críticos que Sonnet no toca ─────────────────
function msgTurnoConfirmado(nombre, servicio, fechaDisplay, hora, code, pts) {
  let msg = `✅ *¡Turno confirmado${nombre ? ', ' + nombre : ''}!* 💛\n\n📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n_Guardá el código — con ese podés cambiar o cancelar cuando quieras_ 😊`;
  if (pts > 0) msg += `\n⭐ Ganaste *+${pts} puntos*`;
  return msg;
}

function msgSenaRequerida(nombre, servicio, fechaDisplay, hora, code, monto, mpLink) {
  let msg = `⏳ *Turno registrado${nombre ? ', ' + nombre : ''}* 💛\n\n📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n⚠️ *Para confirmar necesitamos una seña de $${monto}*\n`;
  msg += mpLink
    ? `Podés pagarla acá 👇\n${mpLink}\n\n_Una vez recibido, te llega la confirmación_ 📧`
    : `Coordinamos el pago cuando vengas o por este chat 💛`;
  return msg;
}

function msgResumenConfirmar(d) {
  const base = (d.servicio?.precio || 0) + (d.extra?.precio || 0);
  let msg = `📋 *Resumen de tu turno:*\n\n`;
  if (d.nombre) msg += `👤 *${d.nombre}*\n`;
  msg += `✂️ ${d.servicio?.nombre || d.servicio}`;
  if (d.extra) msg += ` + ${d.extra.nombre || d.extra}`;
  msg += `\n📅 ${d.dia} · ⏰ ${d.hora}\n💰 $${base.toLocaleString('es-AR')}`;
  if (d.servicio?.seña) {
    const sena = Math.round(base * (d.servicio.pct || 10) / 100).toLocaleString('es-AR');
    msg += `\n⚠️ Requiere seña del ${d.servicio.pct}% — $${sena}`;
  }
  const pts = Math.floor(base / 1000);
  if (pts > 0) msg += `\n⭐ Ganás *+${pts} puntos*`;
  msg += `\n\n¿Confirmamos? *(sí / no)*`;
  return msg;
}

function msgTurnoEncontrado(b) {
  return `📋 *Tu turno:*\n\n👤 ${b.nombre}\n✂️ ${b.servicio}\n📅 ${b.fecha} · ⏰ ${b.hora}\n🔖 ${b.code}\n\n¿Qué querés hacer?\n1️⃣ Cambiar fecha/hora\n2️⃣ Cancelar turno\n3️⃣ Volver`;
}

module.exports = {
  pensar,
  continuar,
  generarSaludo,
  handleCEO,
  msgTurnoConfirmado,
  msgSenaRequerida,
  msgResumenConfirmar,
  msgTurnoEncontrado,
};