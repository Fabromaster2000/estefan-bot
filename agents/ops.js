// ── AGENTE: OPS ───────────────────────────────────────────────────────────────
// El chat de operación del salón. La administrativa escribe en castellano lo que
// pasó y este agente lo traduce a escrituras en la base.
//
// Diferencia con el resto de los agentes: este NO habla con clientas. Habla con
// la persona que atiende el mostrador y tiene permiso de escribir en todo.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../core/db');
const ops       = require('../core/ops_tools');
const { BOT }   = require('../core/marca');

const MODEL       = process.env.OPS_MODEL || 'claude-sonnet-4-5';
const MAX_TURNS   = 12;   // vueltas de tool_use por mensaje
const MAX_HISTORY = 30;   // mensajes de contexto del chat de staff

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Historial en memoria por operador. Se persiste en ops_conversations aparte.
const sesiones = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT EN VIVO
// Se inyecta en cada mensaje. Es lo que hace que el agente ya sepa cómo viene
// el día sin tener que preguntar.
// ─────────────────────────────────────────────────────────────────────────────

async function snapshot() {
  const hoy = ops.hoyStr();
  const q   = db.getDB();
  if (!q) return `Fecha de hoy: ${hoy}. (Base de datos no disponible.)`;

  const [turnos, esperando, saldos, caja] = await Promise.all([
    q.query(`SELECT id, time_str, client_name, client_phone, service, monto, status
             FROM bookings WHERE date_str=$1 AND cancelled_at IS NULL
             ORDER BY time_str ASC`, [hoy]).catch(() => ({ rows: [] })),
    q.query(`SELECT DISTINCT ON (cl.phone) cl.phone, c.name, c.last_name, cl.content, cl.created_at
             FROM conversation_log cl
             LEFT JOIN clients c ON c.phone = cl.phone
             WHERE cl.role='user' AND cl.created_at > NOW() - INTERVAL '12 hours'
               AND NOT EXISTS (
                 SELECT 1 FROM conversation_log r
                 WHERE r.phone=cl.phone AND r.role<>'user' AND r.created_at > cl.created_at
               )
             ORDER BY cl.phone, cl.created_at DESC LIMIT 12`).catch(() => ({ rows: [] })),
    q.query(`SELECT client_name, SUM(saldo) AS saldo FROM payments
             WHERE saldo > 0 GROUP BY client_name ORDER BY saldo DESC LIMIT 8`).catch(() => ({ rows: [] })),
    q.query(`SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(monto_pagado,total)),0) AS cobrado
             FROM payments WHERE fecha_str=$1`, [hoy]).catch(() => ({ rows: [{ n: 0, cobrado: 0 }] })),
  ]);

  const lineas = [];
  lineas.push(`FECHA DE HOY: ${hoy}`);
  lineas.push('');
  lineas.push(`AGENDA DE HOY (${turnos.rows.length} turnos):`);
  if (!turnos.rows.length) lineas.push('  (sin turnos cargados)');
  for (const t of turnos.rows) {
    lineas.push(`  [id ${t.id}] ${t.time_str} · ${t.client_name} · ${t.service} · ${ops.money(t.monto)} · ${t.status}`);
  }
  lineas.push('');
  lineas.push(`CAJA DE HOY: ${caja.rows[0].n} cobros · ${ops.money(caja.rows[0].cobrado)}`);
  lineas.push('');
  if (esperando.rows.length) {
    lineas.push('WHATSAPP SIN RESPONDER (último mensaje es de la clienta):');
    for (const e of esperando.rows) {
      const nom = `${e.name || ''} ${e.last_name || ''}`.trim() || e.phone;
      lineas.push(`  ${nom} (${e.phone}): "${String(e.content || '').slice(0, 90)}"`);
    }
    lineas.push('');
  }
  if (saldos.rows.length) {
    lineas.push('SALDOS PENDIENTES:');
    for (const s of saldos.rows) lineas.push(`  ${s.client_name}: ${ops.money(s.saldo)}`);
  }
  return lineas.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = `Sos ${BOT}, de Estefan Peluquería (Puertos, Buenos Aires). Con las clientas atendés el WhatsApp del salón; acá estás del otro lado del mostrador, trabajando con la persona que atiende. Ella te cuenta lo que va pasando en el salón y vos lo dejás cargado en el sistema.

CÓMO TRABAJÁS
- Ella escribe rápido, informal, incompleto y a veces todo junto: "vino marta, corte y mechas, pago 40 en efectivo y el resto la semana que viene". Tu trabajo es entender eso y ejecutarlo, no pedirle que lo escriba mejor.
- Ejecutá directo. No pidas confirmación. Si algo sale mal, ella te dice y usás la herramienta deshacer.
- Un solo mensaje puede requerir varias herramientas. Encadenalas sin avisar entre medio.
- Cuando termines, contá en una o dos líneas qué quedó cargado, con los números concretos. Nada de "listo, ya está" sin decir qué.

CUÁNDO PREGUNTAR (son las únicas veces)
1. No sabés a qué clienta se refiere y hay varias que coinciden. Mostrale las opciones.
2. Falta un monto que no podés deducir del catálogo.
3. Lo que te pide es contradictorio o borraría algo que no se puede recuperar.
En cualquier otro caso, asumí lo razonable y ejecutá.

REGLAS DE NEGOCIO
- registrar_cobro ya suma los puntos, marca la visita, completa el turno y calcula comisiones. No llames a ajustar_puntos después: duplicarías.
- Si la clienta pagó menos que el total, pasá monto_pagado. El saldo se calcula solo.
- Un servicio que se hizo pero no estaba agendado va igual dentro de servicios en registrar_cobro. No hace falta crear un turno retroactivo.
- Si te cuenta algo que conviene recordar para la próxima visita (fórmula de color, cómo le gusta el corte, que es alérgica a algo, que va a volver en un mes) guardalo con agregar_nota además de lo demás. Nadie te lo va a pedir explícitamente.
- Cuando la administrativa quiera contestarle a una clienta, usá enviar_whatsapp y redactá vos el mensaje con la voz del salón: castellano rioplatense, cercano, breve, sin sonar a formulario.

EL CIERRE DEL DÍA
Cuando te pidan el resumen del día, el cierre, o cuánto entró, usá resumen_del_dia: trae todo de una, no hace falta que llames a caja ni a agenda además. Contalo en este orden y sin tablas:
1. La plata primero: cuánto entró hoy y abierto por medio de pago, con el porcentaje de cada uno. Si parte de lo que entró era saldo viejo, decilo aparte — no es facturación del día.
2. Los turnos: cuántos había, cuántos se atendieron, quién no vino, qué se canceló.
3. Las clientas: cuántas pasaron, cuáles vinieron por primera vez.
4. Lo que quedó a deber, con nombre y monto. Esto no se omite nunca.
5. Los comentarios que se cargaron durante el día, resumidos, no copiados uno por uno.
6. Cerrá con lo que llame la atención: una clienta que no volvió a aparecer, un servicio que se vendió mucho más que de costumbre, un medio de pago raro. Una o dos observaciones, no un análisis.
Si el día está vacío, decilo en una línea y no inventes lectura.

CÓMO ESCRIBÍS
- Castellano rioplatense, de vos. Directo, sin preámbulos ni cortesías.
- Los montos en pesos con separador de miles.
- Nada de markdown pesado. Frases cortas. Si listás varias cosas, usá guiones.
- No expliques qué herramienta usaste. Contá qué pasó en el salón.

Abajo tenés el estado del salón en este momento. Está actualizado a este segundo, usalo antes de salir a consultar.`;

// ─────────────────────────────────────────────────────────────────────────────

function getSesion(staffId) {
  if (!sesiones.has(staffId)) sesiones.set(staffId, []);
  return sesiones.get(staffId);
}

function resetSesion(staffId) { sesiones.delete(staffId); }

/**
 * Procesa un mensaje de la administrativa.
 * @param {object} p
 * @param {string} p.staffId       identificador del operador (para separar historiales)
 * @param {string} p.texto         lo que escribió
 * @param {function} p.sendWhatsApp función para mandar WhatsApp (inyectada desde index.js)
 * @returns {Promise<{reply:string, acciones:Array}>}
 */
async function handle({ staffId = 'staff', texto, sendWhatsApp }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { reply: 'Falta configurar ANTHROPIC_API_KEY en el servidor.', acciones: [] };
  }

  const historial = getSesion(staffId);
  historial.push({ role: 'user', content: texto });
  while (historial.length > MAX_HISTORY) historial.shift();

  await db.getDB()?.query(
    'INSERT INTO ops_conversations (staff_id, role, content) VALUES ($1,$2,$3)',
    [staffId, 'user', texto]
  ).catch(() => {});

  const estado = await snapshot();
  const ctx = { actor: staffId, sendWhatsApp };
  const acciones = [];

  let respuesta = '';
  for (let turno = 0; turno < MAX_TURNS; turno++) {
    let res;
    try {
      res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: [
          { type: 'text', text: SYSTEM },
          { type: 'text', text: `\n\n=== ESTADO DEL SALÓN ===\n${estado}` },
        ],
        tools: ops.SCHEMAS,
        messages: historial,
      });
    } catch (e) {
      console.error('[ops] API error:', e.message);
      historial.pop();
      return { reply: `No pude procesar eso: ${e.message}`, acciones };
    }

    const texts = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (texts) respuesta = texts;

    const toolUses = res.content.filter(c => c.type === 'tool_use');
    historial.push({ role: 'assistant', content: res.content });

    if (!toolUses.length) break;

    const results = [];
    for (const tu of toolUses) {
      console.log(`[ops] → ${tu.name}`, JSON.stringify(tu.input).slice(0, 160));
      const out = await ops.execute(tu.name, tu.input, ctx);
      acciones.push({ tool: tu.name, input: tu.input, output: out });
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(out),
        is_error: !!out?.error,
      });
    }
    historial.push({ role: 'user', content: results });
  }

  while (historial.length > MAX_HISTORY) historial.shift();

  await db.getDB()?.query(
    'INSERT INTO ops_conversations (staff_id, role, content) VALUES ($1,$2,$3)',
    [staffId, 'assistant', respuesta]
  ).catch(() => {});

  return { reply: respuesta || 'Listo.', acciones };
}

module.exports = { handle, snapshot, resetSesion, MODEL };
