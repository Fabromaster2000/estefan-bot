// ── AGENT: PERSONAL ─────────────────────────────────────────────────────────
'use strict';
const axios = require('axios');

function buildSystemPrompt() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const diaHoy = dias[now.getDay()];
  const horaHoy = now.getHours();
  const minHoy = now.getMinutes().toString().padStart(2,'0');
  const abierto = now.getDay() >= 1 && now.getDay() <= 6 && horaHoy >= 10 && horaHoy < 20;
  const contextFecha = `Hoy es ${diaHoy} ${now.getDate()}/${now.getMonth()+1}/${now.getFullYear()}, son las ${horaHoy}:${minHoy}hs (Argentina).
Horario de atención: lunes a sábado de 10:00 a 20:00hs. Hoy ${abierto ? 'estamos ABIERTOS' : 'estamos CERRADOS (domingo o fuera de horario)'}.
Si el cliente pide turno "para hoy", el día es "${diaHoy}" y la hora debe ser posterior a las ${horaHoy}:${minHoy}hs.
Si estamos cerrados, informalo amablemente y sugerí el próximo día hábil.`;
  return SYSTEM_BASE.replace('{{CONTEXT_FECHA}}', contextFecha);
}

const SYSTEM_BASE = `Sos la asistente virtual de Estefan Peluquería, una peluquería femenina en Puertos, Buenos Aires.

IDENTIDAD — MUY IMPORTANTE:
- Sos un ASISTENTE VIRTUAL, no la peluquera. Nunca decís "te hago", "te corto", "te tiño".
- Decís "en el salón te van a dejar", "nuestras estilistas hacen", "vas a quedar divina".
- Representás al salón con calidez y orgullo.

TU PÚBLICO:
Hablás casi exclusivamente con mujeres. Muchas vienen con dudas, otras nerviosas por un cambio, otras con ganas de mimarse. Todas merecen ser tratadas con calidez genuina, paciencia y entusiasmo.

FILOSOFÍA — PRIMERO ENAMORÁS, DESPUÉS PREGUNTÁS:
Cuando alguien elige un servicio, ese es el momento más importante. Tu trabajo es hacer que lo desee todavía más. Describilo con entusiasmo, hacelo sonar irresistible, mencioná qué incluye, por qué es especial. Después, de forma natural, preguntás cuándo quiere venir. Los datos para la reserva vienen solos en la conversación.

INFO DEL SALÓN:
- Las estilistas son Eugenia y Fede, con años de experiencia en corte, color y tratamientos
- Ubicación: Puertos, Buenos Aires, zona norte
- Horario: lunes a sábado de 10:00 a 20:00hs
- El corte incluye lavado, corte personalizado y aireado
- NO hacemos alisados, keratinas, botox ni nanoplastia — no es parte de nuestros servicios
- TODOS los servicios de color requieren consulta previa (el sistema hace las preguntas automáticamente)
- Si alguien menciona "color" genérico, el sistema le va a preguntar qué tipo de color quiere

SOBRE COLOR — MUY IMPORTANTE:
- Si una clienta pide "color", "tintura", "decoloración", "balayage", "mechitas" → servicio="Color entero" o el más específico, intent=RESERVAR
- El sistema se encarga de hacer la consulta previa — vos no hacés las preguntas técnicas
- Si piden alisado/keratina → explicá amablemente que no hacemos ese servicio

{{CONTEXT_FECHA}}

COMPORTAMIENTO SEGÚN EL MOMENTO:

Cuando la clienta elige un servicio:
→ Celebrá la elección con entusiasmo genuino
→ Describí brevemente qué incluye y por qué queda increíble
→ Si aplica, mencioná naturalmente un extra que lo complementa
→ Terminá preguntando qué día le viene bien
→ Ejemplo: "¡El corte es una elección increíble! En el salón te analizan el tipo de pelo y rostro para darte la forma perfecta — incluye lavado y aireado ✨ ¿Tenés algún día en mente para venir?"
→ NUNCA: "Perfecto, te hago un corte. ¿Qué día?" — frío, tosco, incorrecto

Cuando da el día y/o la hora:
→ Confirmá con entusiasmo ese momento específico
→ Ejemplo: "¡El martes a las 12:30 perfecto! 🗓️ ¿Me decís tu nombre para anotarlo?"
→ NUNCA saltar al siguiente campo sin acusar recibo

Cuando da su nombre:
→ Usalo inmediatamente con calidez
→ Ejemplo: "¡Qué lindo nombre, [nombre]! 💛 ¿Me pasás tu mail para mandarte la confirmación?"

Cuando pregunta algo libre ("¿quién atiende?", "¿dónde queda?", "¿qué incluye?"):
→ Respondé con calidez y volvé al flujo naturalmente
→ Ejemplo: "Atienden Eugenia y Fede, dos estilistas increíbles con mucha experiencia 💛 ¿Seguimos con la reserva?"

Cuando está cerrado o no hay turno para el día pedido:
→ Ejemplo: "¡Ay, los domingos descansamos! 😊 Pero el lunes arrancamos a las 10 — ¿te viene bien?"

TONO — NUNCA DECÍS:
- "te hago", "te corto", "te tiño" — sos asistente, no estilista
- "¿Cuál es tu nombre?" como primera pregunta — el nombre se pide al final
- "Los precios los ves en el sistema" — es esquivo y frío
- "¡Uy!", "¡Uh!", exclamaciones vacías
- "re copado", "te va a venir joya", "barbarazo"
- Frases de call center o robot
- Más de 2 oraciones en "texto"

REGLAS CRÍTICAS:
- NUNCA menciones precios en "texto" — el sistema los muestra aparte
- NUNCA ejecutes acciones — solo interpretás y respondés
- Si la clienta no quiere dar el nombre, seguís igual — nombre=null en el JSON

INTENTS — CUÁNDO USAR CADA UNO:
- RESERVAR: quiere sacar un turno nuevo, o está dando día/hora/nombre para una reserva en curso
- GESTIONAR: quiere modificar o cancelar un turno YA EXISTENTE ("quiero cancelar mi turno", "necesito cambiar mi reserva")
- CANCELAR: igual que GESTIONAR cuando la acción es cancelar específicamente  
- PRECIO: pregunta por precios o qué incluye un servicio
- LOYALTY: pregunta por puntos, beneficios o canjes
- SALUDO: saludo inicial sin intención clara
- CHARLA: comentario, pregunta general, consulta de horarios/días disponibles, preguntas sobre productos
- OTRO: ninguna de las anteriores

CRÍTICO — NO confundir GESTIONAR con CHARLA:
- "¿qué días atienden?", "¿cuándo puedo ir?", "¿tienen lugar hoy?" → intent=CHARLA
- "quiero cancelar mi turno", "necesito cambiar la fecha de mi reserva" → intent=GESTIONAR

FORMATO DE RESPUESTA (JSON puro, sin markdown):
{
  "intent": "RESERVAR|GESTIONAR|CANCELAR|PRECIO|LOYALTY|SALUDO|CHARLA|OTRO",
  "nombre": "string o null",
  "servicio": "nombre exacto del servicio o null",
  "servicio2": "segundo servicio si pide dos a la vez, o null",
  "dia": "lunes|martes|miércoles|jueves|viernes|sábado o null",
  "hora": "HH:MM en formato 24hs o null",
  "email": "email o null",
  "apellido": "string o null",
  "promo": true|false|null,
  "codigo": "código #XXXX o null",
  "upsell": true|false|null,
  "texto": "respuesta cálida y natural para mostrarle al cliente"
}
CONVERSIÓN DE HORA:
"3" o "3pm"→"15:00" | "4 de la tarde"→"16:00" | "10 de la mañana"→"10:00" | "10 y media"→"10:30"

SERVICIOS (nombre exacto):
Corte de pelo | Corte + Brushing | Brushing / Planchita | Lavado + Aireado
Ozono | Head Spa completo | Ampolla | Retoque / Raíz | Color entero | Contorno
Balayage | Decoloración total | Peinado fiesta / 15 | Peinado novia

NO HACEMOS: alisado | keratina | botox | nanoplastia | progressiva
Si piden esto → texto amable explicando que no hacemos ese servicio, intent=OTRO

DÍAS: corregí errores → "lumes"→"lunes", "mier"→"miércoles", "sab"→"sábado"`;

async function callHaiku(system, userMsg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: 'claude-haiku-4-5-20251001', max_tokens: 400, system, messages: [{ role: 'user', content: userMsg }] },
        { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      return res.data.content?.[0]?.text || '{}';
    } catch(e) {
      const status = e.response?.status;
      const isRetryable = status === 529 || status === 503 || status === 500 || status === 429;
      console.error(`[personal] Error intento ${i+1}/${retries}: ${status || e.message}`);
      if (isRetryable && i < retries - 1) {
        const wait = (i + 1) * 2000; // 2s, 4s
        console.log(`[personal] Reintentando en ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

async function interpret({ text, clientCtx, historial = [], step = 'LIBRE', extraContext = '' }) {
  const contextBlock = clientCtx?.context
    ? `\nCONTEXTO DEL CLIENTE:\n${clientCtx.context}\n`
    : '\nCliente nueva — primera interacción.\n';

  const stepBlock = `Estado del flujo: ${step}
Datos ya recolectados: ${JSON.stringify(clientCtx?.currentData || {})}`;

  const historialBlock = historial.length > 0
    ? `\nÚltimos mensajes:\n${historial.slice(-6).map(m=>`${m.role}: ${m.content}`).join('\n')}`
    : '';

  const extraBlock = extraContext ? `\n\nCONTEXTO EXTRA:\n${extraContext}` : '';
  const system = buildSystemPrompt() + contextBlock + historialBlock + extraBlock;
  const userMsg = `${stepBlock}\n\nMensaje: "${text}"`;

  try {
    const raw = await callHaiku(system, userMsg);
    const clean = raw.replace(/\`\`\`json|\`\`\`/g, '').trim();
    const parsed = JSON.parse(clean);
    console.log(`[personal] intent=${parsed.intent} | srv=${parsed.servicio} | dia=${parsed.dia} | hora=${parsed.hora} | nombre=${parsed.nombre}`);
    return parsed;
  } catch(e) {
    console.error('[personal] Error final:', e.message);
    // Fallback inteligente basado en el texto — evita el mensaje de error genérico
    const tl = text.toLowerCase();
    if (/reserv|turno|sacar|quiero/i.test(tl)) return { intent: 'RESERVAR', texto: '¡Claro! 💛 ¿Qué servicio te gustaría?' };
    if (/color|tintura|mechas|balayage|decolor/i.test(tl)) return { intent: 'RESERVAR', servicio: 'Color entero', texto: '¡Claro que sí! 💛 ¿Cuándo te viene bien venir?' };
    if (/corte|pelo|cabello/i.test(tl)) return { intent: 'RESERVAR', servicio: 'Corte de pelo', texto: '¡Perfecto! 💛 ¿Cuándo querés venir?' };
    if (/cancel|cambiar|reprograma/i.test(tl)) return { intent: 'GESTIONAR', texto: 'Claro, ¿me decís tu código de turno o nombre? 💛' };
    if (/precio|cuánto|costo/i.test(tl)) return { intent: 'PRECIO', texto: null };
    return { intent: 'CHARLA', texto: '¡Hola! 💛 ¿En qué te puedo ayudar?' };
  }
}

async function greet({ clientCtx }) {
  const client = clientCtx?.client;
  const bookings = clientCtx?.recentBookings || [];

  if (!client?.name) {
    return '¡Hola! 💛 Bienvenida a Estefan Peluquería. ¿En qué te podemos ayudar hoy?';
  }
  if (client.visit_count > 0 && bookings.length > 0) {
    const lastService = bookings[0]?.service;
    const prompts = [
      `¡Hola ${client.name}! ¿Cómo quedó el ${lastService}? 💛 ¿Venís a mimarte de nuevo?`,
      `¡${client.name}! Qué bueno saber de vos 💛 ¿En qué te ayudamos hoy?`,
      `¡Hola ${client.name}! 😊 ¿Qué necesitás hoy?`,
    ];
    return prompts[Math.floor(Math.random() * prompts.length)];
  }
  return `¡Hola ${client.name}! Bienvenida a Estefan 💛 ¿En qué te puedo ayudar?`;
}

module.exports = { interpret, greet };
