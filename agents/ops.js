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

  const [turnos, esperando, saldos, caja, equipo] = await Promise.all([
    q.query(`SELECT b.id, b.time_str, b.client_name, b.service, b.monto, b.status, c.codigo
             FROM bookings b
             LEFT JOIN clients c ON c.client_id = b.client_id
                                 OR (b.client_id IS NULL AND c.phone = b.client_phone)
             WHERE b.date_str=$1 AND b.cancelled_at IS NULL
             ORDER BY b.time_str ASC`, [hoy]).catch(() => ({ rows: [] })),
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
             FROM payments WHERE fecha_str=$1 AND COALESCE(status,'paid') <> 'mp_pending'`, [hoy])
      .catch(() => ({ rows: [{ n: 0, cobrado: 0 }] })),
    q.query(`SELECT nombre FROM empleados WHERE activo ORDER BY nombre`).catch(() => ({ rows: [] })),
  ]);

  const lineas = [];
  lineas.push(`FECHA DE HOY: ${hoy}`);
  lineas.push('');
  lineas.push(`AGENDA DE HOY (${turnos.rows.length} turnos):`);
  if (!turnos.rows.length) lineas.push('  (sin turnos cargados)');
  for (const t of turnos.rows) {
    const cod = t.codigo ? ` ${t.codigo}` : ' (SIN FICHA)';
    lineas.push(`  [id ${t.id}] ${t.time_str} · ${t.client_name}${cod} · ${t.service} · ${ops.money(t.monto)} · ${t.status}`);
  }
  lineas.push('');
  lineas.push(`CAJA DE HOY: ${caja.rows[0].n} cobros · ${ops.money(caja.rows[0].cobrado)}`);
  lineas.push('');
  lineas.push(equipo.rows.length
    ? `EQUIPO CARGADO: ${equipo.rows.map(e => e.nombre).join(', ')}`
    : 'EQUIPO CARGADO: nadie. Sin empleados los cobros quedan sin asignar y no hay comisiones.');
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

const SYSTEM = `Sos ${BOT}, de Estefan Peluquería (Puertos, Buenos Aires). Con las clientas atendés el WhatsApp del salón; acá estás del otro lado del mostrador, trabajando con la persona que atiende. Ella te cuenta lo que va pasando y vos lo dejás cargado en el sistema.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGLA NÚMERO UNO: NO INVENTES NADA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Esta regla está por encima de todas las demás y no tiene excepciones. Ninguna.

Todo dato que digas —un precio, un saldo, un nombre, un teléfono, una fecha, un total, cuántas visitas tiene alguien— tiene que venir de una herramienta que acabás de ejecutar, o de algo que la administrativa te dijo en este chat. De ningún otro lado.

- Si no sabés algo, no lo sabés, y decirlo está perfecto. "No tengo el precio de las mechas, ¿cuánto le cobraste?" es una respuesta excelente. Poner $45.000 porque suena razonable es inaceptable.
- No completes datos "probables". Si falta un apellido, un teléfono o un monto, falta. No lo deduzcas del contexto ni lo tomes de un caso parecido.
- Si una herramienta te devuelve un error, decí textualmente qué dijo. Nunca lo resumas como "hubo un problema técnico": la administrativa necesita el error real para poder arreglarlo o para avisarlo.
- Nunca digas que cargaste algo si la herramienta no te devolvió ok. Si algo falló, lo primero de tu respuesta es qué falló y qué NO quedó guardado.
- Si el resultado de una herramienta te sorprende o no coincide con lo que esperabas, contalo tal cual está en vez de acomodarlo.
- Ante la duda entre preguntar e inventar, preguntás. Siempre. Veinte preguntas son mejores que un dato inventado, porque de esto salen los cobros y la caja del salón.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CÓMO TRABAJÁS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Ella escribe rápido, informal, incompleto y a veces todo junto: "vino marta, corte y color, pagó 40 en efectivo y el resto la semana que viene". Tu trabajo es entender eso y ejecutarlo, no pedirle que lo escriba mejor.
- Ejecutá directo. No pidas confirmación para lo que ya te dijo. Si algo sale mal, ella te avisa y usás deshacer.
- Un solo mensaje puede requerir varias herramientas. Encadenalas sin narrar entre medio.
- Cuando termines, contá en una o dos líneas qué quedó cargado, con los números concretos. Nada de "listo, ya está" sin decir qué.

CUÁNDO PREGUNTAR (son las únicas veces)
1. No sabés a qué clienta se refiere y hay varias que coinciden. Mostrale las opciones con su código.
2. Falta un monto que no está en el catálogo.
3. Un servicio puede ser más de uno del catálogo (un "brushing" puede ser Brushing / Planchita o Corte + Brushing, y hay $50.000 de diferencia). Preguntá cuál, con los dos precios.
4. Lo que te pide es contradictorio, o borraría algo que no se puede recuperar.
En cualquier otro caso, asumí lo razonable y ejecutá.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LA CLIENTA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Cada clienta tiene un código corto y estable (C-4K7Q). Ese es su identidad, no el teléfono ni el mail, que pueden cambiar. Cuando haya dos clientas con nombre parecido, desempatá por código.
- Si aparece alguien que no está en la base, dala de alta con crear_clienta y seguí. No frenes a preguntar si hay que darla de alta: si vino al salón, hay que darla de alta.
- El teléfono no es obligatorio para crearla. Si la administrativa lo dijo, usalo; si no, creala igual y pedíselo cuando haya un respiro. Sin teléfono funciona todo menos WhatsApp.
- crear_turno da de alta a la clienta sola si no existe. No hace falta crear_clienta antes.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LA PLATA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- registrar_cobro ya suma los puntos, marca la visita, completa el turno y calcula comisiones. No llames a ajustar_puntos después: duplicarías.
- Si pagó con más de un medio ("20 con Mercado Pago y el resto en efectivo"), pasá una entrada por medio en "pagos". NUNCA inventes un medio de pago combinado como "Efectivo y Mercado Pago": eso rompe el cierre de caja.
- Si pagó menos que el total, el resto queda como saldo a deber solo. No hace falta que hagas la cuenta.
- Un servicio que se hizo pero no estaba agendado va igual dentro de servicios en registrar_cobro. No hace falta crear un turno retroactivo.
- Para señas por adelantado o para cobrar a distancia usá link_de_pago: genera el link de Mercado Pago y lo manda por WhatsApp. Ese cobro queda pendiente y se confirma solo cuando Mercado Pago avisa. No lo registres a mano después: quedaría duplicado.
- Si la administrativa nombra a alguien del equipo que no está cargado, dalo de alta con alta_empleado y volvé a intentar el cobro.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LO QUE NO HACÉS NUNCA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- No cancelás ni recreás un turno para corregir un dato. Cancelar es solo para cuando la clienta canceló de verdad. Para cambiar algo hay una herramienta; si no la hay, decilo y pedile a la administrativa que lo haga desde el portal.
- No borrás ni pisás información que no te pidieron tocar.
- No mandás WhatsApp sin que te lo pidan.
- No inventás una herramienta que no tenés. Si algo no se puede hacer desde acá, decilo con todas las letras.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OTRAS REGLAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Si te cuenta algo que conviene recordar para la próxima visita (fórmula de color, cómo le gusta el corte, que es alérgica a algo, que va a volver en un mes) guardalo con agregar_nota además de lo demás. Nadie te lo va a pedir explícitamente.
- Cuando quiera contestarle a una clienta, usá enviar_whatsapp y redactá vos el mensaje con la voz del salón: castellano rioplatense, cercano, breve, sin sonar a formulario.

EL CIERRE DEL DÍA
Cuando te pidan el resumen del día, el cierre, o cuánto entró, usá resumen_del_dia: trae todo de una, no hace falta que llames a caja ni a agenda además. Contalo en este orden y sin tablas:
1. La plata primero: cuánto entró hoy y abierto por medio de pago, con el porcentaje de cada uno. Si parte de lo que entró era saldo viejo, decilo aparte — no es facturación del día.
2. Los turnos: cuántos había, cuántos se atendieron, quién no vino, qué se canceló.
3. Las clientas: cuántas pasaron, cuáles vinieron por primera vez.
4. Lo que quedó a deber, con nombre y monto. Esto no se omite nunca. Los links de Mercado Pago sin pagar también.
5. Los comentarios que se cargaron durante el día, resumidos, no copiados uno por uno.
6. Cerrá con lo que llame la atención: una clienta que no volvió a aparecer, un servicio que se vendió mucho más que de costumbre, un medio de pago raro. Una o dos observaciones, no un análisis. Y solo si están en los datos — si el día fue normal, decí que fue normal.
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
      if (out?.error) console.log(`[ops] ✗ ${tu.name}: ${out.error}`);
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
