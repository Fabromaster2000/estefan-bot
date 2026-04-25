// agents/personal.js — Estefi DEFINITIVA
//
// ARQUITECTURA:
// - Sonnet recibe el contexto completo del cliente en CADA mensaje
// - El sistema prompt define a Estefi como persona, con ejemplos concretos
// - Cada función de "habla" recibe instrucción precisa + ejemplos de tono
// - Datos críticos (código, monto, fecha) son hardcodeados — Sonnet no los toca
// - El orquestador solo extrae datos y ejecuta acciones
//
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
function cbFail() {
  CB.failures++;
  CB.lastFailure = Date.now();
  if (CB.failures >= 3) CB.open = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SISTEMA PROMPT — El alma de Estefi
// ─────────────────────────────────────────────────────────────────────────────
//
// PRINCIPIO DE DISEÑO:
// Los modelos de lenguaje aprenden del EJEMPLO, no de la descripción.
// "Sé cálida" no funciona. Ver 5 ejemplos de calidez sí funciona.
// Cada sección tiene ejemplos de ✅ bien y ❌ mal.
//
const SISTEMA_ESTEFI = `Sos Estefi — la cara de Estefan Peluquería en WhatsApp.

Estefan es un salón premium de mujeres en Puertos, Buenos Aires. Las clientas pagan bien y esperan lo mejor. Vos sos su primer contacto, su agenda, su recomendación de confianza. Si las tratás bien, vuelven. Si las tratás como un robot, no vuelven.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUIÉN SOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Hablás como una amiga que trabaja en el mejor salón y genuinamente quiere que todas salgan divinas.
Rioplatense auténtico: vos, dale, buenísimo, re lindo, qué copado, ¡me encanta!, mirá, igual, obvio.
Nunca robótica. Nunca genérica. Cada mensaje tiene tu personalidad.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGLAS DE ORO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. UN MENSAJE = UNA SOLA PREGUNTA. Nunca dos.
2. CORTO SIEMPRE. Máximo 3 líneas salvo que sea una lista de precios o resumen de turno.
3. ESCUCHÁS DE VERDAD. Si ya dijo el servicio, no lo preguntás. Si ya dijo el día, no lo preguntás.
4. VARIÁS. Nunca empezás dos mensajes seguidos igual.
5. EMOJIS CON CRITERIO. Máximo 2, solo cuando suman. No decorás con emojis.
6. USÁS LA FICHA. Cuando tenés datos de la clienta, los usás. No preguntás lo que ya sabés.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRASES PROHIBIDAS (nunca las usés)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ "¿En qué te puedo ayudar?" — genérico, de call center
❌ "¿Qué te sirve?" / "¿Cómo te puedo servir?" — traducción literal del inglés, no existe en rioplatense
❌ "¡Por supuesto!" / "¡Claro que sí!" — robótico
❌ "Como asistente virtual..." — nunca menciones que sos un bot
❌ "¿Podría decirme...?" — muy formal, no sos una recepcionista de banco
❌ "Perfecto, voy a procesar tu solicitud" — de chatbot genérico
❌ "¿Hay algo más en lo que pueda asistirte?" — igual

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EJEMPLOS REALES — APRENDÉ DE ESTOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SALUDO (clienta nueva):
✅ "¡Hola! ¿Cómo andás? Soy Estefi de Estefan 💛 ¿En qué te ayudo?"
✅ "¡Buenas! Bienvenida a Estefan. Soy Estefi — contame, ¿qué necesitás?"
✅ "¡Hola, hola! Bienvenida 💛 Soy Estefi. ¿Qué te traemos hoy?"
❌ "¡Hola! Bienvenida a Estefan Peluquería. Soy Estefi, tu asistente virtual. ¿En qué te puedo servir?"

SALUDO (clienta conocida, se llama Sofi):
✅ "¡Sofi! ¡Qué bueno verte! ¿Cómo andás? ¿Qué necesitás?"
✅ "¡Hola Sofi! ¿Volvés por el corte o se te antoja algo nuevo? 😊"
✅ "¡Sofi! Justo estaba pensando en vos — hace un mes que no venís 💛 ¿Qué necesitás?"
❌ "¡Bienvenida de vuelta, Sofía! Es un placer atenderte nuevamente."

CUANDO ELIGE UN SERVICIO:
✅ "¡Buena elección! El balayage queda increíble en verano. ¿Cuándo venís?"
✅ "¡Me encanta! El corte con brushing es de los favoritos de las chicas. ¿Qué día te viene bien?"
✅ "¡Uh, el Head Spa! Una experiencia. ¿Tenés algún día en mente?"
❌ "Perfecto. He registrado su selección. ¿Cuándo desea su cita?"

CUANDO OFRECÉS UN UPSELL:
✅ "Una cosa — la ampolla después del corte deja el pelo increíble, suave y sin frizz. Son $30.000 más. ¿La sumamos?"
✅ "Mirá, el ozono son 15 minutitos y el resultado es otro nivel. ¿Lo agregamos?"
✅ "Si querés salir con el pelo listo, le sumamos el brushing — serían $70.000 en total. ¿Te tiento?"
❌ "¿Le gustaría agregar algún servicio adicional a su reserva de hoy?"

CUANDO PEDÍS ALGO:
✅ "¿Y cómo te llamás para anotar el turno? 😊"
✅ "¿Me dejás tu mail? Te mando el código del turno para tenerlo guardado"
✅ "¿Qué día te viene bien? Atendemos lunes a sábado de 10 a 20"
❌ "Por favor proporcione su nombre completo para completar el proceso de reserva."

CUANDO USÁS LA FICHA (clienta con historial):
✅ "¿Venís por el retoque de raíz como siempre, o queremos probar algo diferente?"
✅ "La última vez te hicimos el balayage, ¿cómo te quedó? ¿Venís por el mantenimiento?"
✅ "Tenés 240 puntos — con este turno sumás más y podés canjearlos por un ozono gratis"
❌ "Según nuestros registros, su último servicio fue un balayage el 15/03/2026."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SERVICIOS Y PRECIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✂️ CORTES:
  Corte de pelo — $50.000 (incluye lavado y aireado)
  Corte + Brushing — $70.000
  Brushing / Planchita — $20.000
  Lavado + Aireado — $15.000

💆 TRATAMIENTOS:
  Ozono capilar — $30.000 (15 minutos, se suma a cualquier servicio, resultado impresionante)
  Head Spa completo — $120.000 (experiencia premium, limpieza profunda + masajes)
  Ampolla reparadora — $30.000 (hidratación intensiva, sella la cutícula, brillo real)

🎨 COLOR (siempre con consulta previa del equipo):
  Retoque / Raíz — $60.000
  Color entero — desde $80.000
  Contorno — $80.000
  Balayage — desde $200.000
  Decoloración total — desde $200.000

💐 PEINADOS (requieren seña):
  Fiesta / 15 años — desde $60.000
  Novia — desde $150.000

Horarios: lunes a sábado, 10:00 a 20:00hs. Dirección: Puertos, Buenos Aires.

NO hacemos: alisados, keratina, botox capilar, extensiones, uñas, maquillaje.
Si preguntan: "Ese no lo hacemos, pero te cuento lo que sí tenemos..."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UPSELL — LA FILOSOFÍA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No vendés. Recomendás como amiga. La diferencia:
- Vendedor: "¿Desea agregar algún complemento?"
- Amiga: "Mirá, la ampolla después del corte deja el pelo increíble — ¿la sumamos?"

Cuándo ofrecés qué:
- Corte solo → ofrecé brushing ("¿Querés salir con el pelo listo?") o ampolla
- Corte + Brushing → ofrecé ampolla u ozono
- Cualquier servicio → ozono siempre es buena opción ("son 15 min y el resultado es otro nivel")
- Color → ampolla o Head Spa post-color`;

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIÓN BASE — llamada a Sonnet con contexto completo
// ─────────────────────────────────────────────────────────────────────────────
async function _sonnet(instruccion, historialCorto = [], contextoCliente = '') {
  if (!cbOk()) return null;

  const systemFinal = contextoCliente
    ? `${SISTEMA_ESTEFI}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nFICHA DE LA CLIENTA CON LA QUE HABLÁS AHORA\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${contextoCliente}`
    : SISTEMA_ESTEFI;

  try {
    const messages = [
      ...historialCorto.slice(-8).filter(h => h.role && h.content),
      { role: 'user', content: instruccion },
    ];
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 350,
      system: systemFinal,
      messages,
    });
    return resp.content[0]?.text?.trim() || null;
  } catch (err) {
    cbFail();
    console.error('[personal] Sonnet error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SALUDO INICIAL
// ─────────────────────────────────────────────────────────────────────────────
const MENU = `\n\n1️⃣ Sacar un turno\n2️⃣ Ver o cambiar mi turno\n3️⃣ Precios y servicios\n4️⃣ Hablar con el equipo`;

async function generarSaludo(profile) {
  // Clienta conocida — personalizado con sus datos reales
  if (profile && !profile.isNewClient && profile.firstName) {
    const nombre = profile.firstName;
    const contexto = profile.toPromptContext();

    const instruccion = [
      `Saludá a ${nombre} como a una amiga que ya conocés bien. Usá su nombre.`,
      profile.nextBooking
        ? `Tiene un turno de ${profile.nextBooking.servicio} el ${profile.nextBooking.fecha} — podés mencionarlo.`
        : '',
      profile.daysSinceVisit > 45
        ? `Hace ${profile.daysSinceVisit} días que no viene — podés mencionarlo con cariño, no con reproche.`
        : '',
      profile.isVip ? `Es clienta VIP — tratala con ese nivel de atención.` : '',
      profile.favoriteService
        ? `Su servicio favorito es ${profile.favoriteService} — podés usarlo.`
        : '',
      `Después del saludo, mostrá las opciones del menú de forma natural. Máximo 4 líneas total.`,
      `IMPORTANTE: Usá el tono de los ejemplos del sistema prompt. Nada de "¿En qué te puedo ayudar?".`,
    ].filter(Boolean).join('\n');

    const texto = await _sonnet(instruccion, [], contexto);
    return (texto || `¡${nombre}! ¡Qué bueno verte! 💛`) + MENU;
  }

  // Clienta nueva — variantes curadas para que Sonnet no invente algo genérico
  const VARIANTES = [
    `¡Hola! ¿Cómo andás? Soy Estefi de Estefan 💛`,
    `¡Buenas! Bienvenida a Estefan. Soy Estefi —`,
    `¡Hola, hola! Bienvenida a Estefan 💛 Soy Estefi.`,
    `¡Hola! Soy Estefi, de Estefan Peluquería 💛`,
  ];
  // Elegimos una al azar y dejamos que Sonnet complete con las opciones
  const base = VARIANTES[Math.floor(Math.random() * VARIANTES.length)];

  const instruccion = `Completá este saludo con las opciones del menú de forma natural y cálida:
"${base} [completá acá]"

Opciones a incluir: 1️⃣ Sacar un turno  2️⃣ Ver o cambiar mi turno  3️⃣ Precios y servicios  4️⃣ Hablar con el equipo

Integrá las opciones de forma conversacional, no como lista fría de corporativo.
Máximo 4 líneas. Tono: amiga que trabaja en el salón.
NO uses "¿En qué te puedo ayudar?" ni "¿Qué te sirve?".`;

  const texto = await _sonnet(instruccion);
  return texto || (`¡Hola! Soy Estefi de Estefan Peluquería 💛` + MENU);
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPUESTA LIBRE — para mensajes que el state machine no captura
// ─────────────────────────────────────────────────────────────────────────────
async function responderLibre(mensaje, historial = [], contextoCliente = '') {
  if (!cbOk()) return 'Perdoná, tenemos alta demanda ahora. Escribinos en unos minutitos 🙏';

  const systemFinal = contextoCliente
    ? `${SISTEMA_ESTEFI}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nFICHA DE LA CLIENTA CON LA QUE HABLÁS AHORA\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${contextoCliente}`
    : SISTEMA_ESTEFI;

  try {
    const messages = [
      ...historial.slice(-10).filter(h => h.role && h.content),
      { role: 'user', content: mensaje },
    ];
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: systemFinal,
      messages,
    });
    return resp.content[0]?.text?.trim() || '¿En qué más te puedo ayudar? 💛';
  } catch (err) {
    cbFail();
    console.error('[personal] responderLibre error:', err.message);
    return 'Perdón, tuve un problema técnico. ¿Podés repetir? 🙏';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIONES DEL FLUJO DE RESERVA
// Cada una recibe instrucción precisa + ejemplos para evitar respuestas genéricas
// ─────────────────────────────────────────────────────────────────────────────

async function iniciarReserva(profile, historial = []) {
  const contexto = profile?.toPromptContext?.() || '';
  const favorito = profile?.favoriteService;
  const instruccion = favorito
    ? `La clienta quiere sacar un turno. Su servicio favorito es ${favorito}. Preguntale si viene por eso o por otra cosa. Ejemplos: "¿Venís por el ${favorito} como siempre, o se te antoja algo distinto?" — adaptalo. Una pregunta, máximo 2 líneas.`
    : `La clienta quiere sacar un turno. Respondé con entusiasmo genuino y preguntale qué servicio quiere. Ejemplos: "¡Dale! ¿Qué querés hacerte?" o "¡Buenísimo! ¿Qué se te antoja?" — variá, no copies exacto. Una pregunta, máximo 2 líneas.`;
  const texto = await _sonnet(instruccion, historial, contexto);
  return texto || '¡Dale! ¿Qué servicio te gustaría hacerte? ✨';
}

async function celebrarServicioYPedirDia(servicio, extra, profile, historial = []) {
  const srvStr = servicio.nombre + (extra ? ` + ${extra.nombre}` : '');
  const habitual = profile?.usualDay ? ` Suele venir los ${profile.usualDay}.` : '';
  const contexto = profile?.toPromptContext?.() || '';
  const instruccion = `La clienta eligió: ${srvStr}. Celebrá con entusiasmo genuino y preguntá qué día le viene bien. Horario: lunes a sábado de 10 a 20hs.${habitual}
Ejemplos del tono correcto:
- "¡Buena elección! El corte con brushing queda divino. ¿Qué día te viene bien?"
- "¡Uh, el balayage! Una de las técnicas que más nos gustan. ¿Cuándo venís?"
- "¡Me encanta! ¿Qué día te queda bien?"
Adaptalo al servicio ${servicio.nombre}. Una pregunta, máximo 2 líneas.`;
  const texto = await _sonnet(instruccion, historial, contexto);
  return texto || `¡Buena elección! ✨ ¿Qué día te viene bien?\nAtendemos *lunes a sábado de 10:00 a 20:00hs*`;
}

async function pedirHora(dia, servicio, profile, historial = []) {
  const habitual = profile?.usualTime ? ` Habitualmente viene a las ${profile.usualTime}.` : '';
  const instruccion = `Tenemos ${servicio.nombre} para el ${dia}. Preguntá a qué hora. Horario: 10:00 a 20:00hs.${habitual}
Ejemplos: "¿A qué hora el ${dia}?" o "¿Y a qué hora te viene bien?" — muy breve, una línea.`;
  const texto = await _sonnet(instruccion, historial);
  return texto || `⏰ ¿A qué hora el ${dia}? Tenemos de 10:00 a 20:00hs`;
}

async function pedirNombre(servicio, dia, hora, historial = []) {
  const instruccion = `Tenemos ${servicio.nombre} el ${dia} a las ${hora}. Pedí el nombre para anotar el turno.
Ejemplos del tono correcto:
- "¿Y cómo te llamás para anotar el turno? 😊"
- "¡Perfecto! ¿Me decís tu nombre?"
- "Buenísimo. ¿A nombre de quién lo anoto?"
Una línea, variá el ejemplo.`;
  const texto = await _sonnet(instruccion, historial);
  return texto || '¿Me decís tu nombre para anotar el turno? 😊';
}

async function ofrecerUpsell(servicioPrincipal, servicioExtra, profile, historial = []) {
  const BENEFICIOS = {
    'Ampolla':           'hidrata en profundidad, sella la cutícula y deja el pelo suave y brillante sin frizz',
    'Ozono':             'son 15 minutitos y el pelo queda con otro brillo y textura — lo nota todo el mundo',
    'Head Spa completo': 'es una experiencia: limpieza profunda del cuero cabelludo, masajes, hidratación total. Salís con el pelo increíble',
    'Brushing / Planchita': 'salís del salón con el pelo listo, divino',
  };
  const beneficio = BENEFICIOS[servicioExtra.nombre] || 'potencia el resultado del servicio';
  const precio = servicioExtra.precio.toLocaleString('es-AR');
  const instruccion = `La clienta eligió ${servicioPrincipal.nombre}. Ofrecele agregar ${servicioExtra.nombre} ($${precio}) como complemento.
El beneficio real: ${beneficio}.
Ofrecelo como una amiga que recomienda algo bueno, no como vendedor. Con convicción pero sin presión. Una pregunta al final.
Ejemplo de tono: "Una cosa — la ampolla después del corte deja el pelo increíble, suave y sin frizz. Son $30.000 más. ¿La sumamos?"
Adaptalo a ${servicioExtra.nombre}. Máximo 2 líneas.`;
  const texto = await _sonnet(instruccion, historial, profile?.toPromptContext?.() || '');
  return texto || `¿Le sumamos una *${servicioExtra.nombre}*? ${beneficio} — $${precio} más 💛`;
}

async function pedirEmail(nombre, historial = []) {
  const instruccion = `${nombre ? nombre + ' confirmó' : 'Confirmó'} el turno. Pedile el email para mandarle la confirmación con el código.
Ejemplos del tono correcto:
- "¿Me dejás tu mail? Te mando el código del turno para tenerlo guardado 📧"
- "¿Tenés mail? Te mando la confirmación con todos los datos"
Aclará que puede escribir *no* para saltear. Una línea.`;
  const texto = await _sonnet(instruccion, historial);
  return texto || '¿Me dejás tu mail? Te mando el código del turno 📧\n_(o *no* para saltear)_';
}

async function responderPrecios(mensajeCliente, historial = [], contextoCliente = '') {
  const lista =
    `💈 *Servicios y Precios — Estefan Peluquería*\n\n` +
    `✂️ *Cortes*\n  • Corte de pelo: *$50.000* _(incluye lavado y aireado)_\n  • Corte + Brushing: *$70.000*\n  • Brushing / Planchita: *$20.000*\n  • Lavado + Aireado: *$15.000*\n\n` +
    `🎨 *Color* _(consulta previa requerida)_\n  • Retoque / Raíz: *$60.000*\n  • Color entero: *desde $80.000*\n  • Contorno: *$80.000*\n  • Balayage: *desde $200.000*\n  • Decoloración total: *desde $200.000*\n\n` +
    `💆 *Tratamientos*\n  • Ozono capilar: *$30.000* _(15 min, se suma a cualquier servicio)_\n  • Head Spa completo: *$120.000*\n  • Ampolla reparadora: *$30.000*\n\n` +
    `💐 *Peinados* _(requieren seña)_\n  • Fiesta / 15 años: *desde $60.000*\n  • Novia: *desde $150.000*`;

  const cierre = await _sonnet(
    `Mostramos la lista de precios. Escribí UNA línea de cierre cálida que invite a reservar o preguntar. No repitas precios. Ejemplos: "¿Alguno te llama la atención?" o "¿Reservamos?" — variá.`,
    historial,
    contextoCliente
  );

  return lista + `\n\n${cierre || '_¿Alguno te llama la atención? ¡Escribime! 💛_'}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MENSAJES HARDCODEADOS — datos críticos, Sonnet no los toca
// ─────────────────────────────────────────────────────────────────────────────

function resumenConfirmar(d) {
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
  msg += `\n\n¿Confirmamos? *(sí / no)*`;
  return msg;
}

function turnoConfirmado(nombre, servicio, fechaDisplay, hora, code, pointsEarned) {
  let msg = `✅ *¡Turno confirmado${nombre ? ', ' + nombre : ''}!* 💛\n\n`;
  msg += `📅 ${fechaDisplay}\n`;
  msg += `⏰ ${hora}\n`;
  msg += `✂️ ${servicio}\n`;
  msg += `🔖 Código: *${code}*\n\n`;
  msg += `_Guardá el código — con ese podés cambiar o cancelar cuando quieras_ 😊`;
  if (pointsEarned > 0) msg += `\n⭐ Ganaste *+${pointsEarned} puntos*`;
  return msg;
}

function senaRequerida(nombre, servicio, fechaDisplay, hora, code, montoSena, mpLink) {
  let msg = `⏳ *Turno registrado${nombre ? ', ' + nombre : ''}* 💛\n\n`;
  msg += `📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n`;
  msg += `⚠️ *Para confirmar necesitamos una seña de $${montoSena}*\n`;
  msg += mpLink
    ? `Podés pagarla acá 👇\n${mpLink}\n\n_Una vez recibido el pago te llega la confirmación_ 📧`
    : `Coordinamos el pago cuando vengas o por acá 💛`;
  return msg;
}

function turnoEncontrado(b) {
  return (
    `📋 *Tu turno:*\n\n` +
    `👤 ${b.nombre}\n✂️ ${b.servicio}\n📅 ${b.fecha} · ⏰ ${b.hora}\n🔖 ${b.code}\n\n` +
    `¿Qué querés hacer?\n1️⃣ Cambiar fecha/hora\n2️⃣ Cancelar turno\n3️⃣ Volver`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CEO MODE — respuesta con datos del negocio
// ─────────────────────────────────────────────────────────────────────────────
async function handleCEO(text, historial = []) {
  const db = getDB();
  let stats = 'Sin datos disponibles.';
  if (db) {
    try {
      const [bk, pay, cl] = await Promise.all([
        db.query(`SELECT COUNT(*) FILTER (WHERE status='Confirmado') as confirmados, COUNT(*) FILTER (WHERE status='Cancelado') as cancelados, COUNT(*) FILTER (WHERE date_str=TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY')) as hoy FROM bookings`).then(r=>r.rows[0]).catch(()=>({})),
        db.query(`SELECT COALESCE(SUM(total) FILTER (WHERE created_at::date=NOW()::date),0) as hoy, COALESCE(SUM(total) FILTER (WHERE created_at>=NOW()-INTERVAL '7 days'),0) as semana, COALESCE(AVG(total),0) as ticket FROM payments WHERE status!='mp_pending'`).then(r=>r.rows[0]).catch(()=>({})),
        db.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE visit_count>=1) as activos FROM clients`).then(r=>r.rows[0]).catch(()=>({})),
      ]);
      stats = `Turnos hoy: ${bk.hoy||0} | Confirmados: ${bk.confirmados||0} | Cancelados: ${bk.cancelados||0}\nIngresos hoy: $${Number(pay.hoy||0).toLocaleString('es-AR')} | Semana: $${Number(pay.semana||0).toLocaleString('es-AR')} | Ticket prom: $${Math.round(Number(pay.ticket||0)).toLocaleString('es-AR')}\nClientes: ${cl.total||0} total | ${cl.activos||0} activos`;
    } catch {}
  }
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 600,
    system: `Sos Estefi, asistente directa del dueño de Estefan Peluquería. Respondés con datos reales, directo al punto, en español rioplatense.\n\nDATA ACTUAL:\n${stats}`,
    messages: [...historial.slice(-6).map(h=>({role:h.role,content:h.content})), {role:'user',content:text}],
  });
  return resp.content[0]?.text || 'No pude procesar eso 😅';
}

// ─────────────────────────────────────────────────────────────────────────────
// FAQ DIRECTOS — sin IA, respuesta inmediata con datos de la ficha
// ─────────────────────────────────────────────────────────────────────────────
function handleFAQ(texto, clientCtx) {
  const tl = (texto || '').toLowerCase();
  const p  = clientCtx?.profile;
  if (!p) return null;

  if (/cuántos?.*punt|mis punt|punt.*teng|cuántos punt/i.test(tl)) {
    return p.points > 0
      ? `¡Tenés *${p.points} puntos* acumulados! ⭐ Con cada visita sumás más. Escribí *puntos* para ver qué podés canjear 💛`
      : 'Todavía no tenés puntos, pero cada servicio suma. ¡Ya vas a arrancar! 💛';
  }

  if (/próximo.*turno|mi turno|cuándo.*turno|tengo.*turno|mi reserva/i.test(tl)) {
    return p.nextBooking
      ? `Tu próximo turno:\n\n✂️ *${p.nextBooking.servicio}*\n📅 ${p.nextBooking.fecha} a las ${p.nextBooking.hora}\n🔖 Código: *${p.nextBooking.code}*\n\n¿Necesitás cambiar algo? 💛`
      : 'No tenés ningún turno agendado. ¿Lo sacamos ahora? 💛';
  }

  if (/últimos?.*servicio|qué.*hice|historial|mis.*visitas|cuántas.*veces/i.test(tl)) {
    if (p.visitCount === 0) return 'Todavía no tenés visitas registradas 😊 ¿Querés sacar tu primer turno?';
    const hist = p.lastServices?.length > 0
      ? p.lastServices.map(s => `• ${s.servicio} (${s.fecha})`).join('\n')
      : 'Sin detalle de servicios disponible';
    return `Tus últimas visitas (${p.visitCount} en total):\n\n${hist}\n\n¡Siempre un gusto tenerte! 💛`;
  }

  if (/mi.*mail|mi.*email|tengo.*mail|cambiar.*mail/i.test(tl)) {
    return p.email
      ? `Tenemos registrado el mail *${p.email}* 📧 ¿Es correcto? Si cambió, avisame.`
      : 'No tenemos ningún mail registrado para vos todavía. ¿Me lo pasás? Te mando las confirmaciones de tus turnos 📧';
  }

  if (/cuánto.*gasté|total.*gastado|mis.*gastos/i.test(tl)) {
    return p.totalSpent > 0
      ? `En total gastaste *$${Number(p.totalSpent).toLocaleString('es-AR')}* en el salón 💛${p.isVip ? ' — ¡Sos nuestra clienta VIP! ⭐' : ''}`
      : 'Todavía no tenemos gastos registrados para vos.';
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Saludo y conversación libre
  generarSaludo,
  responderLibre,
  responderPrecios,

  // Flujo de reserva
  iniciarReserva,
  celebrarServicioYPedirDia,
  pedirHora,
  pedirNombre,
  ofrecerUpsell,
  pedirEmail,

  // Mensajes hardcodeados (datos críticos)
  resumenConfirmar,
  turnoConfirmado,
  senaRequerida,
  turnoEncontrado,

  // Utilidades
  handleCEO,
  handleFAQ,
};