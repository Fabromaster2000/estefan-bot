// ── AGENT: INTAKE ─────────────────────────────────────────────────────────────
// Responsabilidad única: identificar al cliente, crear o recuperar su perfil.
// Se activa cuando un cliente escribe por primera vez o no está identificado.
// Devuelve { identified: bool, client: {...}, isNew: bool }

const { clientGet, clientUpsert, memoryGet } = require('../core/db');

async function run({ phone, name = null }) {
  // Buscar cliente existente
  let client = await clientGet(phone);
  const isNew = !client;

  if (isNew) {
    // Crear perfil básico
    await clientUpsert(phone, name);
    client = await clientGet(phone);
  } else if (name && !client.name) {
    // Actualizar nombre si lo teníamos pendiente
    await clientUpsert(phone, name);
    client = await clientGet(phone);
  }

  // Cargar memoria si existe
  const memory = await memoryGet(phone);

  return {
    identified: true,
    isNew,
    client: {
      ...client,
      memory: memory || null,
    }
  };
}

// Construir contexto del cliente para pasarle a otros agentes
async function buildContext(phone) {
  const client = await clientGet(phone);
  if (!client) return null;

  const memory = await memoryGet(phone);
  const { bookingGetByPhone, loyaltyGetBalance } = require('../core/db');
  const recentBookings = await bookingGetByPhone(phone, 5);
  const points = await loyaltyGetBalance(phone);

  let ctx = '';
  if (client.name) ctx += `Cliente: ${client.name}${client.last_name ? ' ' + client.last_name : ''}\n`;
  if (client.visit_count > 0) ctx += `Visitas: ${client.visit_count} · Total gastado: $${client.total_spent?.toLocaleString('es-AR')}\n`;
  if (points > 0) ctx += `Puntos de beneficios: ${points} pts\n`;
  if (recentBookings.length > 0) {
    ctx += `Últimos servicios: ${recentBookings.map(b => `${b.service} (${b.date_str})`).join(', ')}\n`;
  }
  if (memory?.summary) ctx += `Notas: ${memory.summary}\n`;
  if (memory?.favorite_services) ctx += `Servicios favoritos: ${memory.favorite_services}\n`;
  if (memory?.personality_notes) ctx += `Personalidad: ${memory.personality_notes}\n`;

  return { client, memory, recentBookings, points, context: ctx.trim() };
}

module.exports = { run, buildContext };
