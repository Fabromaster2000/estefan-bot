// ── AGENT: MEMORY ─────────────────────────────────────────────────────────────
// Responsabilidad única: construir y actualizar la memoria del cliente.
// Se ejecuta en background después de cada conversación significativa.
// No bloquea la respuesta al cliente — corre async.

const axios = require('axios');
const { memoryGet, memoryUpdate, bookingGetByPhone, conversationGetRecent } = require('../core/db');

async function update(phone, clientData, newInteraction) {
  try {
    const existing = await memoryGet(phone);
    const recentBookings = await bookingGetByPhone(phone, 10);
    const recentConvos = await conversationGetRecent(phone, 30);

    const serviceCounts = {};
    for (const b of recentBookings) {
      serviceCounts[b.service] = (serviceCounts[b.service] || 0) + 1;
    }
    const favoriteServices = Object.entries(serviceCounts)
      .sort((a,b) => b[1]-a[1])
      .slice(0,3)
      .map(([s,c]) => `${s} (${c}x)`)
      .join(', ');

    // Usar Haiku para actualizar el resumen de forma inteligente
    const summary = await buildSummary({
      clientData,
      existing,
      recentBookings,
      recentConvos,
      newInteraction,
    });

    await memoryUpdate(phone, {
      summary,
      favoriteServices,
      visitPatterns: buildVisitPattern(recentBookings),
      personalityNotes: existing?.personality_notes || null,
    });

    console.log(`[memory] ✓ Memoria actualizada para ${phone}`);
  } catch(e) {
    console.error('[memory] Error actualizando:', e.message);
  }
}

async function buildSummary({ clientData, existing, recentBookings, recentConvos, newInteraction }) {
  if (!process.env.ANTHROPIC_API_KEY) return existing?.summary || null;

  const prompt = `Sos el sistema de memoria de Estefan Peluquería. 
Actualizá el resumen del cliente basándote en la nueva interacción.
Sé conciso (máx 3 oraciones). Incluí: servicios preferidos, frecuencia, notas útiles.

Resumen anterior: ${existing?.summary || 'ninguno'}
Cliente: ${clientData?.name || 'sin nombre'}, ${clientData?.visit_count || 0} visitas, $${clientData?.total_spent?.toLocaleString('es-AR') || 0} total
Últimos turnos: ${recentBookings.slice(0,3).map(b=>`${b.service} (${b.date_str})`).join(', ') || 'ninguno'}
Nueva interacción: ${newInteraction || 'conversación general'}

Devolvé SOLO el resumen actualizado, sin explicaciones.`;

  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return res.data.content?.[0]?.text?.trim() || existing?.summary || null;
  } catch(e) {
    return existing?.summary || null;
  }
}

function buildVisitPattern(bookings) {
  if (bookings.length < 2) return null;
  const dates = bookings.map(b => new Date(b.created_at)).filter(Boolean).sort((a,b) => b-a);
  if (dates.length < 2) return null;
  const gaps = [];
  for (let i = 0; i < dates.length - 1; i++) {
    gaps.push((dates[i] - dates[i+1]) / (1000*60*60*24));
  }
  const avg = Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length);
  return `Viene cada ~${avg} días en promedio`;
}

module.exports = { update };
