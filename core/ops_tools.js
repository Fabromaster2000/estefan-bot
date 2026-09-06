// ── CORE: OPS TOOLS ───────────────────────────────────────────────────────────
// Herramientas que Claude usa para operar el salón desde el chat de staff.
// Cada tool = { schema (para la API de Anthropic) + run (ejecutor) }.
//
// Regla de oro: TODO lo que escribe en la base pasa por acá y queda en ops_log.
// Si una tool no está en este archivo, Claude no puede hacerlo.

'use strict';

const db        = require('./db');
const SERVICIOS = require('./servicios');

const TZ = 'America/Argentina/Buenos_Aires';

// ── Helpers ───────────────────────────────────────────────────────────────────

function conn() { return db.getDB(); }

function hoyStr() {
  return new Date().toLocaleDateString('es-AR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

/** Normaliza cualquier cosa que parezca un teléfono a +54911XXXXXXXX */
function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/[^\d]/g, '');
  if (!digits) return null;
  return `+${digits}`;
}

/** dd/mm/yyyy | yyyy-mm-dd | "hoy" | "mañana" → dd/mm/yyyy */
function normFecha(f) {
  if (!f) return hoyStr();
  const s = String(f).trim().toLowerCase();
  if (s === 'hoy') return hoyStr();
  if (s === 'mañana' || s === 'manana') {
    const d = new Date(Date.now() + 86400000);
    return d.toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  if (s === 'ayer') {
    const d = new Date(Date.now() - 86400000);
    return d.toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const ar = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (ar) {
    const yyyy = ar[3].length === 2 ? `20${ar[3]}` : ar[3];
    return `${ar[1].padStart(2, '0')}/${ar[2].padStart(2, '0')}/${yyyy}`;
  }
  return s;
}

function money(n) {
  return `$${Number(n || 0).toLocaleString('es-AR')}`;
}

/** Deja constancia de toda acción que escribe, para auditoría y para deshacer. */
async function opsLog({ actor, tool, input, result, undo }) {
  await conn().query(`
    INSERT INTO ops_log (actor, tool, input_json, result_json, undo_json, fecha_str)
    VALUES ($1,$2,$3,$4,$5, TO_CHAR(NOW() AT TIME ZONE '${TZ}','DD/MM/YYYY'))
  `, [
    actor || 'staff', tool,
    JSON.stringify(input || {}),
    JSON.stringify(result || {}),
    undo ? JSON.stringify(undo) : null,
  ]).catch(e => console.error('[ops_log]', e.message));
}

/**
 * Resuelve una clienta a partir de lo que escribió la administrativa:
 * teléfono, nombre parcial, o nombre + apellido. Devuelve {client} o {error, opciones}.
 */
async function resolverClienta(query) {
  if (!query) return { error: 'Falta identificar a la clienta.' };

  // ¿Parece teléfono?
  const digits = String(query).replace(/[^\d]/g, '');
  if (digits.length >= 8) {
    const r = await conn().query(
      `SELECT * FROM clients WHERE REPLACE(REPLACE(phone,'+',''),' ','') LIKE $1 LIMIT 5`,
      [`%${digits.slice(-8)}%`]
    );
    if (r.rows.length === 1) return { client: r.rows[0] };
    if (r.rows.length > 1) return { error: 'Varias clientas con ese número.', opciones: r.rows.map(fmtOpcion) };
  }

  // Por nombre
  const r = await conn().query(`
    SELECT * FROM clients
    WHERE LOWER(COALESCE(name,'') || ' ' || COALESCE(last_name,'')) LIKE $1
    ORDER BY last_visit DESC NULLS LAST
    LIMIT 6
  `, [`%${String(query).toLowerCase().trim()}%`]);

  if (r.rows.length === 1) return { client: r.rows[0] };
  if (r.rows.length === 0) return { error: `No encontré ninguna clienta que coincida con "${query}".` };
  return {
    error: `Hay ${r.rows.length} clientas que coinciden con "${query}". Preguntale a la administrativa cuál es.`,
    opciones: r.rows.map(fmtOpcion),
  };
}

function fmtOpcion(c) {
  return {
    nombre: `${c.name || ''} ${c.last_name || ''}`.trim(),
    phone: c.phone,
    ultima_visita: c.last_visit ? new Date(c.last_visit).toLocaleDateString('es-AR', { timeZone: TZ }) : 'nunca',
    visitas: c.visit_count || 0,
  };
}

// ── Compatibilidad de esquema ─────────────────────────────────────────────────
// El repo tiene dos definiciones distintas de client_notes / client_ficha
// (core/db.js usa `phone`, index.js usa `client_phone`). Cuál existe realmente
// depende de cuál corrió primero en esa base. Detectamos en el arranque.
const COLS = { client_notes: 'client_phone', client_ficha: 'client_phone' };

async function detectarColumnas() {
  for (const tabla of Object.keys(COLS)) {
    const r = await conn().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name=$1 AND column_name IN ('phone','client_phone')`, [tabla]
    ).catch(() => ({ rows: [] }));
    const names = r.rows.map(x => x.column_name);
    COLS[tabla] = names.includes('client_phone') ? 'client_phone' : (names.includes('phone') ? 'phone' : 'client_phone');
  }
  console.log('[ops] columnas detectadas:', COLS);
}

// ── Migraciones propias del módulo ────────────────────────────────────────────

async function initOps() {
  const q = conn();
  await q.query(`
    CREATE TABLE IF NOT EXISTS ops_log (
      id          SERIAL PRIMARY KEY,
      actor       TEXT,
      tool        TEXT,
      input_json  TEXT,
      result_json TEXT,
      undo_json   TEXT,
      undone      BOOLEAN DEFAULT FALSE,
      fecha_str   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ops_log_fecha ON ops_log(fecha_str);

    CREATE TABLE IF NOT EXISTS ops_conversations (
      id         SERIAL PRIMARY KEY,
      staff_id   TEXT,
      role       TEXT,
      content    TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ops_conv_staff ON ops_conversations(staff_id, created_at);
  `);
  // Cobros parciales: cuánto entró y cuánto queda
  await q.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS monto_pagado INTEGER`);
  await q.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS saldo INTEGER DEFAULT 0`);
  await q.query(`UPDATE payments SET monto_pagado = total WHERE monto_pagado IS NULL`);
  // Marca de quién/cómo se registró la conversación de WhatsApp
  await q.query(`ALTER TABLE conversation_log ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'bot'`);

  // FIX: human_mode_control tenía el PRIMARY KEY en client_id pero chatSetHumanMode
  // hace ON CONFLICT (phone). Sin índice único en phone el upsert tira error, y
  // como está envuelto en .catch(() => {}) fallaba en silencio: pausar el bot
  // nunca llegaba a escribirse. Movemos la unicidad a phone, que es la clave que
  // realmente usa el código.
  try {
    await q.query(`DELETE FROM human_mode_control a USING human_mode_control b
                   WHERE a.ctid < b.ctid AND a.phone = b.phone`);
    await q.query(`ALTER TABLE human_mode_control DROP CONSTRAINT IF EXISTS human_mode_control_pkey`);
    await q.query(`ALTER TABLE human_mode_control ALTER COLUMN client_id DROP NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_hmc_phone ON human_mode_control(phone)`);
    console.log('[ops] ✓ human_mode_control: unicidad por phone');
  } catch (e) {
    console.error('[ops] no pude migrar human_mode_control:', e.message);
  }

  await detectarColumnas();
  console.log('[ops] ✓ Tablas de operación listas');
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS DE LECTURA
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = {};

TOOLS.agenda = {
  schema: {
    name: 'agenda',
    description: 'Devuelve los turnos de una fecha con estado, servicio, monto y seña. Usala para "¿qué hay hoy?", "¿quién viene mañana?", o antes de marcar asistencia.',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'dd/mm/aaaa, o "hoy" / "mañana" / "ayer". Por defecto hoy.' },
      },
    },
  },
  async run({ fecha }) {
    const f = normFecha(fecha);
    const r = await conn().query(`
      SELECT b.id, b.booking_code, b.client_name, b.client_phone, b.service,
             b.time_str, b.monto, b.sena_amount, b.sena_paid, b.status, b.notes,
             c.points, c.visit_count
      FROM bookings b
      LEFT JOIN clients c ON c.phone = b.client_phone
      WHERE b.date_str = $1 AND b.cancelled_at IS NULL
      ORDER BY b.time_str ASC
    `, [f]);
    return {
      fecha: f,
      cantidad: r.rows.length,
      turnos: r.rows.map(b => ({
        id: b.id, hora: b.time_str, clienta: b.client_name, phone: b.client_phone,
        servicio: b.service, monto: b.monto, sena: b.sena_paid ? b.sena_amount : 0,
        falta_cobrar: (b.monto || 0) - (b.sena_paid ? (b.sena_amount || 0) : 0),
        estado: b.status, notas: b.notes,
        puntos_clienta: b.points || 0, visitas: b.visit_count || 0,
      })),
    };
  },
};

TOOLS.buscar_clienta = {
  schema: {
    name: 'buscar_clienta',
    description: 'Busca clientas por nombre parcial o teléfono. Usala cuando la administrativa nombra a alguien y no sabés a quién se refiere.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Nombre, apellido o teléfono' } },
      required: ['query'],
    },
  },
  async run({ query }) {
    const digits = String(query || '').replace(/[^\d]/g, '');
    const r = await conn().query(`
      SELECT phone, name, last_name, points, visit_count, total_spent, last_visit, email
      FROM clients
      WHERE LOWER(COALESCE(name,'') || ' ' || COALESCE(last_name,'')) LIKE $1
         OR ($2 <> '' AND REPLACE(phone,'+','') LIKE $3)
      ORDER BY last_visit DESC NULLS LAST LIMIT 10
    `, [`%${String(query || '').toLowerCase().trim()}%`, digits, `%${digits.slice(-8)}%`]);
    return { encontradas: r.rows.length, clientas: r.rows };
  },
};

TOOLS.ficha_clienta = {
  schema: {
    name: 'ficha_clienta',
    description: 'Ficha completa de una clienta: datos, puntos, saldos pendientes, últimos turnos, últimos cobros, notas del equipo y ficha técnica de color. Usala antes de responder cualquier pregunta sobre una clienta.',
    input_schema: {
      type: 'object',
      properties: { clienta: { type: 'string', description: 'Nombre o teléfono' } },
      required: ['clienta'],
    },
  },
  async run({ clienta }) {
    const { client, error, opciones } = await resolverClienta(clienta);
    if (error) return { error, opciones };
    const p = client.phone;
    const q = conn();

    const [turnos, cobros, notas, ficha, puntos, saldos] = await Promise.all([
      q.query(`SELECT id, date_str, time_str, service, monto, status, notes
               FROM bookings WHERE client_phone=$1 ORDER BY created_at DESC LIMIT 8`, [p]),
      q.query(`SELECT id, numero_comprobante, fecha_str, total, monto_pagado, saldo, medio_pago,
                      servicios_json, productos_json
               FROM payments WHERE client_phone=$1 ORDER BY created_at DESC LIMIT 6`, [p]),
      q.query(`SELECT id, content, type, created_by, created_at FROM client_notes
               WHERE ${COLS.client_notes}=$1 ORDER BY created_at DESC LIMIT 10`, [p])
        .catch(() => ({ rows: [] })),
      q.query(`SELECT * FROM client_ficha WHERE ${COLS.client_ficha}=$1`, [p]).catch(() => ({ rows: [] })),
      q.query(`SELECT type, points, description, created_at FROM loyalty_transactions
               WHERE phone=$1 ORDER BY created_at DESC LIMIT 6`, [p]).catch(() => ({ rows: [] })),
      q.query(`SELECT COALESCE(SUM(saldo),0) AS pendiente FROM payments WHERE client_phone=$1 AND saldo > 0`, [p]),
    ]);

    return {
      clienta: {
        nombre: `${client.name || ''} ${client.last_name || ''}`.trim(),
        phone: client.phone, email: client.email,
        puntos: client.points || 0,
        visitas: client.visit_count || 0,
        gastado_total: client.total_spent || 0,
        ultima_visita: client.last_visit
          ? new Date(client.last_visit).toLocaleDateString('es-AR', { timeZone: TZ }) : null,
        preferencias: client.preferences || null,
      },
      saldo_pendiente: Number(saldos.rows[0]?.pendiente || 0),
      turnos: turnos.rows,
      cobros: cobros.rows,
      notas_equipo: notas.rows,
      ficha_tecnica: ficha.rows[0] || null,
      movimientos_puntos: puntos.rows,
    };
  },
};

TOOLS.historial_whatsapp = {
  schema: {
    name: 'historial_whatsapp',
    description: 'Conversación completa de WhatsApp con una clienta: lo que habló con el bot Y lo que le escribió una persona del salón desde el celular. Usala cuando la administrativa pregunta "¿qué le dijimos?" o "¿qué pidió?".',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string', description: 'Nombre o teléfono' },
        limite: { type: 'integer', description: 'Cantidad de mensajes, por defecto 40' },
      },
      required: ['clienta'],
    },
  },
  async run({ clienta, limite }) {
    const { client, error, opciones } = await resolverClienta(clienta);
    if (error) return { error, opciones };
    const r = await conn().query(`
      SELECT role, content, channel, created_at FROM conversation_log
      WHERE phone=$1 ORDER BY created_at DESC LIMIT $2
    `, [client.phone, Math.min(limite || 40, 120)]);
    const hm = await db.chatGetHumanMode(client.phone);
    return {
      clienta: `${client.name || ''} ${client.last_name || ''}`.trim(),
      phone: client.phone,
      bot_pausado: !!hm.active,
      pausado_por: hm.taken_by || null,
      mensajes: r.rows.reverse().map(m => ({
        quien: m.role === 'user' ? 'clienta' : (m.role === 'staff' ? 'salón (persona)' : 'bot'),
        texto: m.content,
        cuando: new Date(m.created_at).toLocaleString('es-AR', { timeZone: TZ }),
      })),
    };
  },
};

TOOLS.chats_recientes = {
  schema: {
    name: 'chats_recientes',
    description: 'Todas las conversaciones de WhatsApp con actividad reciente, con el último mensaje y si el bot está pausado. Usala para "¿alguien está esperando respuesta?".',
    input_schema: { type: 'object', properties: {} },
  },
  async run() {
    const rows = await db.chatListConversations();
    return {
      chats: rows.map(c => ({
        clienta: `${c.name || ''} ${c.last_name || ''}`.trim() || c.phone,
        phone: c.phone,
        ultimo_mensaje: c.last_message,
        lo_dijo: c.last_role === 'user' ? 'clienta' : (c.last_role === 'staff' ? 'salón' : 'bot'),
        cuando: c.last_at ? new Date(c.last_at).toLocaleString('es-AR', { timeZone: TZ }) : null,
        esperando_respuesta: c.last_role === 'user',
        bot_pausado: !!c.human_mode,
      })),
    };
  },
};

TOOLS.caja = {
  schema: {
    name: 'caja',
    description: 'Cierre de caja de una fecha: cobros, totales por medio de pago, saldos que quedaron a deber y comisiones del día.',
    input_schema: {
      type: 'object',
      properties: { fecha: { type: 'string', description: 'dd/mm/aaaa o "hoy". Por defecto hoy.' } },
    },
  },
  async run({ fecha }) {
    const f = normFecha(fecha);
    const q = conn();
    const [pagos, comis] = await Promise.all([
      q.query(`SELECT p.id, p.numero_comprobante, p.client_name, p.medio_pago, p.total,
                      COALESCE(p.monto_pagado, p.total) AS monto_pagado, COALESCE(p.saldo,0) AS saldo,
                      p.servicios_json, p.productos_json, e.nombre AS empleado
               FROM payments p LEFT JOIN empleados e ON e.id = p.empleado_id
               WHERE p.fecha_str=$1 ORDER BY p.id ASC`, [f]),
      q.query(`SELECT e.nombre, SUM(c.monto) AS total FROM comisiones c
               LEFT JOIN empleados e ON e.id=c.empleado_id
               WHERE c.fecha_str=$1 GROUP BY e.nombre`, [f]).catch(() => ({ rows: [] })),
    ]);
    const porMedio = {};
    let cobrado = 0, facturado = 0, aDeber = 0;
    for (const p of pagos.rows) {
      const pagado = Number(p.monto_pagado || 0);
      porMedio[p.medio_pago] = (porMedio[p.medio_pago] || 0) + pagado;
      cobrado += pagado; facturado += Number(p.total || 0); aDeber += Number(p.saldo || 0);
    }
    return {
      fecha: f, cantidad_cobros: pagos.rows.length,
      total_facturado: facturado, total_cobrado: cobrado, queda_a_deber: aDeber,
      por_medio_de_pago: porMedio,
      comisiones: comis.rows,
      detalle: pagos.rows.map(p => ({
        numero: p.numero_comprobante, clienta: p.client_name, empleado: p.empleado,
        total: p.total, pagado: p.monto_pagado, saldo: p.saldo, medio: p.medio_pago,
      })),
    };
  },
};

TOOLS.catalogo = {
  schema: {
    name: 'catalogo',
    description: 'Servicios con precios, productos en venta y empleados activos. Usala cuando necesitás un precio, un id de servicio o saber quién trabaja.',
    input_schema: { type: 'object', properties: {} },
  },
  async run() {
    const q = conn();
    const [emp, prod] = await Promise.all([
      q.query(`SELECT id, nombre, rol, comision_servicios_pct FROM empleados WHERE activo ORDER BY nombre`),
      q.query(`SELECT id, nombre, precio, categoria, comision_pct FROM productos WHERE activo ORDER BY nombre`),
    ]);
    return {
      servicios: SERVICIOS.map(s => ({
        id: s.id, nombre: s.nombre, precio: s.precio,
        pide_sena: !!s.seña, sena_pct: s.pct || 0, categoria: s.categoria,
      })),
      empleados: emp.rows,
      productos: prod.rows,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS DE ESCRITURA
// ─────────────────────────────────────────────────────────────────────────────

TOOLS.marcar_asistencia = {
  schema: {
    name: 'marcar_asistencia',
    description: 'Cambia el estado de un turno: "Atendido" cuando la clienta vino, "No vino" para el ausente, "Confirmado" para volver atrás. No cobra nada — para eso está registrar_cobro.',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'integer', description: 'Id del turno (sale de agenda)' },
        estado: { type: 'string', enum: ['Atendido', 'No vino', 'Confirmado', 'Completado'] },
      },
      required: ['booking_id', 'estado'],
    },
  },
  async run({ booking_id, estado }, ctx) {
    const prev = await conn().query('SELECT status, client_name FROM bookings WHERE id=$1', [booking_id]);
    if (!prev.rows.length) return { error: `No existe el turno ${booking_id}.` };
    await conn().query('UPDATE bookings SET status=$1 WHERE id=$2', [estado, booking_id]);
    const out = { ok: true, booking_id, clienta: prev.rows[0].client_name, estado_anterior: prev.rows[0].status, estado_nuevo: estado };
    await opsLog({ actor: ctx?.actor, tool: 'marcar_asistencia', input: { booking_id, estado }, result: out,
      undo: { sql: 'UPDATE bookings SET status=$1 WHERE id=$2', params: [prev.rows[0].status, booking_id] } });
    return out;
  },
};

TOOLS.registrar_cobro = {
  schema: {
    name: 'registrar_cobro',
    description: [
      'Registra lo que se le hizo y lo que pagó una clienta. Es la tool principal del día a día.',
      'Acepta servicios que NO estaban agendados — simplemente agregalos a la lista.',
      'Si pagó menos que el total, poné monto_pagado y el resto queda como saldo a deber automáticamente.',
      'Suma los puntos de fidelidad sola (1 punto cada $1.000 efectivamente pagados), marca el turno como Completado, incrementa la visita y calcula las comisiones de productos. No llames a ajustar_puntos después de esto.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string', description: 'Nombre o teléfono de la clienta' },
        booking_id: { type: 'integer', description: 'Id del turno si existe. Omitir si vino sin turno.' },
        servicios: {
          type: 'array',
          description: 'Servicios efectivamente realizados, incluidos los no agendados.',
          items: {
            type: 'object',
            properties: {
              nombre: { type: 'string' },
              monto: { type: 'integer', description: 'Precio cobrado. Si se omite, se usa el de lista.' },
            },
            required: ['nombre'],
          },
        },
        productos: {
          type: 'array',
          description: 'Productos vendidos.',
          items: {
            type: 'object',
            properties: {
              nombre: { type: 'string' }, id: { type: 'integer' },
              precio: { type: 'integer' }, cantidad: { type: 'integer' },
            },
            required: ['nombre'],
          },
        },
        empleado: { type: 'string', description: 'Nombre de quien la atendió' },
        medio_pago: { type: 'string', description: 'Efectivo, Transferencia, Débito, Crédito, Mercado Pago...' },
        monto_pagado: { type: 'integer', description: 'Lo que realmente entró. Si se omite, se asume que pagó todo.' },
        descuento: { type: 'integer' },
        sena_ya_pagada: { type: 'integer', description: 'Seña que ya había pagado por adelantado, para descontarla del saldo.' },
        notas: { type: 'string' },
      },
      required: ['clienta', 'servicios'],
    },
  },
  async run(input, ctx) {
    const { client, error, opciones } = await resolverClienta(input.clienta);
    if (error) return { error, opciones };
    const q = conn();

    // Resolver servicios y precios
    const servicios = (input.servicios || []).map(s => {
      const cat = SERVICIOS.findByName(s.nombre);
      return { nombre: cat?.nombre || s.nombre, monto: s.monto != null ? s.monto : (cat?.precio || 0) };
    });
    const sinPrecio = servicios.filter(s => !s.monto);
    if (sinPrecio.length) {
      return { error: `No sé cuánto cobrar por: ${sinPrecio.map(s => s.nombre).join(', ')}. Preguntale el monto a la administrativa.` };
    }

    // Resolver productos
    const productos = [];
    for (const p of (input.productos || [])) {
      let row = null;
      if (p.id) row = (await q.query('SELECT * FROM productos WHERE id=$1', [p.id])).rows[0];
      if (!row && p.nombre) {
        row = (await q.query('SELECT * FROM productos WHERE LOWER(nombre) LIKE $1 AND activo LIMIT 1',
          [`%${p.nombre.toLowerCase()}%`])).rows[0];
      }
      productos.push({
        id: row?.id || null, nombre: row?.nombre || p.nombre,
        precio: p.precio != null ? p.precio : (row?.precio || 0),
        cantidad: p.cantidad || 1, comision_pct: row?.comision_pct || 0,
      });
    }

    // Empleado
    let empleadoId = null, empleadoNombre = null;
    if (input.empleado) {
      const e = (await q.query('SELECT id, nombre FROM empleados WHERE LOWER(nombre) LIKE $1 AND activo LIMIT 1',
        [`%${input.empleado.toLowerCase()}%`])).rows[0];
      if (e) { empleadoId = e.id; empleadoNombre = e.nombre; }
    }

    const totalServicios = servicios.reduce((s, x) => s + x.monto, 0);
    const totalProductos = productos.reduce((s, x) => s + x.precio * x.cantidad, 0);
    const descuento      = input.descuento || 0;
    const sena           = input.sena_ya_pagada || 0;
    const total          = totalServicios + totalProductos - descuento;
    const aCobrar        = Math.max(total - sena, 0);
    const pagado         = input.monto_pagado != null ? input.monto_pagado : aCobrar;
    const saldo          = Math.max(aCobrar - pagado, 0);

    const r = await q.query(`
      INSERT INTO payments
        (booking_id, client_id, client_phone, client_name, empleado_id, medio_pago,
         servicios_json, productos_json, total_servicios, total_productos,
         descuento, total, monto_pagado, saldo, notas, email, fecha_str, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
              TO_CHAR(NOW() AT TIME ZONE '${TZ}','DD/MM/YYYY'), $17)
      RETURNING id, numero_comprobante
    `, [
      input.booking_id || null, client.client_id || null, client.phone,
      `${client.name || ''} ${client.last_name || ''}`.trim(),
      empleadoId, input.medio_pago || 'Efectivo',
      JSON.stringify(servicios), JSON.stringify(productos),
      totalServicios, totalProductos, descuento, total, pagado, saldo,
      input.notas || null, client.email || null,
      saldo > 0 ? 'partial' : 'paid',
    ]);
    const cobro = r.rows[0];

    if (input.booking_id) {
      await q.query(`UPDATE bookings SET status='Completado' WHERE id=$1`, [input.booking_id]).catch(() => {});
    }

    // Visita + gastado
    await q.query(`
      UPDATE clients SET visit_count = COALESCE(visit_count,0)+1, last_visit = NOW(),
                         total_spent = COALESCE(total_spent,0) + $1
      WHERE phone=$2
    `, [pagado, client.phone]).catch(() => {});

    // Comisiones de productos
    for (const p of productos) {
      if (!empleadoId || !p.comision_pct) continue;
      const monto = Math.round(p.precio * p.cantidad * p.comision_pct / 100);
      await q.query(`
        INSERT INTO comisiones (empleado_id, payment_id, producto_id, monto, descripcion, fecha_str)
        VALUES ($1,$2,$3,$4,$5, TO_CHAR(NOW() AT TIME ZONE '${TZ}','DD/MM/YYYY'))
      `, [empleadoId, cobro.id, p.id, monto, `${p.nombre} x${p.cantidad}`]).catch(() => {});
    }

    // Puntos sobre lo efectivamente pagado
    const puntos = Math.floor(pagado / 1000);
    if (puntos > 0) await db.loyaltyAdd(client.phone, puntos, `Cobro #${cobro.numero_comprobante}`);

    const saldoTotal = Number((await q.query(
      'SELECT COALESCE(SUM(saldo),0) AS s FROM payments WHERE client_phone=$1 AND saldo>0', [client.phone]
    )).rows[0].s);

    const out = {
      ok: true, comprobante: cobro.numero_comprobante, payment_id: cobro.id,
      clienta: `${client.name || ''} ${client.last_name || ''}`.trim(),
      atendio: empleadoNombre,
      servicios, productos,
      total, sena_descontada: sena, pagado, saldo_de_este_cobro: saldo,
      saldo_total_clienta: saldoTotal,
      puntos_sumados: puntos,
      puntos_ahora: (client.points || 0) + puntos,
      resumen: `Cobro #${cobro.numero_comprobante} · ${money(pagado)} en ${input.medio_pago || 'Efectivo'}` +
               (saldo > 0 ? ` · quedan ${money(saldo)} a deber` : '') +
               (puntos ? ` · +${puntos} puntos` : ''),
    };
    await opsLog({ actor: ctx?.actor, tool: 'registrar_cobro', input, result: out,
      undo: { sql: 'DELETE FROM payments WHERE id=$1', params: [cobro.id] } });
    return out;
  },
};

TOOLS.registrar_pago_de_saldo = {
  schema: {
    name: 'registrar_pago_de_saldo',
    description: 'La clienta viene a pagar lo que había quedado debiendo de un cobro anterior. Baja el saldo y suma los puntos correspondientes.',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string' },
        monto: { type: 'integer', description: 'Cuánto pagó ahora' },
        medio_pago: { type: 'string' },
        comprobante: { type: 'integer', description: 'Número de comprobante si se sabe. Si no, se aplica al saldo más viejo.' },
      },
      required: ['clienta', 'monto'],
    },
  },
  async run(input, ctx) {
    const { client, error, opciones } = await resolverClienta(input.clienta);
    if (error) return { error, opciones };
    const q = conn();
    const where = input.comprobante
      ? { sql: 'SELECT * FROM payments WHERE client_phone=$1 AND numero_comprobante=$2', params: [client.phone, input.comprobante] }
      : { sql: 'SELECT * FROM payments WHERE client_phone=$1 AND saldo>0 ORDER BY id ASC LIMIT 1', params: [client.phone] };
    const p = (await q.query(where.sql, where.params)).rows[0];
    if (!p) return { error: 'Esta clienta no tiene saldos pendientes.' };

    const aplicado = Math.min(input.monto, Number(p.saldo || 0));
    const nuevoSaldo = Number(p.saldo || 0) - aplicado;
    await q.query(`UPDATE payments SET monto_pagado = COALESCE(monto_pagado,0)+$1, saldo=$2,
                   status = CASE WHEN $2 = 0 THEN 'paid' ELSE 'partial' END WHERE id=$3`,
      [aplicado, nuevoSaldo, p.id]);
    await q.query(`UPDATE clients SET total_spent = COALESCE(total_spent,0)+$1 WHERE phone=$2`,
      [aplicado, client.phone]).catch(() => {});

    const puntos = Math.floor(aplicado / 1000);
    if (puntos > 0) await db.loyaltyAdd(client.phone, puntos, `Saldo cobro #${p.numero_comprobante}`);

    const out = {
      ok: true, comprobante: p.numero_comprobante, aplicado,
      saldo_restante: nuevoSaldo, puntos_sumados: puntos,
      vuelto: input.monto > aplicado ? input.monto - aplicado : 0,
    };
    await opsLog({ actor: ctx?.actor, tool: 'registrar_pago_de_saldo', input, result: out,
      undo: { sql: 'UPDATE payments SET monto_pagado = COALESCE(monto_pagado,0)-$1, saldo=$2, status=$3 WHERE id=$4',
              params: [aplicado, Number(p.saldo || 0), p.status, p.id] } });
    return out;
  },
};

TOOLS.reprogramar_turno = {
  schema: {
    name: 'reprogramar_turno',
    description: 'Mueve un turno a otra fecha y/u hora. Avisa por WhatsApp a la clienta salvo que se pida lo contrario.',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'integer' },
        fecha: { type: 'string', description: 'dd/mm/aaaa' },
        hora: { type: 'string', description: 'HH:MM' },
        avisar: { type: 'boolean', description: 'Mandar WhatsApp a la clienta. Por defecto true.' },
      },
      required: ['booking_id'],
    },
  },
  async run({ booking_id, fecha, hora, avisar }, ctx) {
    const q = conn();
    const prev = (await q.query('SELECT * FROM bookings WHERE id=$1', [booking_id])).rows[0];
    if (!prev) return { error: `No existe el turno ${booking_id}.` };
    const nuevaFecha = fecha ? normFecha(fecha) : prev.date_str;
    const nuevaHora  = hora || prev.time_str;
    await q.query('UPDATE bookings SET date_str=$1, time_str=$2 WHERE id=$3', [nuevaFecha, nuevaHora, booking_id]);

    let aviso = null;
    if (avisar !== false && ctx?.sendWhatsApp && prev.client_phone) {
      const txt = `Hola ${prev.client_name || ''}! Tu turno de ${prev.service} quedó reprogramado para el ${nuevaFecha} a las ${nuevaHora}. Cualquier cosa escribinos por acá 💛`;
      await ctx.sendWhatsApp(prev.client_phone, txt).catch(() => {});
      await db.conversationLog(prev.client_phone, 'staff', txt).catch(() => {});
      aviso = txt;
    }
    const out = { ok: true, booking_id, clienta: prev.client_name,
      antes: `${prev.date_str} ${prev.time_str}`, ahora: `${nuevaFecha} ${nuevaHora}`, aviso_enviado: !!aviso };
    await opsLog({ actor: ctx?.actor, tool: 'reprogramar_turno', input: { booking_id, fecha, hora }, result: out,
      undo: { sql: 'UPDATE bookings SET date_str=$1, time_str=$2 WHERE id=$3', params: [prev.date_str, prev.time_str, booking_id] } });
    return out;
  },
};

TOOLS.cancelar_turno = {
  schema: {
    name: 'cancelar_turno',
    description: 'Cancela un turno y libera el horario.',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'integer' },
        motivo: { type: 'string' },
        avisar: { type: 'boolean', description: 'Mandar WhatsApp a la clienta. Por defecto false — la administrativa suele avisar ella.' },
      },
      required: ['booking_id'],
    },
  },
  async run({ booking_id, motivo, avisar }, ctx) {
    const q = conn();
    const prev = (await q.query('SELECT * FROM bookings WHERE id=$1', [booking_id])).rows[0];
    if (!prev) return { error: `No existe el turno ${booking_id}.` };
    await q.query(`UPDATE bookings SET status='Cancelado', cancelled_at=NOW(), notes=COALESCE(notes,'') || $1 WHERE id=$2`,
      [motivo ? ` | Cancelado: ${motivo}` : ' | Cancelado', booking_id]);
    if (avisar && ctx?.sendWhatsApp && prev.client_phone) {
      const txt = `Hola ${prev.client_name || ''}, cancelamos tu turno del ${prev.date_str} a las ${prev.time_str}. Cuando quieras reprogramar escribinos 💛`;
      await ctx.sendWhatsApp(prev.client_phone, txt).catch(() => {});
      await db.conversationLog(prev.client_phone, 'staff', txt).catch(() => {});
    }
    const out = { ok: true, booking_id, clienta: prev.client_name, era: `${prev.date_str} ${prev.time_str}`, motivo: motivo || null };
    await opsLog({ actor: ctx?.actor, tool: 'cancelar_turno', input: { booking_id, motivo }, result: out,
      undo: { sql: `UPDATE bookings SET status=$1, cancelled_at=NULL, notes=$2 WHERE id=$3`, params: [prev.status, prev.notes, booking_id] } });
    return out;
  },
};

TOOLS.crear_turno = {
  schema: {
    name: 'crear_turno',
    description: 'Agenda un turno nuevo. Si la clienta no existe en la base, la crea con el nombre y teléfono que le pases.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        phone: { type: 'string' },
        servicio: { type: 'string' },
        fecha: { type: 'string', description: 'dd/mm/aaaa' },
        hora: { type: 'string', description: 'HH:MM' },
        monto: { type: 'integer', description: 'Si se omite, precio de lista' },
        notas: { type: 'string' },
      },
      required: ['nombre', 'servicio', 'fecha', 'hora'],
    },
  },
  async run(input, ctx) {
    const phone = normPhone(input.phone);
    const cat = SERVICIOS.findByName(input.servicio);
    if (phone) await db.clientUpsert(phone, input.nombre, null, 'salon').catch(() => {});
    const saved = await db.bookingSave({
      sessionId: `staff-${Date.now()}`, nombre: input.nombre, phone,
      servicio: cat?.nombre || input.servicio,
      fecha: normFecha(input.fecha), hora: input.hora,
      monto: input.monto != null ? input.monto : (cat?.precio || 0),
      senaPaid: false, notes: input.notas || null, status: 'Confirmado',
    });
    const out = { ok: true, booking_id: saved?.id, codigo: saved?.code,
      clienta: input.nombre, servicio: cat?.nombre || input.servicio,
      cuando: `${normFecha(input.fecha)} ${input.hora}` };
    await opsLog({ actor: ctx?.actor, tool: 'crear_turno', input, result: out,
      undo: saved?.id ? { sql: 'DELETE FROM bookings WHERE id=$1', params: [saved.id] } : null });
    return out;
  },
};

TOOLS.agregar_nota = {
  schema: {
    name: 'agregar_nota',
    description: 'Guarda una nota sobre la clienta en su ficha: qué se le hizo, qué fórmula de color, qué le gustó, qué pidió para la próxima. Usala cada vez que la administrativa cuente algo que valga la pena recordar.',
    input_schema: {
      type: 'object',
      properties: { clienta: { type: 'string' }, nota: { type: 'string' } },
      required: ['clienta', 'nota'],
    },
  },
  async run({ clienta, nota }, ctx) {
    const { client, error, opciones } = await resolverClienta(clienta);
    if (error) return { error, opciones };
    const r = await conn().query(
      `INSERT INTO client_notes (${COLS.client_notes}, type, content, created_by)
       VALUES ($1,'nota',$2,$3) RETURNING id`,
      [client.phone, nota, ctx?.actor || 'claude']
    );
    const out = { ok: true, nota_id: r.rows[0].id, clienta: client.name, nota };
    await opsLog({ actor: ctx?.actor, tool: 'agregar_nota', input: { clienta, nota }, result: out,
      undo: { sql: 'DELETE FROM client_notes WHERE id=$1', params: [r.rows[0].id] } });
    return out;
  },
};

TOOLS.ajustar_puntos = {
  schema: {
    name: 'ajustar_puntos',
    description: 'Suma o resta puntos a mano (cortesía, corrección, canje presencial). NO la uses después de registrar_cobro — ese ya suma los puntos solo.',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string' },
        puntos: { type: 'integer', description: 'Positivo suma, negativo resta' },
        motivo: { type: 'string' },
      },
      required: ['clienta', 'puntos', 'motivo'],
    },
  },
  async run({ clienta, puntos, motivo }, ctx) {
    const { client, error, opciones } = await resolverClienta(clienta);
    if (error) return { error, opciones };
    await db.loyaltyAdd(client.phone, puntos, motivo);
    const now = (await conn().query('SELECT points FROM clients WHERE phone=$1', [client.phone])).rows[0];
    const out = { ok: true, clienta: client.name, ajuste: puntos, puntos_ahora: now?.points || 0, motivo };
    await opsLog({ actor: ctx?.actor, tool: 'ajustar_puntos', input: { clienta, puntos, motivo }, result: out,
      undo: { sql: 'UPDATE clients SET points = COALESCE(points,0) - $1 WHERE phone=$2', params: [puntos, client.phone] } });
    return out;
  },
};

TOOLS.actualizar_ficha = {
  schema: {
    name: 'actualizar_ficha',
    description: 'Actualiza datos de la clienta: apellido, email, preferencias.',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string' },
        apellido: { type: 'string' }, email: { type: 'string' }, preferencias: { type: 'string' },
      },
      required: ['clienta'],
    },
  },
  async run(input, ctx) {
    const { client, error, opciones } = await resolverClienta(input.clienta);
    if (error) return { error, opciones };
    const sets = [], params = []; let i = 1;
    if (input.apellido)     { sets.push(`last_name=$${i++}`);   params.push(input.apellido); }
    if (input.email)        { sets.push(`email=$${i++}`);       params.push(input.email); }
    if (input.preferencias) { sets.push(`preferences=$${i++}`); params.push(input.preferencias); }
    if (!sets.length) return { error: 'No me pasaste ningún dato para actualizar.' };
    params.push(client.phone);
    await conn().query(`UPDATE clients SET ${sets.join(', ')}, updated_at=NOW() WHERE phone=$${i}`, params);
    const out = { ok: true, clienta: client.name, actualizado: input };
    await opsLog({ actor: ctx?.actor, tool: 'actualizar_ficha', input, result: out });
    return out;
  },
};

TOOLS.enviar_whatsapp = {
  schema: {
    name: 'enviar_whatsapp',
    description: 'Manda un WhatsApp a una clienta desde el número del salón. El mensaje queda en el historial de la conversación. Escribí el texto con la voz del salón: cercano, en español rioplatense, sin sonar a robot.',
    input_schema: {
      type: 'object',
      properties: { clienta: { type: 'string' }, mensaje: { type: 'string' } },
      required: ['clienta', 'mensaje'],
    },
  },
  async run({ clienta, mensaje }, ctx) {
    const { client, error, opciones } = await resolverClienta(clienta);
    if (error) return { error, opciones };
    if (!ctx?.sendWhatsApp) return { error: 'WhatsApp no está configurado en este servidor.' };
    await ctx.sendWhatsApp(client.phone, mensaje);
    await db.conversationLog(client.phone, 'staff', mensaje).catch(() => {});
    const out = { ok: true, a: client.name, phone: client.phone, mensaje };
    await opsLog({ actor: ctx?.actor, tool: 'enviar_whatsapp', input: { clienta, mensaje }, result: out });
    return out;
  },
};

TOOLS.control_del_bot = {
  schema: {
    name: 'control_del_bot',
    description: 'Pausa o reactiva el bot para una clienta puntual. Pausalo cuando el salón quiera manejar esa conversación a mano; reactivalo cuando el tema esté resuelto.',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string' },
        accion: { type: 'string', enum: ['pausar', 'reactivar'] },
      },
      required: ['clienta', 'accion'],
    },
  },
  async run({ clienta, accion }, ctx) {
    const { client, error, opciones } = await resolverClienta(clienta);
    if (error) return { error, opciones };
    await db.chatSetHumanMode(client.phone, accion === 'pausar', ctx?.actor || 'staff');
    const out = { ok: true, clienta: client.name, bot: accion === 'pausar' ? 'pausado' : 'activo' };
    await opsLog({ actor: ctx?.actor, tool: 'control_del_bot', input: { clienta, accion }, result: out });
    return out;
  },
};

TOOLS.deshacer = {
  schema: {
    name: 'deshacer',
    description: 'Revierte la última acción registrada, o una puntual por su id de ops_log. Usala cuando la administrativa diga "no, era otra", "cancelá eso", "me equivoqué".',
    input_schema: {
      type: 'object',
      properties: { ops_id: { type: 'integer', description: 'Id de la acción. Si se omite, la última.' } },
    },
  },
  async run({ ops_id }, ctx) {
    const q = conn();
    const row = ops_id
      ? (await q.query('SELECT * FROM ops_log WHERE id=$1', [ops_id])).rows[0]
      : (await q.query('SELECT * FROM ops_log WHERE undo_json IS NOT NULL AND NOT undone ORDER BY id DESC LIMIT 1')).rows[0];
    if (!row) return { error: 'No hay nada que deshacer.' };
    if (!row.undo_json) return { error: `La acción "${row.tool}" no se puede deshacer automáticamente.` };
    const undo = JSON.parse(row.undo_json);
    await q.query(undo.sql, undo.params);
    await q.query('UPDATE ops_log SET undone=TRUE WHERE id=$1', [row.id]);
    return { ok: true, deshecho: row.tool, ops_id: row.id, era: JSON.parse(row.result_json || '{}') };
  },
};

TOOLS.acciones_recientes = {
  schema: {
    name: 'acciones_recientes',
    description: 'Últimas acciones que ejecutaste vos en la base, con su id. Usala para "¿qué cargaste hoy?" o antes de deshacer algo puntual.',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'integer' } },
    },
  },
  async run({ limite }) {
    const r = await conn().query(
      `SELECT id, tool, result_json, undone, created_at FROM ops_log ORDER BY id DESC LIMIT $1`,
      [Math.min(limite || 15, 50)]
    );
    return {
      acciones: r.rows.map(a => ({
        id: a.id, accion: a.tool, deshecha: a.undone,
        detalle: JSON.parse(a.result_json || '{}'),
        cuando: new Date(a.created_at).toLocaleString('es-AR', { timeZone: TZ }),
      })),
    };
  },
};

TOOLS.resumen_del_dia = {
  schema: {
    name: 'resumen_del_dia',
    description: [
      'Cierre completo de una jornada en una sola llamada: turnos y en qué terminó cada uno,',
      'clientas atendidas (nuevas vs. de siempre), facturación total y desglosada por medio de pago y por empleada,',
      'saldos que quedaron a deber, productos vendidos, puntos otorgados, notas que se cargaron y movimiento de WhatsApp.',
      'Usala cuando te pidan el resumen del día, el cierre, "cómo nos fue hoy" o cuánto entró y por qué canal.',
      'No hace falta llamar a caja ni a agenda además de esta: ya trae todo.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'dd/mm/aaaa, o "hoy" / "ayer". Por defecto hoy.' },
      },
    },
  },
  async run({ fecha }) {
    const f = normFecha(fecha);
    const q = conn();

    const [turnos, pagos, comis, notas, nuevas, wa] = await Promise.all([
      q.query(`SELECT b.id, b.time_str, b.client_name, b.client_phone, b.service, b.monto,
                      b.status, b.notes, b.cancelled_at, c.visit_count
               FROM bookings b LEFT JOIN clients c ON c.phone=b.client_phone
               WHERE b.date_str=$1 ORDER BY b.time_str ASC`, [f]),
      q.query(`SELECT p.id, p.numero_comprobante, p.client_name, p.client_phone, p.medio_pago,
                      p.total, COALESCE(p.monto_pagado,p.total) AS monto_pagado, COALESCE(p.saldo,0) AS saldo,
                      p.servicios_json, p.productos_json, p.descuento, p.notas, e.nombre AS empleado
               FROM payments p LEFT JOIN empleados e ON e.id=p.empleado_id
               WHERE p.fecha_str=$1 ORDER BY p.id ASC`, [f]),
      q.query(`SELECT e.nombre, SUM(c.monto)::int AS total FROM comisiones c
               LEFT JOIN empleados e ON e.id=c.empleado_id
               WHERE c.fecha_str=$1 GROUP BY e.nombre`, [f]).catch(() => ({ rows: [] })),
      q.query(`SELECT n.content, n.created_by, n.created_at,
                      COALESCE(c.name,'') || ' ' || COALESCE(c.last_name,'') AS clienta
               FROM client_notes n LEFT JOIN clients c ON c.phone = n.${COLS.client_notes}
               WHERE (n.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = TO_DATE($1,'DD/MM/YYYY')
               ORDER BY n.created_at ASC`, [f]).catch(() => ({ rows: [] })),
      q.query(`SELECT COALESCE(name,'') || ' ' || COALESCE(last_name,'') AS nombre, phone, source
               FROM clients WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = TO_DATE($1,'DD/MM/YYYY')`, [f]).catch(() => ({ rows: [] })),
      q.query(`SELECT
                 COUNT(DISTINCT phone)::int AS conversaciones,
                 COUNT(*) FILTER (WHERE role='user')::int      AS de_clientas,
                 COUNT(*) FILTER (WHERE role='assistant')::int AS del_bot,
                 COUNT(*) FILTER (WHERE role='staff')::int     AS del_salon
               FROM conversation_log
               WHERE (created_at AT TIME ZONE '${TZ}')::date = TO_DATE($1,'DD/MM/YYYY')`, [f])
        .catch(() => ({ rows: [{}] })),
    ]);

    // ── Turnos por estado ────────────────────────────────────────────────────
    const porEstado = {};
    for (const t of turnos.rows) {
      const e = t.cancelled_at ? 'Cancelado' : (t.status || 'Sin estado');
      (porEstado[e] = porEstado[e] || []).push({
        hora: t.time_str, clienta: t.client_name, servicio: t.service, notas: t.notes,
      });
    }

    // ── Plata ────────────────────────────────────────────────────────────────
    const porMedio = {}, porEmpleada = {}, productos = {}, servicios = {};
    let facturado = 0, cobrado = 0, aDeber = 0, descuentos = 0;
    for (const p of pagos.rows) {
      const pagado = Number(p.monto_pagado || 0);
      facturado  += Number(p.total || 0);
      cobrado    += pagado;
      aDeber     += Number(p.saldo || 0);
      descuentos += Number(p.descuento || 0);
      const medio = p.medio_pago || 'Sin especificar';
      porMedio[medio] = (porMedio[medio] || 0) + pagado;
      const emp = p.empleado || 'Sin asignar';
      porEmpleada[emp] = (porEmpleada[emp] || 0) + pagado;
      for (const s of JSON.parse(p.servicios_json || '[]')) {
        servicios[s.nombre] = servicios[s.nombre] || { veces: 0, facturado: 0 };
        servicios[s.nombre].veces++;
        servicios[s.nombre].facturado += Number(s.monto || 0);
      }
      for (const pr of JSON.parse(p.productos_json || '[]')) {
        productos[pr.nombre] = productos[pr.nombre] || { unidades: 0, facturado: 0 };
        productos[pr.nombre].unidades += Number(pr.cantidad || 1);
        productos[pr.nombre].facturado += Number(pr.precio || 0) * Number(pr.cantidad || 1);
      }
    }

    // Saldos viejos cobrados hoy: no generan comprobante nuevo, pero la plata
    // entró igual y entró por algún canal, así que van al desglose.
    const saldosRows = await q.query(`
      SELECT (result_json::json->>'aplicado')::int AS aplicado,
             COALESCE(input_json::json->>'medio_pago','Sin especificar') AS medio
      FROM ops_log WHERE tool='registrar_pago_de_saldo' AND fecha_str=$1 AND NOT undone
    `, [f]).catch(() => ({ rows: [] }));

    let saldosCobrados = 0;
    for (const s of saldosRows.rows) {
      const monto = Number(s.aplicado || 0);
      saldosCobrados += monto;
      porMedio[s.medio] = (porMedio[s.medio] || 0) + monto;
    }

    const entroEnCaja = cobrado + saldosCobrados;

    const puntos = await q.query(`
      SELECT COALESCE(SUM(points),0)::int AS otorgados
      FROM loyalty_transactions
      WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = TO_DATE($1,'DD/MM/YYYY') AND points > 0
    `, [f]).catch(() => ({ rows: [{ otorgados: 0 }] }));

    const atendidas = [...new Set(pagos.rows.map(p => p.client_phone).filter(Boolean))];
    const primeraVez = pagos.rows.filter(p => {
      const t = turnos.rows.find(x => x.client_phone === p.client_phone);
      return t && Number(t.visit_count) <= 1;
    }).map(p => p.client_name);

    // El porcentaje de cada canal se calcula sobre lo que entró en caja, no
    // sobre lo facturado: si no, lo que quedó a deber desinfla todos los
    // porcentajes y no suman 100.
    const porcentaje = t => entroEnCaja ? Math.round(t / entroEnCaja * 100) : 0;

    return {
      fecha: f,

      turnos: {
        total: turnos.rows.length,
        por_estado: Object.fromEntries(Object.entries(porEstado).map(([k, v]) => [k, v.length])),
        detalle: porEstado,
      },

      clientas: {
        atendidas: atendidas.length,
        primera_vez: primeraVez,
        altas_nuevas_en_la_base: nuevas.rows,
      },

      facturacion: {
        total_facturado: facturado,
        total_cobrado_hoy: entroEnCaja,
        cobrado_de_hoy: cobrado,
        cobrado_de_saldos_viejos: saldosCobrados,
        quedo_a_deber: aDeber,
        descuentos_otorgados: descuentos,
        ticket_promedio: pagos.rows.length ? Math.round(facturado / pagos.rows.length) : 0,
        por_medio_de_pago: Object.fromEntries(
          Object.entries(porMedio)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => [k, { monto: v, porcentaje: porcentaje(v) }])
        ),
        por_empleada: porEmpleada,
        comisiones_generadas: comis.rows,
      },

      servicios_realizados: servicios,
      productos_vendidos: productos,
      puntos_otorgados: Number(puntos.rows[0].otorgados),

      comentarios_del_dia: notas.rows.map(n => ({
        clienta: (n.clienta || '').trim() || null,
        nota: n.content,
        quien: n.created_by,
      })),

      whatsapp: wa.rows[0],

      cobros: pagos.rows.map(p => ({
        numero: p.numero_comprobante, clienta: p.client_name, empleado: p.empleado,
        total: p.total, pagado: p.monto_pagado, saldo: p.saldo, medio: p.medio_pago,
        notas: p.notas,
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

const SCHEMAS = Object.values(TOOLS).map(t => t.schema);

async function execute(name, input, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { error: `Herramienta desconocida: ${name}` };
  try {
    return await tool.run(input || {}, ctx || {});
  } catch (e) {
    console.error(`[ops_tools:${name}]`, e.message);
    return { error: `Falló ${name}: ${e.message}` };
  }
}

module.exports = { TOOLS, SCHEMAS, execute, initOps, opsLog, resolverClienta, normFecha, hoyStr, money };
