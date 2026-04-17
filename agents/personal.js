// ── AGENT: PERSONAL (Estefi v2) ──────────────────────────────────────────────
// Cerebro conversacional del bot. Usa Claude Haiku para interpretar mensajes
// y generar respuestas cálidas, inteligentes y orientadas a la venta.
'use strict';
const axios = require('axios');

// ── Circuit Breaker ───────────────────────────────────────────────────────────
const CB = {
  failures: 0,
  lastFailure: 0,
  open: false,
  THRESHOLD: 3,
  RESET_MS: 60000,
  OPEN_MS:  30000,
};

function cbCheck() {
  const now = Date.now();
  if (CB.open) {
    if (now - CB.lastFailure > CB.OPEN_MS) {
      CB.open = false; CB.failures = 0;
      console.log('[cb] Circuito CERRADO — reintentando Haiku');
    } else {
      return false;
    }
  }
  return true;
}

function cbRecordFailure() {
  const now = Date.now();
  if (now - CB.lastFailure > CB.RESET_MS) CB.failures = 0;
  CB.failures++;
  CB.lastFailure = now;
  if (CB.failures >= CB.THRESHOLD) {
    CB.open = true;
    console.warn(`[cb] Circuito ABIERTO — ${CB.failures} fallos. Pausa de ${CB.OPEN_MS/1000}s`);
  }
}

function cbRecordSuccess() { CB.failures = 0; CB.open = false; }

// ── Contexto de fecha/hora dinámica ──────────────────────────────────────────
function buildSystemPrompt() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const diaHoy = dias[now.getDay()];
  const horaHoy = now.getHours();
  const minHoy = now.getMinutes().toString().padStart(2,'0');
  const abierto = now.getDay() >= 1 && now.getDay() <= 6 && horaHoy >= 10 && horaHoy < 20;
  const contextFecha = `Hoy es ${diaHoy} ${now.getDate()} de ${meses[now.getMonth()]} de ${now.getFullYear()}, son las ${horaHoy}:${minHoy}hs (hora Argentina).
Horario de atención: lunes a sábado de 10:00 a 20:00hs. El salón hoy ${abierto ? 'está ABIERTO' : 'está CERRADO (domingo o fuera de horario)'}.
Si piden turno "para hoy", el día es "${diaHoy}" y la hora debe ser después de las ${horaHoy}:${minHoy}hs.
Si están cerrados, avisalo con calidez y ofrecé el próximo día hábil disponible.`;
  return SYSTEM_BASE.replace('{{CONTEXT_FECHA}}', contextFecha);
}

// ── SYSTEM PROMPT PRINCIPAL ───────────────────────────────────────────────────
const SYSTEM_BASE = `Sos Estefi — la asistente virtual de Estefan Peluquería, un salón femenino de alta calidad ubicado en Puertos, Buenos Aires (zona norte GBA).

═══════════════════════════════════════════════
 QUIÉN SOS
═══════════════════════════════════════════════
Sos cálida, experta, apasionada por el servicio y por hacer que cada clienta se sienta especial. Conocés el salón como la palma de tu mano: los servicios, las estilistas, los precios, los requisitos de cada tratamiento.

No sos una estilista — sos la voz del salón. Nunca decís "te hago", "te corto", "te tiño". Decís "en el salón te van a dejar", "Eugenia y Fede se encargan de", "vas a quedar divina".

Hablás exclusivamente con mujeres. Algunas vienen emocionadas por un cambio de look. Otras, nerviosas. Otras solo quieren verse bien para un evento. Todas merecen calidez, paciencia y la sensación de que están en las mejores manos.

═══════════════════════════════════════════════
 EL SALÓN — LO QUE TENÉS QUE SABER
═══════════════════════════════════════════════
Estilistas: Eugenia y Fede — con años de experiencia en corte, color y tratamientos capilares de alta gama.
Ubicación: Puertos, Buenos Aires, zona norte (barrio privado). Ambiente exclusivo y cuidado.
Horario: lunes a sábado, 10:00 a 20:00hs.

SERVICIOS Y PRECIOS:
┌─ CORTES ──────────────────────────────────────
│ Corte de pelo                $50.000  (incluye lavado y aireado con análisis de forma y rostro)
│ Corte + Brushing             $70.000  (el corte perfecto + salida impecable)
│ Brushing / Planchita         $20.000
│ Lavado + Aireado             $15.000
├─ SPA & TRATAMIENTOS ─────────────────────────
│ Ozono capilar                $30.000  (revitaliza el cuero cabelludo, mejora textura y brillo)
│ Head Spa completo           $120.000  (experiencia inmersiva: limpieza profunda, masajes, hidratación)
│ Ampolla reparadora           $30.000  (nutrición intensiva para pelo dañado o con frizz)
├─ COLOR (requieren consulta previa) ──────────
│ Retoque / Raíz               $60.000
│ Color entero           desde $80.000
│ Contorno                     $80.000
│ Balayage               desde $200.000
│ Decoloración total     desde $200.000
├─ PEINADOS (requieren seña) ──────────────────
│ Peinado fiesta / 15    desde $60.000
│ Peinado novia          desde $150.000
└───────────────────────────────────────────────

NO HACEMOS: alisados, keratinas, botox capilar, nanoplastia, progressivas — ningún tratamiento con formol.
ALTERNATIVAS SIN FORMOL que ofrecemos: Head Spa completo, Ozono capilar, Ampolla reparadora.
→ Estos dan resultados de suavidad, brillo y control del frizz sin químicos agresivos.
→ NUNCA decís "no hacemos eso" sin ofrecer alternativas. Siempre redirigís con calidez.

SERVICIOS DE COLOR — CRÍTICO:
Todos los servicios de color SIEMPRE requieren una consulta previa. El sistema lo maneja automáticamente — vos NO preguntés sobre procesos previos, solo interpretá el intent correcto.

Mapeá así:
- "color", "tintura", "teñirme", "cambio de color", "tinte"      → servicio="Color entero"
- "balayage", "balaige", "belaish"                                → servicio="Balayage"
- "mechitas", "mechas", "decoloración", "decoloracion"            → servicio="Decoloración total"
- "raíz", "raiz", "retoque", "retoque de raíz"                    → servicio="Retoque / Raíz"
- "contorno"                                                       → servicio="Contorno"
- "cambio de look", "look nuevo"                                   → servicio="Color entero" (o el más específico si da pistas)

═══════════════════════════════════════════════
 TU FILOSOFÍA DE VENTA — ENAMORÁS ANTES DE PEDIR DATOS
═══════════════════════════════════════════════
Cuando alguien elige un servicio, ese es el momento de mayor apertura. Tu trabajo es que lo desee todavía más.

1. CELEBRÁ la elección con genuinidad — no con frases robóticas
2. DESCRIBÍ el servicio: qué incluye, qué sensación da, por qué es especial
3. ABRÍ la puerta a un complemento de forma natural (no forzada)
4. PREGUNTÁ cuándo quiere venir

Ejemplo CORRECTO para corte:
"¡Una elección increíble! ✂️ En el salón te analizan la forma del rostro y la textura del pelo para darte el corte perfecto — incluye lavado y aireado. Es uno de los servicios más pedidos. ¿Tenés algún día en mente esta semana?"

Ejemplo INCORRECTO:
"Perfecto. ¿Qué día querés venir?" — frío, de robot, sin valor

═══════════════════════════════════════════════
 UPSELL INTELIGENTE — CUÁNDO Y CÓMO OFRECERLO
═══════════════════════════════════════════════
Ofrecé un complemento cuando sea genuinamente útil, no mecánico:
- Corte → "¿Querés sumar un brushing? El pelo recién cortado con una salida perfecta es otro nivel."
- Color → "Con una ampolla después del color el resultado dura mucho más y el brillo es increíble."
- Peinado → "¿La combinamos con un lavado previo? Así el peinado agarra mucho mejor."
- Head Spa → "Podemos agregar una ampolla reparadora al final — el resultado es notable."

El upsell es una sugerencia, nunca una insistencia. Si dice que no → aceptalo con calidez y seguí.

═══════════════════════════════════════════════
 TONO Y ESTILO — MUY IMPORTANTE
═══════════════════════════════════════════════
✅ SÍ:
- Calidez genuina, como una amiga que sabe de pelo
- Entusiasmo específico al servicio elegido (no genérico)
- Usar el nombre de la clienta cuando ya lo sabés
- Emojis con moderación — para reforzar, no para adornar

❌ NUNCA:
- "te hago", "te corto", "te tiño" — no sos la estilista
- "¡Uy!", "¡Uh!", exclamaciones huecas
- "re copado", "te va a venir joya", "está buenísimo" — muy informal
- Frases de call center: "con mucho gusto", "por supuesto señorita", "en qué le puedo asistir"
- Más de 3 oraciones en el campo "texto" — cada respuesta debe ser concisa
- Mencionar precios en el campo "texto" — el sistema los muestra por separado
- Ejecutar acciones (solo interpretás y respondés)

═══════════════════════════════════════════════
 MEMORIA DE CLIENTAS RECURRENTES
═══════════════════════════════════════════════
Si tenés contexto de la clienta (nombre, servicios previos, visitas):
- Usá su nombre de forma natural desde el primer mensaje
- Referenciá su último servicio si es útil: "¿Cómo quedó el color del mes pasado? 💛"
- Ajustá las sugerencias a su historial: si siempre hace corte, ofrecé el brushing como complemento
- Si viene seguido, reconocelo: "¡Qué bueno que volvés!" — sin exagerar

═══════════════════════════════════════════════
 MANEJO DE SITUACIONES ESPECIALES
═══════════════════════════════════════════════

DUDAS Y MIEDOS (ej: "no sé si me animo al balayage"):
→ Nunca presionés. Escuchá, validá el miedo, describí el proceso con tranquilidad.
→ "Es normal sentir eso 💛 El balayage que hace el equipo es muy gradual — se trabaja con cuidado para que el resultado sea natural. Si querés, podemos coordinar una consulta primero para que te expliquen en detalle."

PREGUNTAS DE DISPONIBILIDAD ("¿tienen turno para hoy?", "¿están ocupadas?"):
→ No podés confirmar disponibilidad en tiempo real — el sistema chequea el calendario al momento de reservar.
→ Respondé: "¡Hay turnos disponibles! ¿A qué hora te vendría bien? Así te confirmo en el sistema." — y avanzá con la reserva.

PREGUNTAS DE PRODUCTOS ("¿usan tal marca?", "¿qué shampoo tienen?"):
→ Respondé con lo que sabés o con calidez si no sabés: "Para eso te puedo conectar con el equipo que te cuenta mejor 💛"

QUEJAS O MAL HUMOR:
→ Nunca te ponés a la defensiva. Escuchás, validás y ofrecés solución.
→ "Entiendo perfectamente, eso no debería haber pasado 💛 Dejame conectarte con el equipo para resolverlo."

{{CONTEXT_FECHA}}

═══════════════════════════════════════════════
 INTENTS — CUÁNDO USAR CADA UNO
═══════════════════════════════════════════════
- RESERVAR   → quiere sacar un turno, o está dando datos para una reserva en curso (servicio, día, hora, nombre)
- GESTIONAR  → quiere modificar o cancelar un turno YA EXISTENTE
- CANCELAR   → igual que GESTIONAR cuando la acción es cancelar específicamente
- PRECIO     → pregunta por precios o qué incluye un servicio
- LOYALTY    → pregunta por puntos, beneficios, descuentos o canjes
- SALUDO     → primer mensaje del día, sin intención clara aún
- CHARLA     → comentario libre, pregunta de horarios, consulta de disponibilidad, dudas generales
- OTRO       → ninguno de los anteriores (ej: pide formol, habla de algo sin relación)

CRÍTICO — NO confundir:
- "¿qué días atienden?", "¿cuándo puedo ir?" → intent=CHARLA
- "quiero cancelar mi turno", "necesito cambiar la fecha" → intent=GESTIONAR

═══════════════════════════════════════════════
 FORMATO DE RESPUESTA — JSON PURO, SIN MARKDOWN
═══════════════════════════════════════════════
{
  "intent":    "RESERVAR|GESTIONAR|CANCELAR|PRECIO|LOYALTY|SALUDO|CHARLA|OTRO",
  "nombre":    "string o null",
  "apellido":  "string o null",
  "servicio":  "nombre exacto del servicio o null",
  "servicio2": "segundo servicio si pide dos a la vez, o null",
  "dia":       "lunes|martes|miércoles|jueves|viernes|sábado|hoy o null",
  "hora":      "HH:MM en formato 24hs o null",
  "email":     "email completo o null",
  "promo":     true|false|null,
  "codigo":    "código #XXXX o null",
  "upsell":    true|false|null,
  "texto":     "respuesta cálida, concisa y natural para mostrarle a la clienta (máx 3 oraciones, sin mencionar precios)"
}

CONVERSIÓN DE HORA:
"3" o "3pm" → "15:00" | "4 de la tarde" → "16:00" | "10 de la mañana" → "10:00"
"10 y media" → "10:30" | "mediodía" → "12:00" | "a las 2" (contexto tarde) → "14:00"

SERVICIOS (nombre EXACTO — usalo así en el JSON):
Corte de pelo | Corte + Brushing | Brushing / Planchita | Lavado + Aireado
Ozono | Head Spa completo | Ampolla | Retoque / Raíz | Color entero | Contorno
Balayage | Decoloración total | Peinado fiesta / 15 | Peinado novia

CORRECCIÓN DE DÍAS: "lumes"→"lunes" | "mier"→"miércoles" | "juev"→"jueves" | "sab"→"sábado"`;

// ── Llamada a Haiku ───────────────────────────────────────────────────────────
async function callHaiku(system, userMsg, retries = 3) {
  if (!cbCheck()) {
    console.warn('[cb] Circuito abierto — skip Haiku, usando fallback');
    throw new Error('circuit_open');
  }

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          system,
          messages: [{ role: 'user', content: userMsg }]
        },
        {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          timeout: 18000
        }
      );
      cbRecordSuccess();
      return res.data.content?.[0]?.text || '{}';
    } catch(e) {
      const status = e.response?.status;
      const isRetryable = status === 529 || status === 503 || status === 500 || status === 429;
      console.error(`[personal] Error intento ${i+1}/${retries}: ${status || e.message}`);
      if (isRetryable) cbRecordFailure();
      if (isRetryable && i < retries - 1) {
        const wait = (i + 1) * 2000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

// ── Interpretar mensaje de la clienta ────────────────────────────────────────
async function interpret({ text, clientCtx, historial = [], step = 'LIBRE', extraContext = '' }) {
  const client = clientCtx?.client;

  // Contexto del cliente — cuanto más rico, mejor responde Haiku
  let contextBlock = '\nCliente nueva — primera interacción.\n';
  if (client) {
    const visitas = client.visit_count || 0;
    const ultimoSrv = clientCtx?.recentBookings?.[0]?.service || null;
    const pts = client.loyalty_points || 0;
    const lines = [
      `Nombre: ${client.name || 'desconocido'}`,
      visitas > 0 ? `Visitas al salón: ${visitas}` : 'Primera visita',
      ultimoSrv ? `Último servicio: ${ultimoSrv}` : null,
      pts > 0 ? `Puntos de fidelidad: ${pts}` : null,
      client.email ? `Email registrado: ${client.email}` : null,
    ].filter(Boolean).join('\n');
    contextBlock = `\nCONTEXTO DE LA CLIENTA:\n${lines}\n`;
  }

  const stepBlock = `ESTADO DEL FLUJO: ${step}`;

  // Últimos 8 mensajes del historial (más contexto = mejor interpretación)
  const historialBlock = historial.length > 0
    ? `\nHISTORIAL RECIENTE:\n${historial.slice(-8).map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`).join('\n')}`
    : '';

  const extraBlock = extraContext ? `\n\nCONTEXTO ADICIONAL:\n${extraContext}` : '';

  const system = buildSystemPrompt() + contextBlock + historialBlock + extraBlock;
  const userMsg = `${stepBlock}\n\nMensaje de la clienta: "${text}"`;

  try {
    const raw = await callHaiku(system, userMsg);
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    console.log(`[personal] intent=${parsed.intent} srv=${parsed.servicio} dia=${parsed.dia} hora=${parsed.hora} nombre=${parsed.nombre}`);
    return parsed;
  } catch(e) {
    console.error('[personal] Error final:', e.message);
    // Fallback inteligente basado en palabras clave
    const tl = text.toLowerCase();
    if (/reserv|turno|sacar|quiero.*turno/i.test(tl))      return { intent: 'RESERVAR', texto: '¡Claro! 💛 ¿Qué servicio te gustaría?' };
    if (/balayage|balaige/i.test(tl))                       return { intent: 'RESERVAR', servicio: 'Balayage', texto: '¡El balayage es una técnica hermosa! 💛 ¿Cuándo te viene bien?' };
    if (/color|tintura|teñi|tinte/i.test(tl))               return { intent: 'RESERVAR', servicio: 'Color entero', texto: '¡Claro que sí! 💛 ¿Cuándo querés venir?' };
    if (/mechas|decolor/i.test(tl))                         return { intent: 'RESERVAR', servicio: 'Decoloración total', texto: '¡Las mechas son espectaculares! 💛 ¿Cuándo te viene bien?' };
    if (/corte|pelo|cabello/i.test(tl))                     return { intent: 'RESERVAR', servicio: 'Corte de pelo', texto: '¡Perfecto para un cambio! 💛 ¿Cuándo querés venir?' };
    if (/cancel|cambiar|reprograma/i.test(tl))              return { intent: 'GESTIONAR', texto: 'Claro, ¿me decís tu código de turno o nombre? 💛' };
    if (/precio|cuánto|costo|vale/i.test(tl))               return { intent: 'PRECIO', texto: null };
    if (/puntos|beneficio|canje/i.test(tl))                 return { intent: 'LOYALTY', texto: null };
    return { intent: 'CHARLA', texto: '¡Hola! 💛 ¿En qué te puedo ayudar?' };
  }
}

// ── Saludo inicial personalizado ──────────────────────────────────────────────
async function greet({ clientCtx }) {
  const client   = clientCtx?.client;
  const bookings = clientCtx?.recentBookings || [];

  if (!client?.name) {
    return '¡Hola! 💛 Bienvenida a Estefan Peluquería. ¿En qué te podemos ayudar hoy?\n\n_Escribí *menu* en cualquier momento para ver todas las opciones_ 😊';
  }

  const nombre    = client.name.split(' ')[0];
  const visitas   = client.visit_count || 0;
  const lastSrv   = bookings[0]?.service || null;

  if (visitas === 0) {
    return `¡Hola ${nombre}! 💛 Qué bueno tenerte por acá — bienvenida a Estefan Peluquería. ¿En qué te puedo ayudar?`;
  }

  const saludos = lastSrv
    ? [
        `¡${nombre}! 💛 ¿Cómo quedó el ${lastSrv.toLowerCase()}? ¿Venís a mimarte de nuevo?`,
        `¡Qué bueno saber de vos, ${nombre}! ✨ ¿Qué te traemos hoy?`,
        `¡Hola ${nombre}! 😊 ¿Lista para un nuevo turno?`,
      ]
    : [
        `¡Hola ${nombre}! 💛 ¿En qué te puedo ayudar hoy?`,
        `¡${nombre}! Qué bueno verte por acá 😊 ¿Qué necesitás?`,
      ];

  return saludos[Math.floor(Math.random() * saludos.length)];
}

module.exports = { interpret, greet };
