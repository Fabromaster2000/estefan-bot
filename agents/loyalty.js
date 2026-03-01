// ── AGENT: LOYALTY ────────────────────────────────────────────────────────────
// Responsabilidad única: puntos, beneficios y canjes.
// 1 punto cada $1.000 gastados. Estructura preparada para escalar.

const { loyaltyGetBalance, loyaltyGetRewards, loyaltyRedeem, loyaltyGetTransactions } = require('../core/db');

// Mostrar saldo y beneficios disponibles
async function showBalance(phone) {
  const points  = await loyaltyGetBalance(phone);
  const rewards = await loyaltyGetRewards();
  const available = rewards.filter(r => r.points_cost <= points);

  let msg = `⭐ *Tus beneficios:*\n\n`;
  msg += `Puntos acumulados: *${points} pts*\n`;
  msg += `_(Ganás 1 punto por cada $1.000 gastados)_\n\n`;

  if (available.length > 0) {
    msg += `🎁 *Podés canjear:*\n`;
    available.forEach((r, i) => {
      msg += `  ${i+1} — ${r.name} · *${r.points_cost} pts*\n`;
      if (r.description) msg += `     _${r.description}_\n`;
    });
  } else if (rewards.length > 0) {
    const next = rewards.find(r => r.points_cost > points);
    if (next) {
      msg += `Próximo beneficio: *${next.name}*\n`;
      msg += `Te faltan *${next.points_cost - points} pts* (≈ $${((next.points_cost - points) * 1000).toLocaleString('es-AR')} más en servicios)`;
    }
  }

  return { points, available, msg };
}

// Mostrar historial de puntos
async function showHistory(phone) {
  const transactions = await loyaltyGetTransactions(phone, 10);
  const points = await loyaltyGetBalance(phone);

  if (transactions.length === 0) {
    return `No tenés transacciones de puntos todavía.\n¡Empezá a acumular en tu próxima visita! ⭐`;
  }

  let msg = `📋 *Historial de puntos:*\n\n`;
  msg += `Saldo actual: *${points} pts*\n\n`;
  for (const t of transactions) {
    const signo = t.type === 'earn' ? '+' : '';
    const fecha = new Date(t.created_at).toLocaleDateString('es-AR');
    msg += `${t.type === 'earn' ? '⬆️' : '⬇️'} *${signo}${t.points} pts* — ${t.description} _(${fecha})_\n`;
  }
  return msg;
}

// Canjear un beneficio
async function redeem(phone, rewardId) {
  const result = await loyaltyRedeem(phone, rewardId);
  if (!result.ok) {
    return { ok: false, msg: `No se pudo canjear: ${result.error}` };
  }
  const msg = `✅ *¡Canje exitoso!* 🎉\n\n🎁 ${result.reward.name}\n⭐ Puntos restantes: *${result.remainingPoints} pts*\n\n_Mostrá este mensaje en el local para usar tu beneficio_ 💛`;
  return { ok: true, msg, reward: result.reward };
}

// Calcular puntos que va a ganar con el servicio actual
function previewPoints(monto) {
  const pts = Math.floor(monto / 1000);
  if (pts === 0) return null;
  return `+${pts} pts`;
}

module.exports = { showBalance, showHistory, redeem, previewPoints };
