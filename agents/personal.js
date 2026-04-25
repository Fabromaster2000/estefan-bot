// agents/personal.js — Estefi v5
// Sonnet genera lenguaje humano. El orquestador maneja el workflow.
// Cada función recibe el contexto exacto y retorna texto natural.
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
function cbFail() { CB.failures++; CB.lastFailure = Date.now(); if (CB.failures >= 3) CB.open = true; }

// ── Carácter de Estefi ────────────────────────────────────────────────────────
const CARACTER = `Sos Estefi, la asistente de Estefan Peluquería — salón premium de mujeres en Puertos, Buenos Aires.

QUIÉN SOS:
Cálida, elegante, divertida. Hablás como una amiga que trabaja en el mejor salón.
Nunca robótica. Nunca transaccional. Español rioplatense: vos, dale, buenísimo, re bien.

ESTILO:
- Corto siempre: máximo 3 líneas por mensaje
- Una sola pregunta por mensaje, nunca dos
- Variás el inicio — nunca dos mensajes iguales seguidos
- Emojis con criterio: máximo 2-3, que aporten algo
- Nunca "como asistente virtual", nunca "¡Por supuesto!"

SERVICIOS (referencia):
✂️ Corte de pelo $50.000 | Corte + Brushing $70.000 | Brushing/Planchita $20.000 | Lavado + Aireado $15.000
💆 Ozono $30.000 | Head Spa $120.000 | Ampolla $30.000
🎨 Retoque/Raíz $60.000 | Color entero desde $80.000 | Contorno $80.000 | Balayage desde $200.000 | Decoloración desde $200.000
💐 Fiesta/15años desde $60.000 | Novia desde $150.000
Horarios: lunes a sábado 10:00-20:00hs`;

// ── Llamada base a Sonnet ─────────────────────────────────────────────────────
async function _sonnet(instruccion, historialCorto = []) {
  if (!cbOk()) return null;
  try {
    const messages = [...historialCorto.slice(-6), { role: 'user', content: instruccion }];
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: CARACTER,
      messages,
    });
    return resp.content[0]?.text?.trim() || null;
  } catch (err) {
    cbFail();
    console.error('[personal] Sonnet error:', err.message);
    return null;
  }
}

// ── SALUDO INICIAL ────────────────────────────────────────────────────────────
async function generarSaludo(profile) {
  const MENU = `\n\n1️⃣ Sacar un turno\n2️⃣ Ver o cambiar mi turno\n3️⃣ Precios y servicios\n4️⃣ Hablar con el equipo`;

  let instruccion;
  if (profile && !profile.isNewClient && profile.firstName) {
    const extras = [];
    if (profile.nextBooking) extras.push(`tiene turno próximo de ${profile.nextBooking.servicio} el ${profile.nextBooking.fecha}`);
    if (profile.isVip) extras.push('es clienta VIP');
    instruccion = `Saludá a ${profile.firstName} de forma cálida y personal — ya la conocés, vino ${profile.visitCount} veces. ${extras.join(', ')}. Después mostrá las opciones del menú de forma natural (incluí los números emoji). Sé breve.`;
  } else {
    instruccion = `Es la primera vez que esta clienta escribe. Presentate como Estefi de Estefan Peluquería con personalidad y calidez. Mostrá las opciones del menú de forma natural y atractiva (incluí los números emoji 1️⃣2️⃣3️⃣4️⃣). Sé breve y memorable.`;
  }

  const texto = await _sonnet(instruccion);
  // Fallback garantizado con menú siempre incluido
  return texto || `¡Hola! Bienvenida a *Estefan Peluquería* 💛 Soy Estefi.${MENU}`;
}

// ── PRECIOS ───────────────────────────────────────────────────────────────────
// Retorna la lista hardcodeada + invitación conversacional de Sonnet
async function responderPrecios(mensajeCliente, historial = []) {
  const lista =
    `💈 *Servicios y Precios — Estefan Peluquería*\n\n` +
    `✂️ *Cortes*\n  • Corte de pelo: *$50.000* _(incluye lavado y aireado)_\n  • Corte + Brushing: *$70.000*\n  • Brushing / Planchita: *$20.000*\n  • Lavado + Aireado: *$15.000*\n\n` +
    `🎨 *Color* _(consulta previa requerida)_\n  • Retoque / Raíz: *$60.000*\n  • Color entero: *desde $80.000*\n  • Contorno: *$80.000*\n  • Balayage: *desde $200.000*\n  • Decoloración total: *desde $200.000*\n\n` +
    `💆 *Tratamientos*\n  • Ozono capilar: *$30.000* _(15 min, se suma a cualquier servicio)_\n  • Head Spa completo: *$120.000*\n  • Ampolla reparadora: *$30.000*\n\n` +
    `💐 *Peinados* _(requieren seña)_\n  • Fiesta / 15 años: *desde $60.000*\n  • Novia: *desde $150.000*`;

  const cierre = await _sonnet(
    `La clienta preguntó por precios y se los mostramos. Escribí UNA línea de cierre cálida que la invite a reservar o a preguntar qué le llama la atención. No repitas precios. Muy breve.`,
    historial
  );

  return lista + `\n\n${cierre || '_¿Alguno te llama la atención? Escribime y te cuento más 💛_'}`;
}

// ── INICIO DE RESERVA ─────────────────────────────────────────────────────────
async function iniciarReserva(profile, historial = []) {
  const extras = profile?.favoriteService
    ? `Su servicio favorito es ${profile.favoriteService}.`
    : '';
  const texto = await _sonnet(
    `La clienta quiere sacar un turno. ${extras} Dales la bienvenida al proceso con entusiasmo y preguntale qué servicio quiere. Una sola pregunta. Breve y cálida.`,
    historial
  );
  return texto || '¡Buenísimo! ✨ ¿Qué servicio te gustaría hacerte?';
}

// ── CELEBRAR SERVICIO ELEGIDO + PREGUNTAR DÍA ────────────────────────────────
async function celebrarServicioYPedirDia(servicio, extra, profile, historial = []) {
  const srvStr = servicio.nombre + (extra ? ` + ${extra.nombre}` : '');
  const habitual = profile?.usualDay ? ` Habitualmente viene los ${profile.usualDay}.` : '';
  const texto = await _sonnet(
    `La clienta eligió: ${srvStr}. Celebrá la elección con entusiasmo genuino y preguntale qué día le viene bien. Atendemos lunes a sábado de 10 a 20hs.${habitual} Una sola pregunta. Breve.`,
    historial
  );
  return texto || `¡Buena elección! ✨ ¿Qué día te viene bien?\n\nAtendemos *lunes a sábado de 10:00 a 20:00hs*`;
}

// ── PEDIR HORA ────────────────────────────────────────────────────────────────
async function pedirHora(dia, servicio, profile, historial = []) {
  const habitual = profile?.usualTime ? ` Habitualmente viene a las ${profile.usualTime}.` : '';
  const texto = await _sonnet(
    `Ya sabemos que el turno es el ${dia} de ${servicio.nombre}. Preguntale a qué hora. Horario disponible: 10:00 a 20:00hs.${habitual} Muy breve.`,
    historial
  );
  return texto || `⏰ ¿A qué hora el ${dia}? Tenemos disponibilidad de 10:00 a 20:00hs`;
}

// ── PEDIR NOMBRE ──────────────────────────────────────────────────────────────
async function pedirNombre(servicio, dia, hora, historial = []) {
  const texto = await _sonnet(
    `Tenemos ${servicio.nombre} para el ${dia} a las ${hora}. Solo nos falta el nombre para anotar el turno. Pedíselo de forma breve y cálida.`,
    historial
  );
  return texto || '¿Me decís tu nombre para anotar el turno? 😊';
}

// ── OFRECER UPSELL ────────────────────────────────────────────────────────────
async function ofrecerUpsell(servicioPrincipal, servicioExtra, historial = []) {
  // Argumentos específicos por upsell
  const BENEFICIOS = {
    'Ampolla':           'hidrata en profundidad, sella la cutícula y deja el pelo suave y sin frizz',
    'Ozono':             'son 15 minutitos y el pelo queda con otro brillo y textura — lo nota todo el mundo',
    'Head Spa completo': 'es una experiencia increíble: limpieza profunda del cuero cabelludo, masajes, hidratación total',
  };
  const beneficio = BENEFICIOS[servicioExtra.nombre] || 'potencia el resultado del servicio';
  const texto = await _sonnet(
    `La clienta está por sacar turno de ${servicioPrincipal.nombre}. Ofrecele agregar ${servicioExtra.nombre} ($${servicioExtra.precio.toLocaleString('es-AR')}) como complemento. El beneficio: ${beneficio}. Ofrecelo como una amiga que recomienda algo bueno, no como un vendedor. Breve, con convicción. Una pregunta al final.`,
    historial
  );
  return texto || `¿Le sumamos una *${servicioExtra.nombre}*? ${beneficio} — son $${servicioExtra.precio.toLocaleString('es-AR')} más 💛`;
}

// ── PEDIR EMAIL ───────────────────────────────────────────────────────────────
async function pedirEmail(nombre, historial = []) {
  const texto = await _sonnet(
    `${nombre ? nombre + ' confirmó' : 'Confirmó'} el turno. Pedile el email para mandarle la confirmación con todos los detalles. Mencioná que le mandamos el código por ahí también. Muy breve, una sola línea.`,
    historial
  );
  return texto || `¿Me dejás tu email? Te mando la confirmación con todos los detalles 📧\n_(o escribí *no* para saltear)_`;
}

// ── TURNO CONFIRMADO ──────────────────────────────────────────────────────────
// Esta función retorna el string hardcodeado — datos críticos nunca los toca Sonnet
function turnoConfirmado(nombre, servicio, fechaDisplay, hora, code, pointsEarned) {
  let msg = `✅ *¡Turno confirmado${nombre ? ', ' + nombre : ''}!* 💛\n\n`;
  msg += `📅 ${fechaDisplay}\n`;
  msg += `⏰ ${hora}\n`;
  msg += `✂️ ${servicio}\n`;
  msg += `🔖 Código: *${code}*\n\n`;
  msg += `_Guardá el código — con ese podés cambiar o cancelar cuando quieras_ 😊`;
  if (pointsEarned > 0) msg += `\n⭐ Ganaste *+${pointsEarned} puntos*`;
  return msg;
}

// ── SEÑA REQUERIDA ────────────────────────────────────────────────────────────
function senaRequerida(nombre, servicio, fechaDisplay, hora, code, montoSena, mpLink) {
  let msg = `⏳ *Turno registrado${nombre ? ', ' + nombre : ''}* 💛\n\n`;
  msg += `📅 ${fechaDisplay}\n⏰ ${hora}\n✂️ ${servicio}\n🔖 Código: *${code}*\n\n`;
  msg += `⚠️ *Para confirmar necesitamos una seña de $${montoSena}*\n`;
  msg += mpLink
    ? `Podés pagarla acá 👇\n${mpLink}\n\n_Una vez recibido el pago te llega la confirmación_ 📧`
    : `Coordinamos el pago cuando vengas o por acá 💛`;
  return msg;
}

// ── RESUMEN PARA CONFIRMAR ────────────────────────────────────────────────────
function resumenConfirmar(d) {
  const base = d.servicio.precio + (d.extra?.precio || 0);
  let msg = `📋 *Resumen de tu turno:*\n\n`;
  if (d.nombre) msg += `👤 *${d.nombre}*\n`;
  msg += `✂️ ${d.servicio.nombre}`;
  if (d.extra) msg += ` + ${d.extra.nombre}`;
  msg += `\n📅 ${d.dia} · ⏰ ${d.hora}\n`;
  msg += `💰 $${base.toLocaleString('es-AR')}`;
  if (d.extra) msg += ` _(${d.servicio.nombre} $${d.servicio.precio.toLocaleString('es-AR')} + ${d.extra.nombre} $${d.extra.precio.toLocaleString('es-AR')})_`;
  if (d.servicio.seña) {
    const seña = Math.round(base * (d.servicio.pct || 10) / 100).toLocaleString('es-AR');
    msg += `\n⚠️ Requiere seña del ${d.servicio.pct}% — $${seña}`;
  }
  const pts = Math.floor(base / 1000);
  if (pts > 0) msg += `\n⭐ Ganás *+${pts} puntos* con este turno`;
  msg += `\n\n¿Confirmamos? *(sí / no)*`;
  return msg;
}

// ── TURNO ENCONTRADO ──────────────────────────────────────────────────────────
function turnoEncontrado(b) {
  return (
    `📋 *Tu turno:*\n\n` +
    `👤 ${b.nombre}\n✂️ ${b.servicio}\n📅 ${b.fecha} · ⏰ ${b.hora}\n🔖 ${b.code}\n\n` +
    `¿Qué querés hacer?\n1️⃣ Cambiar fecha/hora\n2️⃣ Cancelar turno\n3️⃣ Volver`
  );
}

// ── RESPUESTA LIBRE (fallback) ────────────────────────────────────────────────
async function responderLibre(mensaje, historial = [], contextoCliente = '') {
  if (!cbOk()) return 'Perdoná, tenemos alta demanda. Escribinos en unos minutos 🙏';
  const system = contextoCliente ? `${CARACTER}\n\n## ESTA CLIENTA\n${contextoCliente}` : CARACTER;
  try {
    const messages = [
      ...historial.slice(-10).filter(h => h.role && h.content),
      { role: 'user', content: mensaje },
    ];
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 400, system, messages,
    });
    return resp.content[0]?.text?.trim() || '¿En qué más te puedo ayudar? 💛';
  } catch (err) {
    cbFail();
    console.error('[personal] responderLibre error:', err.message);
    return 'Perdón, tuve un problema técnico. ¿Podés repetir? 🙏';
  }
}

// ── CEO MODE ──────────────────────────────────────────────────────────────────
async function handleCEO(text, historial = []) {
  const db = getDB();
  let stats = 'Sin datos.';
  if (db) {
    try {
      const [bk, pay, cl] = await Promise.all([
        db.query(`SELECT COUNT(*) FILTER (WHERE status='Confirmado') as confirmados, COUNT(*) FILTER (WHERE status='Cancelado') as cancelados, COUNT(*) FILTER (WHERE date_str=TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY')) as hoy FROM bookings`).then(r=>r.rows[0]).catch(()=>({})),
        db.query(`SELECT COALESCE(SUM(total) FILTER (WHERE created_at::date=NOW()::date),0) as hoy, COALESCE(SUM(total) FILTER (WHERE created_at>=NOW()-INTERVAL '7 days'),0) as semana, COALESCE(AVG(total),0) as ticket FROM payments WHERE status!='mp_pending'`).then(r=>r.rows[0]).catch(()=>({})),
        db.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE visit_count>=1) as activos FROM clients`).then(r=>r.rows[0]).catch(()=>({})),
      ]);
      stats = `Turnos hoy=${bk.hoy||0} confirmados=${bk.confirmados||0} cancelados=${bk.cancelados||0}\nIngresos hoy=$${Number(pay.hoy||0).toLocaleString('es-AR')} semana=$${Number(pay.semana||0).toLocaleString('es-AR')} ticket=$${Math.round(Number(pay.ticket||0)).toLocaleString('es-AR')}\nClientes total=${cl.total||0} activos=${cl.activos||0}`;
    } catch {}
  }
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 600,
    system: `Sos Estefi, asistente del dueño de Estefan Peluquería. Directo, con datos reales.\n\n${stats}`,
    messages: [...historial.slice(-6).map(h=>({role:h.role,content:h.content})), {role:'user',content:text}],
  });
  return resp.content[0]?.text || 'No pude procesar eso 😅';
}

// ── FAQ directos ──────────────────────────────────────────────────────────────
function handleFAQ(texto, clientCtx) {
  const tl = (texto || '').toLowerCase();
  const p = clientCtx?.profile;
  if (!p) return null;
  if (/cuántos?.*punt|mis punt|punt.*teng/i.test(tl))
    return p.points > 0
      ? `¡Tenés *${p.points} puntos* acumulados! ⭐ Escribí *puntos* para ver cómo canjearlos 💛`
      : 'Todavía no tenés puntos, pero cada servicio suma 💛';
  if (/próximo.*turno|mi turno|cuándo.*turno|tengo.*turno/i.test(tl))
    return p.nextBooking
      ? `Tu próximo turno:\n\n✂️ *${p.nextBooking.servicio}*\n📅 ${p.nextBooking.fecha} a las ${p.nextBooking.hora}\n🔖 Código: *${p.nextBooking.code}*\n\n¿Necesitás cambiar algo? 💛`
      : 'No tenés ningún turno agendado. ¿Lo sacamos ahora? 💛';
  if (/últimos?.*servicio|qué.*hice|historial/i.test(tl))
    return p.lastServices?.length > 0
      ? `Tus últimas visitas:\n\n${p.lastServices.map(s=>`• ${s.servicio} (${s.fecha})`).join('\n')}\n\n¡Siempre un gusto! 💛`
      : 'No tenemos visitas registradas todavía 😊';
  return null;
}

module.exports = {
  generarSaludo, responderPrecios, iniciarReserva,
  celebrarServicioYPedirDia, pedirHora, pedirNombre,
  ofrecerUpsell, pedirEmail,
  turnoConfirmado, senaRequerida, resumenConfirmar, turnoEncontrado,
  responderLibre, handleCEO, handleFAQ,
};