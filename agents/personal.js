// agents/personal.js
// =============================================================================
// Personal — Estefi's brain. Two modes:
//   CLIENT mode: sweet, personalized, reads ClientProfile, recommends, books
//   CEO mode:    data-driven, answers business questions from DB
// =============================================================================
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getDB } = require('../core/db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// CEO phone — detected by env var or hardcoded fallback
const CEO_PHONE = process.env.CEO_PHONE || process.env.OWNER_PHONE || null;

// ── CEO MODE ──────────────────────────────────────────────────────────────────

async function fetchBusinessData() {
  const db = getDB();
  if (!db) return null;

  const [bookings, payments, clients, loyalty] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'Confirmado') as confirmados,
        COUNT(*) FILTER (WHERE status = 'Completado') as completados,
        COUNT(*) FILTER (WHERE status = 'Cancelado')  as cancelados,
        COUNT(*) FILTER (WHERE date_str = TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY')) as hoy,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as ultimos_7d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as ultimos_30d
      FROM bookings
    `).then(r => r.rows[0]).catch(() => ({})),

    db.query(`
      SELECT
        COALESCE(SUM(total),0) as total_revenue,
        COALESCE(SUM(total) FILTER (WHERE fecha_str = TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY')),0) as hoy,
        COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'),0) as ultimos_7d,
        COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'),0) as ultimos_30d,
        COUNT(*) as total_cobros,
        AVG(total) as ticket_promedio
      FROM payments WHERE status != 'mp_pending'
    `).then(r => r.rows[0]).catch(() => ({})),

    db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE visit_count = 0) as nunca_visitaron,
        COUNT(*) FILTER (WHERE visit_count >= 1) as activos,
        COUNT(*) FILTER (WHERE visit_count >= 10) as vip,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as nuevos_30d,
        COALESCE(AVG(total_spent),0) as gasto_promedio
      FROM clients
    `).then(r => r.rows[0]).catch(() => ({})),

    db.query(`
      SELECT service, COUNT(*) as veces
      FROM bookings
      WHERE status IN ('Completado','Confirmado')
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY service
      ORDER BY veces DESC
      LIMIT 5
    `).then(r => r.rows).catch(() => []),
  ]);

  return { bookings, payments, clients, topServices: loyalty };
}

async function handleCEO(text, historial = []) {
  const data = await fetchBusinessData();

  const systemPrompt = `Sos Estefi, la asistente inteligente de Estefan Peluquería.
Cuando hablás con el CEO/dueño, sos directa, analítica y usás los datos reales del negocio.
Respondés en español. Sos concisa pero completa. Usás emojis con moderación.
Si te preguntan algo que no está en los datos, lo decís honestamente.

DATOS DEL NEGOCIO (actualizados ahora):

📅 TURNOS:
  Hoy: ${data?.bookings?.hoy || 0}
  Últimos 7 días: ${data?.bookings?.ultimos_7d || 0}
  Últimos 30 días: ${data?.bookings?.ultimos_30d || 0}
  Confirmados activos: ${data?.bookings?.confirmados || 0}
  Completados: ${data?.bookings?.completados || 0}
  Cancelados: ${data?.bookings?.cancelados || 0}

💰 INGRESOS:
  Hoy: $${Number(data?.payments?.hoy || 0).toLocaleString('es-AR')}
  Últimos 7 días: $${Number(data?.payments?.ultimos_7d || 0).toLocaleString('es-AR')}
  Últimos 30 días: $${Number(data?.payments?.ultimos_30d || 0).toLocaleString('es-AR')}
  Total histórico: $${Number(data?.payments?.total_revenue || 0).toLocaleString('es-AR')}
  Ticket promedio: $${Math.round(Number(data?.payments?.ticket_promedio || 0)).toLocaleString('es-AR')}
  Cobros registrados: ${data?.payments?.total_cobros || 0}

👥 CLIENTES:
  Total en sistema: ${data?.clients?.total || 0}
  Activos (1+ visita): ${data?.clients?.activos || 0}
  VIP (10+ visitas): ${data?.clients?.vip || 0}
  Nuevos este mes: ${data?.clients?.nuevos_30d || 0}
  Gasto promedio: $${Math.round(Number(data?.clients?.gasto_promedio || 0)).toLocaleString('es-AR')}

🏆 SERVICIOS MÁS PEDIDOS (último mes):
${(data?.topServices || []).map((s, i) => `  ${i+1}. ${s.service}: ${s.veces} veces`).join('\n') || '  Sin datos'}

Respondé la pregunta del CEO de forma clara y útil. Si puede ayudarle a tomar una decisión, hacé una recomendación concreta.`;

  const messages = [
    ...historial.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: text }
  ];

  const response = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 600,
    system:     systemPrompt,
    messages,
  });

  return response.content[0]?.text || 'No pude procesar eso 😅';
}

// ── CLIENT MODE ───────────────────────────────────────────────────────────────

function buildClientSystemPrompt(clientCtx, step, extraContext) {
  const profileContext = clientCtx?.promptContext || clientCtx?.profile?.toPromptContext() || 'Nueva clienta.';

  return `Sos Estefi, la asistente virtual de Estefan Peluquería en Puertos, Buenos Aires.
Sos la persona más dulce y genuina del mundo. Hacés sentir a cada clienta especial y escuchada.
Tu personalidad: cálida, entusiasta, profesional, nunca robótica. Variás tus respuestas.

══════════════════════════════════════════
PERFIL DE LA CLIENTA (léelo antes de responder)
══════════════════════════════════════════
${profileContext}

══════════════════════════════════════════
ESTADO DE LA CONVERSACIÓN
══════════════════════════════════════════
Paso actual: ${step || 'LIBRE'}
${extraContext ? '\nCONTEXTO ADICIONAL:\n' + extraContext : ''}

══════════════════════════════════════════
REGLAS DE ORO
══════════════════════════════════════════
1. Si la clienta pregunta por sus puntos → decíselos exactamente (están en el perfil)
2. Si pregunta cuándo es su próximo turno → decíselo exactamente (está en el perfil)
3. Si pregunta qué servicios se hizo antes → decíselos (están en el perfil)
4. Si tiene ficha técnica (color, textura, alergias) → úsala para personalizar
5. Si es VIP o tiene muchas visitas → reconocelo con calidez, sin exagerar
6. Upsell: si el perfil sugiere una oportunidad, ofrecela naturalmente UNA vez
7. Nunca inventés datos. Si no sabés algo, decís que no tenés esa info

══════════════════════════════════════════
VOZ Y TONO
══════════════════════════════════════════
- Variá los saludos: "¡Qué lindo verte por acá!" / "¡Hola!" / "Buenas! 💛" 
- Nunca empezés siempre con "¡Claro!" o "¡Perfecto!"
- Preguntas: solo UNA a la vez
- Mensajes cortos: máximo 3-4 líneas salvo que la clienta necesite más info
- Emoticones: con moderación, siempre naturales

Respondé en español rioplatense (vos, dale, buenísimo).`;
}

/**
 * interpret — the main NLU function.
 * Extracts intent + entities from client message.
 */
async function interpret({ text, clientCtx, historial = [], step, extraContext }) {
  const systemPrompt = buildClientSystemPrompt(clientCtx, step, extraContext);

  const extractionPrompt = `${systemPrompt}

══════════════════════════════════════════
TAREA
══════════════════════════════════════════
Analizá el mensaje y respondé en JSON con esta estructura:
{
  "intent": "RESERVAR|GESTIONAR|CANCELAR|PRECIO|LOYALTY|SALUDO|FAQ|CEO_DATA|OTRO",
  "servicio": "nombre exacto del servicio o null",
  "servicio2": "segundo servicio si pidió dos o null",
  "dia": "día en español o null",
  "hora": "HH:MM o null",
  "nombre": "nombre propio extraído o null",
  "email": "email extraído o null",
  "codigo": "código de turno #XXXX o null",
  "texto": "tu respuesta natural a la clienta (en español, con tu personalidad)"
}

FAQ includes: preguntas sobre puntos, próximo turno, historial, precios, servicios.
CEO_DATA: solo si el mensaje viene del dueño preguntando por métricas del negocio.

Mensaje: "${text}"`;

  try {
    const messages = [
      ...historial.slice(-4).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: extractionPrompt }
    ];

    const response = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 500,
      messages:   [{ role: 'user', content: extractionPrompt }],
    });

    const raw = response.content[0]?.text || '{}';
    // Extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { intent: 'OTRO', texto: raw };

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed;

  } catch(e) {
    console.error('[personal] interpret error:', e.message);
    return { intent: 'OTRO', texto: 'Disculpá, no entendí bien. ¿Podés decirme de otra forma? 😊' };
  }
}

/**
 * greet — personalized greeting at session start.
 */
async function greet({ clientCtx }) {
  const profile = clientCtx?.profile;

  if (!profile || profile.isNewClient) {
    const greetings = [
      '¡Hola! 👋 Bienvenida a *Estefan Peluquería* 💛 Soy Estefi, tu asistente. ¿En qué te puedo ayudar?',
      '¡Buenas! Bienvenida a Estefan 🌟 Soy Estefi — estoy acá para ayudarte con turnos, precios o cualquier consulta.',
      '¡Hola! ¡Qué bueno que escribís! Soy Estefi, la asistente de *Estefan Peluquería* 💛',
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  const nombre = profile.firstName || 'linda';

  // Build personalized greeting
  let msg = '';

  if (profile.daysSinceVisit !== null && profile.daysSinceVisit < 7) {
    msg = `¡Hola ${nombre}! Qué lindo verte por acá de nuevo 💛`;
  } else if (profile.isVip) {
    msg = `¡${nombre}! 🌟 Siempre un gusto tenerte por acá`;
  } else if (profile.daysSinceVisit > 60) {
    msg = `¡Hola ${nombre}! ¡Hacía tiempo que no te veíamos! 💛 ¿Cómo estás?`;
  } else {
    const hellos = [
      `¡Hola ${nombre}! ¡Qué alegría! 💛`,
      `¡${nombre}! ¡Buenas! 😊`,
      `Hola ${nombre}, bienvenida de nuevo 💛`,
    ];
    msg = hellos[Math.floor(Math.random() * hellos.length)];
  }

  // Add personalized hook if we have data
  if (profile.nextBooking) {
    msg += `\n\nTe recuerdo que tenés un turno de *${profile.nextBooking.servicio}* el *${profile.nextBooking.fecha}* a las *${profile.nextBooking.hora}* 📅`;
  } else if (profile.points > 0) {
    msg += `\n\nTenés *${profile.points} puntos* acumulados ⭐`;
  }

  return msg;
}

/**
 * handleFAQ — answers common questions directly from ClientProfile.
 * No AI needed for these — pure data lookup.
 */
function handleFAQ(text, clientCtx) {
  const tl = (text||'').toLowerCase();
  const profile = clientCtx?.profile;

  if (!profile) return null;

  // Points balance
  if (/cuántos?.*punt|mis punt|punt.*teng|cuento con punt/i.test(tl)) {
    if (profile.points > 0) {
      return `Tenés *${profile.points} puntos* acumulados ⭐\n\n¿Querés ver cómo canjearlos? Respondé *puntos* y te muestro las opciones 💛`;
    }
    return `Todavía no tenés puntos acumulados, pero cada servicio te suma más 💛 ¿Te ayudo con algo más?`;
  }

  // Next appointment
  if (/próximo.*turno|mi turno|cuándo.*turno|tengo.*turno|próxima.*cita/i.test(tl)) {
    if (profile.nextBooking) {
      const nb = profile.nextBooking;
      return `Tu próximo turno es:\n\n✂️ *${nb.servicio}*\n📅 ${nb.fecha} · ⏰ ${nb.hora}\n🔖 Código: *${nb.code}*\n\n¿Necesitás cambiar algo? 💛`;
    }
    return `No tenés ningún turno agendado por el momento. ¿Querés sacar uno? 💛`;
  }

  // Last services / history
  if (/últimos?.*servicio|qué.*hice|historial|me.*atendí|mis.*servicio/i.test(tl)) {
    if (profile.lastServices.length > 0) {
      const list = profile.lastServices.map(s => `• ${s.servicio} (${s.fecha})`).join('\n');
      return `Tus últimas visitas:\n\n${list}\n\n¿Querés sacar un turno para tu próxima vez? 💛`;
    }
    return `Todavía no tenemos registros de visitas anteriores 😊 ¿Sos nueva clienta?`;
  }

  // Visit count / loyalty status
  if (/cuántas.*veces|cuántas.*visit|mis visit/i.test(tl)) {
    if (profile.visitCount > 0) {
      return `Llevás *${profile.visitCount} visita${profile.visitCount !== 1 ? 's' : ''}* en Estefan 💛${profile.isVip ? '\n\n¡Sos clienta VIP! 🌟 Gracias por tu fidelidad' : ''}`;
    }
    return `Esta sería tu primera visita con nosotros 💛 ¡Vas a adorar la experiencia!`;
  }

  return null; // not an FAQ — let orchestrator handle it
}

module.exports = { interpret, greet, handleFAQ, handleCEO };
