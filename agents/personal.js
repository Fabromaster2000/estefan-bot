// agents/personal.js
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getDB } = require('../core/db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CEO_PHONE = process.env.CEO_PHONE || process.env.OWNER_PHONE || null;

// ── EXACT SERVICE LIST — Claude must NEVER go outside this ───────────────────
const SERVICIOS_EXACTOS = `
SERVICIOS QUE OFRECEMOS — LISTA COMPLETA Y DEFINITIVA:
✂️ Cortes:
  • Corte de pelo — $50.000 (incluye lavado y aireado)
  • Corte + Brushing — $70.000
  • Brushing / Planchita — $20.000
  • Lavado + Aireado — $15.000

💆 Spa & Tratamientos:
  • Ozono capilar — $30.000
  • Head Spa completo — $120.000
  • Ampolla reparadora — $30.000

🎨 Color (requiere consulta previa):
  • Retoque / Raíz — $60.000
  • Color entero — desde $80.000
  • Contorno — $80.000
  • Balayage — desde $200.000
  • Decoloración total — desde $200.000

💐 Peinados (requieren seña):
  • Peinado fiesta / 15 años — desde $60.000
  • Peinado novia — desde $150.000

⛔ SERVICIOS QUE NO OFRECEMOS — NUNCA MENCIONAR NI SUGERIR:
  - Alisados, keratina, botox capilar, nanoplastia, formol, progressiva
  - Extensiones de cabello
  - Uñas, manicura, pedicura
  - Maquillaje, cejas, pestañas
  - Masajes, spa corporal
  Si alguien pregunta por alguno de estos: decís que no lo ofrecemos y sugerís
  el Head Spa o Ozono como alternativa de tratamiento capilar.
`;

// ── CEO MODE ──────────────────────────────────────────────────────────────────
async function fetchBusinessData() {
  const db = getDB();
  if (!db) return null;
  const [bookings, payments, clients, topServices] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='Confirmado') as confirmados,
        COUNT(*) FILTER (WHERE status='Completado') as completados,
        COUNT(*) FILTER (WHERE status='Cancelado')  as cancelados,
        COUNT(*) FILTER (WHERE date_str=TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY')) as hoy,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as ultimos_7d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as ultimos_30d
      FROM bookings
    `).then(r => r.rows[0]).catch(() => ({})),
    db.query(`
      SELECT
        COALESCE(SUM(total),0) as total_revenue,
        COALESCE(SUM(total) FILTER (WHERE fecha_str=TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY')),0) as hoy,
        COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'),0) as ultimos_7d,
        COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'),0) as ultimos_30d,
        COUNT(*) as total_cobros,
        AVG(total) as ticket_promedio
      FROM payments WHERE status != 'mp_pending'
    `).then(r => r.rows[0]).catch(() => ({})),
    db.query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE visit_count=0) as nunca_visitaron,
        COUNT(*) FILTER (WHERE visit_count>=1) as activos,
        COUNT(*) FILTER (WHERE visit_count>=10) as vip,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as nuevos_30d,
        COALESCE(AVG(total_spent),0) as gasto_promedio
      FROM clients
    `).then(r => r.rows[0]).catch(() => ({})),
    db.query(`
      SELECT service, COUNT(*) as veces FROM bookings
      WHERE status IN ('Completado','Confirmado')
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY service ORDER BY veces DESC LIMIT 5
    `).then(r => r.rows).catch(() => []),
  ]);
  return { bookings, payments, clients, topServices };
}

async function handleCEO(text, historial = []) {
  const data = await fetchBusinessData();
  const systemPrompt = `Sos Estefi, asistente inteligente de Estefan Peluquería.
Con el dueño hablás directo, analítico, con datos reales. Español, conciso, emojis con moderación.

DATOS ACTUALES:
📅 Turnos: hoy=${data?.bookings?.hoy||0} | 7d=${data?.bookings?.ultimos_7d||0} | 30d=${data?.bookings?.ultimos_30d||0} | confirmados=${data?.bookings?.confirmados||0} | cancelados=${data?.bookings?.cancelados||0}
💰 Ingresos: hoy=$${Number(data?.payments?.hoy||0).toLocaleString('es-AR')} | 7d=$${Number(data?.payments?.ultimos_7d||0).toLocaleString('es-AR')} | 30d=$${Number(data?.payments?.ultimos_30d||0).toLocaleString('es-AR')} | ticket promedio=$${Math.round(Number(data?.payments?.ticket_promedio||0)).toLocaleString('es-AR')}
👥 Clientes: total=${data?.clients?.total||0} | activos=${data?.clients?.activos||0} | vip=${data?.clients?.vip||0} | nuevos este mes=${data?.clients?.nuevos_30d||0}
🏆 Top servicios: ${(data?.topServices||[]).map((s,i)=>`${i+1}.${s.service}(${s.veces})`).join(' | ')||'sin datos'}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5', max_tokens: 600,
    system: systemPrompt,
    messages: [
      ...historial.slice(-6).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: text }
    ],
  });
  return response.content[0]?.text || 'No pude procesar eso 😅';
}

// ── CLIENT SYSTEM PROMPT ──────────────────────────────────────────────────────
function buildClientSystemPrompt(clientCtx, step, extraContext) {
  const profileContext = clientCtx?.promptContext
    || clientCtx?.profile?.toPromptContext()
    || 'Nueva clienta.';

  return `Sos Estefi, asistente virtual de Estefan Peluquería en Puertos, Buenos Aires.
Sos cálida, dulce, genuina. Nunca robótica. Variás tus respuestas.
Hablás en español rioplatense (vos, dale, buenísimo).

${SERVICIOS_EXACTOS}

PERFIL DE LA CLIENTA:
${profileContext}

PASO ACTUAL: ${step || 'LIBRE'}
${extraContext ? '\nCONTEXTO ADICIONAL:\n' + extraContext : ''}

REGLAS ABSOLUTAS:
1. SOLO mencionás servicios de la lista de arriba. NUNCA inventás otros.
2. Si preguntan por alisado, keratina, extensiones, uñas o maquillaje → "No ofrecemos ese servicio, pero tenemos [alternativa del catálogo]"
3. Puntos, próximo turno, historial → respondés con los datos exactos del perfil
4. Una sola pregunta a la vez
5. Mensajes cortos: 2-3 líneas máximo salvo que necesite más detalle
6. Nunca empieces siempre con "¡Claro!" o "¡Perfecto!" — variá`;
}

// ── INTERPRET ─────────────────────────────────────────────────────────────────
async function interpret({ text, clientCtx, historial = [], step, extraContext }) {
  const systemPrompt = buildClientSystemPrompt(clientCtx, step, extraContext);

  const prompt = `${systemPrompt}

TAREA: Analizá el mensaje y respondé SOLO en JSON válido:
{
  "intent": "RESERVAR|GESTIONAR|CANCELAR|PRECIO|LOYALTY|SALUDO|FAQ|OTRO",
  "servicio": "nombre exacto del catálogo o null",
  "servicio2": "segundo servicio del catálogo o null",
  "dia": "día o null",
  "hora": "HH:MM o null",
  "nombre": "nombre propio o null",
  "email": "email o null",
  "codigo": "código #XXXX o null",
  "texto": "tu respuesta natural a la clienta"
}

CRÍTICO para "texto": Solo mencioná servicios del catálogo. NUNCA alisados, keratina, extensiones, uñas, maquillaje.

Mensaje: "${text}"`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0]?.text || '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { intent: 'OTRO', texto: raw };
    return JSON.parse(jsonMatch[0]);
  } catch(e) {
    console.error('[personal] interpret error:', e.message);
    return { intent: 'OTRO', texto: 'Disculpá, no entendí bien. ¿Podés repetirme? 😊' };
  }
}

// ── GREET ─────────────────────────────────────────────────────────────────────
async function greet({ clientCtx }) {
  const profile = clientCtx?.profile;
  if (!profile || profile.isNewClient) {
    const opts = [
      '¡Hola! 👋 Bienvenida a *Estefan Peluquería* 💛 Soy Estefi. ¿En qué te ayudo?',
      '¡Buenas! Bienvenida a Estefan 🌟 Soy Estefi — para turnos, precios o consultas.',
      '¡Hola! Soy Estefi de *Estefan Peluquería* 💛 ¿En qué te puedo ayudar?',
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }
  const nombre = profile.firstName || '';
  let msg = '';
  if (profile.isVip) msg = `¡${nombre}! 🌟 Siempre un gusto 💛`;
  else if (profile.daysSinceVisit > 60) msg = `¡Hola ${nombre}! ¡Hacía tiempo! ¿Cómo estás? 💛`;
  else msg = [`¡Hola ${nombre}! 💛`, `¡${nombre}! Buenas 😊`, `Hola ${nombre} 💛`][Math.floor(Math.random()*3)];
  if (profile.nextBooking) msg += `\n\nTenés turno de *${profile.nextBooking.servicio}* el *${profile.nextBooking.fecha}* a las *${profile.nextBooking.hora}* 📅`;
  else if (profile.points > 0) msg += `\n\nTenés *${profile.points} puntos* acumulados ⭐`;
  return msg;
}

// ── FAQ SHORTCUTS ─────────────────────────────────────────────────────────────
function handleFAQ(text, clientCtx) {
  const tl = (text || '').toLowerCase();
  const profile = clientCtx?.profile;
  if (!profile) return null;

  if (/cuántos?.*punt|mis punt|punt.*teng/i.test(tl))
    return profile.points > 0
      ? `Tenés *${profile.points} puntos* ⭐ Respondé *puntos* para ver cómo canjearlos 💛`
      : `Todavía no tenés puntos, pero cada servicio te suma más 💛`;

  if (/próximo.*turno|mi turno|cuándo.*turno|tengo.*turno/i.test(tl))
    return profile.nextBooking
      ? `Tu próximo turno:\n\n✂️ *${profile.nextBooking.servicio}*\n📅 ${profile.nextBooking.fecha} · ⏰ ${profile.nextBooking.hora}\n🔖 Código: *${profile.nextBooking.code}*`
      : `No tenés ningún turno agendado. ¿Querés sacar uno? 💛`;

  if (/últimos?.*servicio|qué.*hice|historial|mis.*servicio/i.test(tl))
    return profile.lastServices.length > 0
      ? `Tus últimas visitas:\n\n${profile.lastServices.map(s=>`• ${s.servicio} (${s.fecha})`).join('\n')}`
      : `No tenemos visitas registradas aún 😊`;

  if (/cuántas.*veces|cuántas.*visit/i.test(tl))
    return profile.visitCount > 0
      ? `Llevás *${profile.visitCount} visita${profile.visitCount!==1?'s':''}* en Estefan 💛${profile.isVip?' ¡Sos VIP! 🌟':''}`
      : `¡Esta sería tu primera visita! 💛`;

  return null;
}

module.exports = { interpret, greet, handleFAQ, handleCEO };
