// ── AGENT: UPSELL ─────────────────────────────────────────────────────────────
// Responsabilidad única: ofrecer extras en el momento justo.
// Conoce qué combinaciones funcionan bien y cuándo ofrecerlas.
// Se activa después de confirmar el servicio principal.

const SERVICIOS = require('../core/servicios');

// Mapa de upsells: qué ofrecer después de cada servicio
const UPSELL_MAP = {
  1:  { targetId: 7,  msg: '¿Le sumamos una *ampolla reparadora*? Queda espectacular después del corte ✨ (+$30.000)\n\n1 — Sí\n2 — No' },
  2:  { targetId: 7,  msg: '¿Agregamos una *ampolla* para potenciar el resultado del corte? (+$30.000)\n\n1 — Sí\n2 — No' },
  3:  { targetId: 7,  msg: '¿Sumamos una *ampolla* para el cabello? (+$30.000)\n\n1 — Sí\n2 — No' },
  8:  { targetId: 7,  msg: '¿Sumamos una *ampolla reparadora* para después del color? Muy recomendado 💛 (+$30.000)\n\n1 — Sí\n2 — No' },
  9:  { targetId: 7,  msg: '¿Sumamos una *ampolla reparadora*? Ideal para proteger el color (+$30.000)\n\n1 — Sí\n2 — No' },
  10: { targetId: 7,  msg: '¿Agregamos una *ampolla* para fijar el contorno? (+$30.000)\n\n1 — Sí\n2 — No' },
  11: { targetId: 6,  msg: '¿Querés agregar un *Head Spa completo*? Ideal para el cuero cabelludo después del balayage (+$120.000)\n\n1 — Sí\n2 — No' },
  12: { targetId: 6,  msg: '¿Sumamos un *Head Spa completo*? Muy recomendado después de la decoloración (+$120.000)\n\n1 — Sí\n2 — No' },
  13: { targetId: 7,  msg: '¿Agregamos una *ampolla* para que el peinado dure más? (+$30.000)\n\n1 — Sí\n2 — No' },
  14: { targetId: 7,  msg: '¿Sumamos una *ampolla premium* para el gran día? (+$30.000)\n\n1 — Sí\n2 — No' },
};

function getUpsell(servicioId) {
  const upsell = UPSELL_MAP[servicioId];
  if (!upsell) return null;
  const target = SERVICIOS.find(s => s.id === upsell.targetId);
  if (!target) return null;
  return { ...upsell, servicio: target };
}

// Upsell personalizado basado en historial del cliente
function getPersonalizedUpsell(servicioId, clientHistory = []) {
  const base = getUpsell(servicioId);
  if (!base) return null;

  // Si el cliente ya compró este upsell antes, mencionarlo
  const prevPurchased = clientHistory.some(b => b.service?.includes(base.servicio.nombre));
  if (prevPurchased) {
    return {
      ...base,
      msg: base.msg.replace('?', ', como la última vez,') + '\n_(Lo tomaste antes y quedó genial)_',
    };
  }
  return base;
}

module.exports = { getUpsell, getPersonalizedUpsell, UPSELL_MAP };
