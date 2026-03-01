// ── AGENT: PERSONAL ───────────────────────────────────────────────────────────
// El asistente personal de cada clienta. Conoce su historial completo,
// sus preferencias, su tono. Se activa cuando el cliente ya está identificado.
// Devuelve { texto, intent, datos } — nunca ejecuta acciones directamente.

const axios = require('axios');

const SYSTEM_BASE = `Sos Estefan, la asistente personal de Estefan Peluquería en Puertos, Buenos Aires.
Tenés una personalidad cálida, apasionada por el pelo, con humor suave y genuino.
Hablás en español rioplatense auténtico. Sos como una amiga del barrio que es experta en lo suyo.

REGLAS CRÍTICAS:
- Nunca confirmes ni ejecutes acciones (turnos, pagos, etc) — eso lo hace el sistema
- Si reconocés a una clienta habitual, mencioná algo de sus visitas anteriores naturalmente
- Usá su nombre cuando lo sepás, pero no de forma robótica
- Máx 3 oraciones por respuesta en conversación normal
- Si detectás intención de reservar/cancelar/ver turno, guiá suavemente hacia eso

FORMATO DE RESPUESTA (JSON puro, sin markdown):
{
  "intent": "RESERVAR|GESTIONAR|CANCELAR|PRECIO|LOYALTY|SALUDO|CHARLA|OTRO",
  "nombre": "string o null",
  "servicio": "nombre exacto del servicio o null",
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
"n" o "nop" o "nel" → intent NO, upsell false

SERVICIOS (nombre exacto):
Corte de pelo | Corte + Brushing | Brushing / Planchita | Lavado + Aireado
Ozono | Head Spa completo | Ampolla | Retoque / Raíz | Color entero | Contorno
Balayage | Decoloración total | Peinado fiesta / 15 | Peinado novia

DÍAS: corregí errores → "lumes"→"lunes", "mier"→"miércoles", "sab"→"sábado"`;

async function interpret({ text, clientCtx, historial = [], step = 'LIBRE' }) {
  const contextBlock = clientCtx?.context
    ? `\nCONTEXTO DEL CLIENTE:\n${clientCtx.context}\n`
    : '\nCliente nuevo — primera interacción.\n';

  const stepBlock = `Estado del flujo: ${step}
Datos ya recolectados: ${JSON.stringify(clientCtx?.currentData || {})}`;

  const historialBlock = historial.length > 0
    ? `\nÚltimos mensajes:\n${historial.slice(-6).map(m=>`${m.role}: ${m.content}`).join('\n')}`
    : '';

  const system = SYSTEM_BASE + contextBlock + historialBlock;

  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        system,
        messages: [{ role: 'user', content: `${stepBlock}\n\nMensaje: "${text}"` }]
      },
      {
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 12000
      }
    );
    const raw = res.data.content?.[0]?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    console.log(`[personal] intent=${parsed.intent} | srv=${parsed.servicio} | dia=${parsed.dia} | hora=${parsed.hora} | nombre=${parsed.nombre}`);
    return parsed;
  } catch(e) {
    console.error('[personal] Error:', e.message);
    return { intent: 'OTRO', texto: 'Un momento, tuve un problemita técnico 😅 ¿Me repetís lo que necesitás?' };
  }
}

// Generar bienvenida personalizada basada en historial
async function greet({ clientCtx }) {
  const client = clientCtx?.client;
  const memory = clientCtx?.memory;
  const bookings = clientCtx?.recentBookings || [];

  if (!client?.name) {
    return '¡Hola! 💛 Bienvenida a Estefan Peluquería. ¿Cómo te llamás?';
  }

  // Cliente conocida con historial
  if (client.visit_count > 0 && bookings.length > 0) {
    const lastService = bookings[0]?.service;
    const lastDate = bookings[0]?.date_str;
    const prompts = [
      `¡Hola ${client.name}! ¿Cómo quedó el ${lastService} del ${lastDate}? 💛`,
      `¡${client.name}! Qué bueno verte de nuevo 💛 ¿Venís por el pelo?`,
      `¡Hola ${client.name}! Hace un tiempo que no te veo por acá 😊 ¿Qué necesitás hoy?`,
    ];
    return prompts[Math.floor(Math.random() * prompts.length)];
  }

  // Cliente nueva con nombre
  return `¡Hola ${client.name}! Bienvenida a Estefan 💛 ¿En qué te puedo ayudar?`;
}

module.exports = { interpret, greet };
