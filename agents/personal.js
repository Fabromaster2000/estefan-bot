// agents/personal.js — Estefi v3
// Arquitectura limpia: personal.js es el cerebro conversacional.
// Sonnet para respuestas. Haiku solo para extracción de datos estructurados.
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

// ── Prompt base de Estefi ─────────────────────────────────────────────────────
const SYSTEM = `Sos Estefi, la asistente de Estefan Peluquería — salón premium de mujeres en Puertos, Buenos Aires.

## QUIÉN SOS
Cálida, elegante, genuinamente apasionada por hacer que cada clienta se sienta especial.
Hablás como una amiga experta — nunca como un robot o un chatbot genérico.
Español rioplatense: vos, dale, buenísimo, divino.

## SERVICIOS Y PRECIOS (esto es TODO lo que ofrecemos)
✂️ Cortes:
  • Corte de pelo — $50.000 (incluye lavado y aireado)
  • Corte + Brushing — $70.000
  • Brushing / Planchita — $20.000
  • Lavado + Aireado — $15.000

💆 Tratamientos:
  • Ozono capilar — $30.000 (15 min, complementa cualquier servicio)
  • Head Spa completo — $120.000
  • Ampolla reparadora — $30.000

🎨 Color (requieren consulta previa del equipo):
  • Retoque / Raíz — $60.000
  • Color entero — desde $80.000
  • Contorno — $80.000
  • Balayage — desde $200.000
  • Decoloración total — desde $200.000

💐 Peinados (requieren seña):
  • Fiesta / 15 años — desde $60.000
  • Novia — desde $150.000

NO ofrecemos: alisados, keratina, botox capilar, extensiones, uñas, maquillaje, cejas, masajes.
Si preguntan por eso: decís que no lo ofrecemos y sugerís una alternativa real del catálogo.

Horarios: lunes a sábado, 10:00 a 20:00hs. Puertos, Buenos Aires.

## TUS REGLAS DE ORO
1. SIEMPRE recordás lo que la clienta ya dijo. Si mencionó servicio, día, hora — lo usás, no lo volvés a preguntar.
2. NUNCA repetís el menú (1️⃣2️⃣3️⃣4️⃣) dentro de una conversación activa.
3. Respuestas cortas: 2-3 líneas. Una sola pregunta por mensaje.
4. No empezás siempre con "¡Claro!" — variás el saludo.
5. Upsell con gracia: el ozono o ampolla son complementos naturales, no presión de venta.
6. Para servicios de color: explicás con entusiasmo por qué necesitan consulta.

## LO QUE NUNCA HACÉS
❌ "¿Qué servicio querés?" si ya lo dijeron
❌ "¿Qué día te viene bien?" si ya lo dijeron
❌ Repetir el menú numerado si la conversación ya avanzó
❌ Más de 3 párrafos
❌ "Como asistente virtual..."
❌ Más de 3 emojis por mensaje`;

// ── greet ─────────────────────────────────────────────────────────────────────
// Retorna SIEMPRE saludo + menú completo.
function greet(nombre) {
  const saludo = nombre
    ? `¡Hola ${nombre}! 💛 Bienvenida a Estefan.`
    : `¡Hola! Bienvenida a *Estefan Peluquería* 💛`;

  return (
    saludo +
    '\n\nSoy Estefi, ¿en qué te puedo ayudar?\n\n' +
    '1️⃣ Sacar un turno\n' +
    '2️⃣ Ver o cambiar mi turno\n' +
    '3️⃣ Precios y servicios\n' +
    '4️⃣ Hablar con el equipo'
  );
}

// ── responder ─────────────────────────────────────────────────────────────────
// Llamada a Sonnet para conversación libre y natural.
// Se usa cuando el orquestador no tiene respuesta hardcodeada.
async function responder({ mensaje, historial = [], contextoExtra = '' }) {
  if (!cbOk()) return 'En este momento tenemos alta demanda. Escribinos en unos minutos 🙏';

  const messages = [];
  for (const h of (historial || []).slice(-10)) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: mensaje });

  const system = contextoExtra ? SYSTEM + '\n\nCONTEXTO DE ESTA CLIENTA:\n' + contextoExtra : SYSTEM;

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system,
      messages,
    });
    return (resp.content[0]?.text || '').trim();
  } catch (err) {
    cbFail();
    console.error('[personal] Error Claude:', err.message);
    return 'Perdón, tuve un problema técnico. ¿Podés repetir? 🙏';
  }
}

// ── extractData ───────────────────────────────────────────────────────────────
// Haiku liviano para extraer datos estructurados del texto.
// Retorna: { intent, servicio, servicio2, dia, hora, nombre, email }
async function extractData(texto) {
  if (!cbOk()) return {};

  const prompt = `Extraé datos del siguiente mensaje de una clienta de peluquería.
Respondé SOLO con JSON válido, sin texto adicional ni explicaciones:
{
  "intent": "RESERVAR|VER_TURNO|PRECIOS|DERIVAR|SALUDO|FAQ|OTRO",
  "servicio": "nombre exacto del catálogo o null",
  "servicio2": "segundo servicio mencionado o null",
  "dia": "día mencionado en texto libre o null",
  "hora": "HH:MM o null",
  "nombre": "nombre propio de la clienta o null",
  "email": "dirección email o null"
}

Catálogo: Corte de pelo, Corte + Brushing, Brushing / Planchita, Lavado + Aireado, Ozono, Head Spa completo, Ampolla, Retoque / Raíz, Color entero, Contorno, Balayage, Decoloración total, Peinado fiesta / 15, Peinado novia.

Mensaje: "${texto.replace(/"/g, '\\"')}"`;

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = resp.content[0]?.text || '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

// ── handleCEO ─────────────────────────────────────────────────────────────────
async function handleCEO(text, historial = []) {
  const db = getDB();
  let statsBlock = 'Sin datos disponibles.';
  if (db) {
    try {
      const [bk, pay, cl] = await Promise.all([
        db.query(`SELECT
          COUNT(*) FILTER (WHERE status='Confirmado') as confirmados,
          COUNT(*) FILTER (WHERE status='Completado') as completados,
          COUNT(*) FILTER (WHERE status='Cancelado') as cancelados,
          COUNT(*) FILTER (WHERE date_str=TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY')) as hoy
          FROM bookings`).then(r => r.rows[0]).catch(() => ({})),
        db.query(`SELECT
          COALESCE(SUM(total) FILTER (WHERE created_at::date = NOW()::date), 0) as hoy,
          COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0) as semana,
          COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0) as mes,
          COALESCE(AVG(total), 0) as ticket
          FROM payments WHERE status != 'mp_pending'`).then(r => r.rows[0]).catch(() => ({})),
        db.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE visit_count >= 1) as activos FROM clients`).then(r => r.rows[0]).catch(() => ({})),
      ]);
      statsBlock = `Turnos hoy: ${bk.hoy||0} | Confirmados: ${bk.confirmados||0} | Cancelados: ${bk.cancelados||0}
Ingresos hoy: $${Number(pay.hoy||0).toLocaleString('es-AR')} | Semana: $${Number(pay.semana||0).toLocaleString('es-AR')} | Mes: $${Number(pay.mes||0).toLocaleString('es-AR')} | Ticket prom: $${Math.round(Number(pay.ticket||0)).toLocaleString('es-AR')}
Clientes: ${cl.total||0} total | ${cl.activos||0} activos`;
    } catch { /* statsBlock ya tiene fallback */ }
  }

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: `Sos Estefi, asistente directa del dueño de Estefan Peluquería. Respondés con datos reales, directo al punto, en español.\n\nDATA EN TIEMPO REAL:\n${statsBlock}`,
    messages: [
      ...historial.slice(-6).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: text },
    ],
  });
  return resp.content[0]?.text || 'No pude procesar eso 😅';
}

// ── handleFAQ ─────────────────────────────────────────────────────────────────
function handleFAQ(texto, clientCtx) {
  const tl = (texto || '').toLowerCase();
  const profile = clientCtx?.profile;
  if (!profile) return null;

  if (/cuántos?.*punt|mis punt|punt.*teng/i.test(tl))
    return profile.points > 0
      ? `Tenés *${profile.points} puntos* ⭐ Respondé *puntos* para ver cómo canjearlos 💛`
      : 'Todavía no tenés puntos, pero cada servicio te suma 💛';

  if (/próximo.*turno|mi turno|cuándo.*turno|tengo.*turno/i.test(tl))
    return profile.nextBooking
      ? `Tu próximo turno:\n\n✂️ *${profile.nextBooking.servicio}*\n📅 ${profile.nextBooking.fecha} · ⏰ ${profile.nextBooking.hora}\n🔖 Código: *${profile.nextBooking.code}*`
      : 'No tenés ningún turno agendado. ¿Querés sacar uno? 💛';

  if (/últimos?.*servicio|qué.*hice|historial|mis.*servicio/i.test(tl))
    return profile.lastServices?.length > 0
      ? `Tus últimas visitas:\n\n${profile.lastServices.map(s => `• ${s.servicio} (${s.fecha})`).join('\n')}`
      : 'No tenemos visitas registradas todavía 😊';

  return null;
}

// ── detectarServicioColor ─────────────────────────────────────────────────────
function detectarServicioColor(texto) {
  return /balayage|balaige|decolor|mechas|mechitas|raiz|raíz|retoque|contorno|\bcolor\b|tintura|teñi|tinte/i.test(texto || '');
}

module.exports = { greet, responder, extractData, handleCEO, handleFAQ, detectarServicioColor };