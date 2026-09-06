// ── CORE: OPS TOOLS ───────────────────────────────────────────────────────────
// Herramientas que Stefi usa para operar el salón desde el chat de mostrador.
// Cada tool = { schema (para la API de Anthropic) + run (ejecutor) }.
//
// Regla de oro: TODO lo que escribe en la base pasa por acá y queda en ops_log.
// Si una tool no está en este archivo, Stefi no puede hacerlo.
//
// IDENTIDAD: la clienta se identifica por client_id (UUID, la clave real) y se
// nombra por su código corto (C-4K7Q, el que se dice en voz alta). El teléfono
// y el email son datos de contacto que pueden cambiar, no la identidad.

'use strict';

const db        = require('./db');
const SERVICIOS = require('./servicios');

const TZ = 'America/Argentina/Buenos_Aires';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://peluqueria-bot.onrender.com';

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

/** Saca tildes y baja a minúscula. "Color de raíz" → "color de raiz" */
function limpiar(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * Expresión SQL que compara sin tildes. Postgres no trae unaccent instalado por
 * defecto y TRANSLATE alcanza: sin esto, buscar "sofia" no encuentra a "Sofía",
 * que es exactamente la mitad de los nombres del salón.
 */
function sinTildes(expr) {
  return `TRANSLATE(LOWER(${expr}), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc')`;
}

function nombreDe(c) {
  return `${c?.name || ''} ${c?.last_name || ''}`.trim() || c?.codigo || c?.phone || 'sin nombre';
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

// ─────────────────────────────────────────────────────────────────────────────
// CÓDIGO DE CLIENTA
// El UUID es la clave real pero no se puede decir en voz alta. El código sí:
// "la C-4K7Q". Cuatro caracteres sin vocales, para que no salgan palabras.
// ─────────────────────────────────────────────────────────────────────────────

const ALFABETO = '23456789BCDFGHJKLMNPQRSTVWXZ';

function nuevoCodigo() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return `C-${s}`;
}

async function codigoLibre() {
  for (let intento = 0; intento < 12; intento++) {
    const c = nuevoCodigo();
    const r = await conn().query('SELECT 1 FROM clients WHERE codigo=$1', [c]);
    if (!r.rows.length) return c;
  }
  return `C-${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

// ── Compatibilidad de esquema ─────────────────────────────────────────────────
// Las tablas de producción las creó una version anterior del esquema y
// CREATE TABLE IF NOT EXISTS no agrega columnas a una tabla que ya existe.
// Detectamos qué hay realmente antes de escribir una sola consulta.
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
  console.log('[ops] columnas de teléfono:', COLS);
}

// ── Migraciones propias del módulo ────────────────────────────────────────────

/** Un paso de migración que puede fallar sin arrastrar a los demás. */
async function paso(etiqueta, sql, params, ruidoso = true) {
  try { await conn().query(sql, params); return true; }
  catch (e) {
    if (ruidoso) console.error(`[ops] ${etiqueta}:`, e.message);
    return false;
  }
}

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

  // ── Columnas que el código da por sentadas y en producción pueden faltar ────
  // Esto es lo que causó "column client_id of relation payments does not exist":
  // la tabla existía desde antes de que la definición la incluyera.
  const COLUMNAS = [
    ['clients',              'codigo',          'TEXT'],
    ['bookings',             'client_id',       'UUID'],
    ['payments',             'client_id',       'UUID'],
    ['payments',             'monto_pagado',    'INTEGER'],
    ['payments',             'saldo',           'INTEGER DEFAULT 0'],
    ['payments',             'splits_json',     'TEXT'],
    ['payments',             'mp_payment_link', 'TEXT'],
    ['payments',             'empleado_id',     'INTEGER'],
    ['payments',             'total_servicios', 'INTEGER DEFAULT 0'],
    ['payments',             'total_productos', 'INTEGER DEFAULT 0'],
    ['payments',             'descuento',       'INTEGER DEFAULT 0'],
    ['payments',             'notas',           'TEXT'],
    ['payments',             'status',          "VARCHAR(30) DEFAULT 'paid'"],
    ['client_notes',         'client_id',       'UUID'],
    ['client_ficha',         'client_id',       'UUID'],
    ['loyalty_transactions', 'client_id',       'UUID'],
    ['conversation_log',     'client_id',       'UUID'],
    ['conversation_log',     'channel',         "TEXT DEFAULT 'bot'"],
  ];
  const agregadas = [];
  for (const [tabla, col, tipo] of COLUMNAS) {
    const existia = await q.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [tabla, col]
    ).catch(() => ({ rows: [] }));
    if (existia.rows.length) continue;
    const ok = await paso(`ALTER ${tabla}.${col}`, `ALTER TABLE ${tabla} ADD COLUMN IF NOT EXISTS ${col} ${tipo}`);
    if (ok) agregadas.push(`${tabla}.${col}`);
  }
  if (agregadas.length) console.log('[ops] columnas agregadas:', agregadas.join(', '));

  await paso('monto_pagado inicial', `UPDATE payments SET monto_pagado = total WHERE monto_pagado IS NULL`);

  await detectarColumnas();

  // ── Unicidad de human_mode_control ─────────────────────────────────────────
  // Tenía el PRIMARY KEY en client_id pero chatSetHumanMode hace ON CONFLICT
  // (phone). Sin índice único en phone el upsert falla, y como está envuelto en
  // .catch(() => {}) fallaba en silencio: pausar el bot nunca se escribía.
  await paso('hmc deduplicar',
    `DELETE FROM human_mode_control a USING human_mode_control b
     WHERE a.ctid < b.ctid AND a.phone = b.phone`);
  const hmcOk = await paso('hmc índice único',
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_hmc_phone ON human_mode_control(phone)`);
  await paso('hmc sacar PK viejo',
    `ALTER TABLE human_mode_control DROP CONSTRAINT IF EXISTS human_mode_control_pkey`);
  await paso('hmc client_id opcional',
    `ALTER TABLE human_mode_control ALTER COLUMN client_id DROP NOT NULL`, [], false);
  if (hmcOk) console.log('[ops] ✓ human_mode_control: unicidad por phone');
  else console.error('[ops] ✗ human_mode_control sin índice único — pausar el bot no va a persistir');

  // ── Identidad: código de clienta ───────────────────────────────────────────
  await paso('índice de código', `CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_codigo ON clients(codigo)`);
  const sinCodigo = await q.query(`SELECT client_id FROM clients WHERE codigo IS NULL`).catch(() => ({ rows: [] }));
  for (const row of sinCodigo.rows) {
    const c = await codigoLibre();
    await q.query('UPDATE clients SET codigo=$1 WHERE client_id=$2', [c, row.client_id]).catch(() => {});
  }
  if (sinCodigo.rows.length) console.log(`[ops] códigos generados para ${sinCodigo.rows.length} clientas`);

  // ── Identidad: rellenar client_id donde solo había teléfono ────────────────
  // Todo lo viejo se escribió con el teléfono como clave. Lo vinculamos ahora
  // para poder trabajar por ID de acá en adelante sin perder el historial.
  const VINCULOS = [
    ['bookings',             'client_phone'],
    ['payments',             'client_phone'],
    ['client_notes',         COLS.client_notes],
    ['client_ficha',         COLS.client_ficha],
    ['loyalty_transactions', 'phone'],
    ['conversation_log',     'phone'],
  ];
  for (const [tabla, colTel] of VINCULOS) {
    const r = await q.query(`
      UPDATE ${tabla} t SET client_id = c.client_id
      FROM clients c
      WHERE t.client_id IS NULL AND t.${colTel} IS NOT NULL AND t.${colTel} = c.phone
    `).catch(e => { console.error(`[ops] vincular ${tabla}:`, e.message); return null; });
    if (r?.rowCount) console.log(`[ops] ${tabla}: ${r.rowCount} filas vinculadas a su clienta`);
  }

  console.log('[ops] ✓ Tablas de operación listas');
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVER CLIENTA
// Acepta lo que la administrativa tenga a mano: el código, el teléfono, el
// email o el nombre. Devuelve {client} o {error, opciones}.
// ─────────────────────────────────────────────────────────────────────────────

function fmtOpcion(c) {
  return {
    codigo: c.codigo,
    nombre: nombreDe(c),
    telefono: c.phone || null,
    ultima_visita: c.last_visit ? new Date(c.last_visit).toLocaleDateString('es-AR', { timeZone: TZ }) : 'nunca',
    visitas: c.visit_count || 0,
  };
}

async function resolverClienta(query) {
  if (!query) return { error: 'Falta identificar a la clienta.' };
  const q = conn();
  const texto = String(query).trim();

  // 1. Código de clienta (C-4K7Q), con o sin guion
  const cod = texto.toUpperCase().replace(/\s/g, '');
  const codNorm = /^C-?[0-9A-Z]{4}$/.test(cod) ? (cod.includes('-') ? cod : `C-${cod.slice(1)}`) : null;
  if (codNorm) {
    const r = await q.query('SELECT * FROM clients WHERE codigo=$1', [codNorm]);
    if (r.rows[0]) return { client: r.rows[0] };
    return { error: `No existe ninguna clienta con el código ${codNorm}.` };
  }

  // 2. Email
  if (texto.includes('@')) {
    const r = await q.query('SELECT * FROM clients WHERE LOWER(email)=LOWER($1)', [texto]);
    if (r.rows[0]) return { client: r.rows[0] };
  }

  // 3. Teléfono
  const digits = texto.replace(/[^\d]/g, '');
  if (digits.length >= 8) {
    const r = await q.query(
      `SELECT * FROM clients WHERE REPLACE(REPLACE(phone,'+',''),' ','') LIKE $1 LIMIT 5`,
      [`%${digits.slice(-8)}%`]
    );
    if (r.rows.length === 1) return { client: r.rows[0] };
    if (r.rows.length > 1) return { error: 'Varias clientas con ese número.', opciones: r.rows.map(fmtOpcion) };
  }

  // 4. Nombre
  const r = await q.query(`
    SELECT * FROM clients
    WHERE ${sinTildes(`COALESCE(name,'') || ' ' || COALESCE(last_name,'')`)} LIKE $1
    ORDER BY last_visit DESC NULLS LAST
    LIMIT 6
  `, [`%${limpiar(texto)}%`]);

  if (r.rows.length === 1) return { client: r.rows[0] };
  if (r.rows.length === 0) {
    return { error: `No tengo ninguna clienta que coincida con "${texto}". Si es nueva, dala de alta con crear_clienta y seguí.`, no_existe: true };
  }
  return {
    error: `Hay ${r.rows.length} clientas que coinciden con "${texto}". Preguntale a la administrativa cuál es, por nombre o por código.`,
    opciones: r.rows.map(fmtOpcion),
  };
}

/** Condición SQL para filtrar por clienta aceptando filas viejas sin client_id. */
function porClienta(tabla_col_tel) {
  // El $2 IS NOT NULL evita el centinela: si la clienta no tiene teléfono
  // cargado, la segunda rama simplemente no aplica.
  return `(client_id = $1 OR (client_id IS NULL AND $2::text IS NOT NULL AND ${tabla_col_tel} = $2::text))`;
}
function argsClienta(client) { return [client.client_id, client.phone || null]; }

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVER SERVICIO
// El catálogo tiene nombres formales ("Retoque / Raíz") y el mostrador habla
// distinto ("color de raíz"). Ante duda NO adivina: devuelve las opciones.
// Antes agarraba el primero que contuviera la palabra, y por eso un "brushing"
// de $20.000 se cobraba $70.000 como "Corte + Brushing".
// ─────────────────────────────────────────────────────────────────────────────

const ALIAS = {
  'color de raiz': 'Retoque / Raíz',
  'raiz': 'Retoque / Raíz',
  'retoque de raiz': 'Retoque / Raíz',
  'retoque': 'Retoque / Raíz',
  'planchita': 'Brushing / Planchita',
  'brushing solo': 'Brushing / Planchita',
  'solo brushing': 'Brushing / Planchita',
  'corte y brushing': 'Corte + Brushing',
  'corte mas brushing': 'Corte + Brushing',
  'corte': 'Corte de pelo',
  'color': 'Color entero',
  'color entero': 'Color entero',
  'decoloracion': 'Decoloración total',
  'head spa': 'Head Spa completo',
  'spa': 'Head Spa completo',
  'lavado': 'Lavado + Aireado',
  'ozono': 'Ozono',
  'ampolla': 'Ampolla',
  'balayage': 'Balayage',
  'contorno': 'Contorno',
};

const VACIAS = new Set(['de', 'del', 'la', 'el', 'y', 'con', 'mas', '+', '/', 'un', 'una']);

function tokens(s) {
  return limpiar(s).split(/[^a-z0-9]+/).filter(t => t && !VACIAS.has(t));
}

/**
 * @returns {{servicio:object}|{opciones:Array}|{desconocido:true}}
 */
function resolverServicio(nombre) {
  if (!nombre) return { desconocido: true };
  const n = limpiar(nombre);

  // Exacto
  const exacto = SERVICIOS.find(s => limpiar(s.nombre) === n);
  if (exacto) return { servicio: exacto };

  // Alias del vocabulario del salón
  if (ALIAS[n]) {
    const s = SERVICIOS.find(x => x.nombre === ALIAS[n]);
    if (s) return { servicio: s };
  }

  // Todos los tokens presentes en el nombre del catálogo
  const t = tokens(nombre);
  if (t.length) {
    const todos = SERVICIOS.filter(s => t.every(tok => limpiar(s.nombre).includes(tok)));
    if (todos.length === 1) return { servicio: todos[0] };
    if (todos.length > 1) return { opciones: todos };

    // Algún token en común — acá es donde antes se equivocaba callado
    const algunos = SERVICIOS.filter(s => t.some(tok => tokens(s.nombre).includes(tok)));
    if (algunos.length === 1) return { servicio: algunos[0] };
    if (algunos.length > 1) return { opciones: algunos };
  }

  return { desconocido: true };
}

function fmtServicio(s) { return { nombre: s.nombre, precio: s.precio, categoria: s.categoria }; }

// ── Puntos, por ID ────────────────────────────────────────────────────────────

async function sumarPuntos(client, puntos, motivo) {
  if (!puntos) return 0;
  const q = conn();
  await q.query(
    `INSERT INTO loyalty_transactions (client_id, phone, type, points, description)
     VALUES ($1,$2,$3,$4,$5)`,
    [client.client_id, client.phone || null, puntos > 0 ? 'earn' : 'adjust', puntos, motivo || null]
  ).catch(e => console.error('[ops] puntos:', e.message));
  await q.query(
    `UPDATE clients SET points = GREATEST(COALESCE(points,0) + $1, 0), updated_at=NOW() WHERE client_id=$2`,
    [puntos, client.client_id]
  ).catch(() => {});
  return puntos;
}

async function saldoDe(client) {
  const r = await conn().query(
    `SELECT COALESCE(SUM(saldo),0) AS s FROM payments WHERE ${porClienta('client_phone')} AND saldo > 0`,
    argsClienta(client)
  ).catch(() => ({ rows: [{ s: 0 }] }));
  return Number(r.rows[0].s || 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS DE LECTURA
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = {};

TOOLS.agenda = {
  schema: {
    name: 'agenda',
    description: 'Turnos de una fecha con estado, servicio, monto y seña. Usala para "¿qué hay hoy?", "¿quién viene mañana?", o antes de marcar asistencia.',
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
      SELECT b.id, b.booking_code, b.client_name, b.client_phone, b.client_id, b.service,
             b.time_str, b.monto, b.sena_amount, b.sena_paid, b.status, b.notes,
             c.codigo, c.points, c.visit_count
      FROM bookings b
      LEFT JOIN clients c ON c.client_id = b.client_id OR (b.client_id IS NULL AND c.phone = b.client_phone)
      WHERE b.date_str = $1 AND b.cancelled_at IS NULL
      ORDER BY b.time_str ASC
    `, [f]);
    return {
      fecha: f,
      cantidad: r.rows.length,
      turnos: r.rows.map(b => ({
        id: b.id, hora: b.time_str, clienta: b.client_name, codigo: b.codigo,
        sin_ficha: !b.codigo,
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
    description: 'Busca clientas por nombre parcial, código, teléfono o email. Usala cuando la administrativa nombra a alguien y no sabés a quién se refiere.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Nombre, apellido, código (C-4K7Q), teléfono o email' } },
      required: ['query'],
    },
  },
  async run({ query }) {
    const digits = String(query || '').replace(/[^\d]/g, '');
    const r = await conn().query(`
      SELECT client_id, codigo, phone, name, last_name, points, visit_count, total_spent, last_visit, email
      FROM clients
      WHERE ${sinTildes(`COALESCE(name,'') || ' ' || COALESCE(last_name,'')`)} LIKE $1
         OR UPPER(codigo) = UPPER($2)
         OR ($3 <> '' AND REPLACE(phone,'+','') LIKE $4)
         OR LOWER(email) = LOWER($2)
      ORDER BY last_visit DESC NULLS LAST LIMIT 10
    `, [`%${limpiar(query)}%`, String(query || '').trim(), digits, `%${digits.slice(-8)}%`]);
    return { encontradas: r.rows.length, clientas: r.rows.map(fmtOpcion) };
  },
};

TOOLS.ficha_clienta = {
  schema: {
    name: 'ficha_clienta',
    description: 'Ficha completa: datos, código, puntos, saldos pendientes, últimos turnos, últimos cobros, notas del equipo y ficha técnica de color. Usala antes de responder cualquier pregunta sobre una clienta.',
    input_schema: {
      type: 'object',
      properties: { clienta: { type: 'string', description: 'Código, nombre, teléfono o email' } },
      required: ['clienta'],
    },
  },
  async run({ clienta }) {
    const { client, error, opciones, no_existe } = await resolverClienta(clienta);
    if (error) return { error, opciones, no_existe };
    const q = conn();
    const a = argsClienta(client);

    const [turnos, cobros, notas, ficha, puntos] = await Promise.all([
      q.query(`SELECT id, date_str, time_str, service, monto, status, notes FROM bookings
               WHERE ${porClienta('client_phone')} ORDER BY created_at DESC LIMIT 8`, a),
      q.query(`SELECT id, numero_comprobante, fecha_str, total, monto_pagado, saldo, medio_pago,
                      splits_json, servicios_json, productos_json, status
               FROM payments WHERE ${porClienta('client_phone')} ORDER BY created_at DESC LIMIT 6`, a),
      q.query(`SELECT id, content, type, created_by, created_at FROM client_notes
               WHERE ${porClienta(COLS.client_notes)} ORDER BY created_at DESC LIMIT 10`, a)
        .catch(() => ({ rows: [] })),
      q.query(`SELECT * FROM client_ficha WHERE ${porClienta(COLS.client_ficha)}`, a).catch(() => ({ rows: [] })),
      q.query(`SELECT type, points, description, created_at FROM loyalty_transactions
               WHERE ${porClienta('phone')} ORDER BY created_at DESC LIMIT 6`, a).catch(() => ({ rows: [] })),
    ]);

    return {
      clienta: {
        codigo: client.codigo,
        nombre: nombreDe(client),
        telefono: client.phone || null,
        email: client.email || null,
        sin_telefono: !client.phone,
        puntos: client.points || 0,
        visitas: client.visit_count || 0,
        gastado_total: client.total_spent || 0,
        ultima_visita: client.last_visit
          ? new Date(client.last_visit).toLocaleDateString('es-AR', { timeZone: TZ }) : null,
        preferencias: client.preferences || null,
      },
      saldo_pendiente: await saldoDe(client),
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
    description: 'Conversación de WhatsApp con una clienta: lo que habló con el bot Y lo que le escribió una persona del salón desde el celular. Usala cuando pregunten "¿qué le dijimos?" o "¿qué pidió?".',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string', description: 'Código, nombre o teléfono' },
        limite: { type: 'integer', description: 'Cantidad de mensajes, por defecto 40' },
      },
      required: ['clienta'],
    },
  },
  async run({ clienta, limite }) {
    const { client, error, opciones, no_existe } = await resolverClienta(clienta);
    if (error) return { error, opciones, no_existe };
    if (!client.phone) {
      return { error: `${nombreDe(client)} (${client.codigo}) no tiene teléfono cargado, así que no hay conversación de WhatsApp.` };
    }
    const r = await conn().query(`
      SELECT role, content, channel, created_at FROM conversation_log
      WHERE ${porClienta('phone')} ORDER BY created_at DESC LIMIT $3
    `, [...argsClienta(client), Math.min(limite || 40, 120)]);
    const hm = await db.chatGetHumanMode(client.phone).catch(() => ({ active: false }));
    return {
      clienta: nombreDe(client), codigo: client.codigo, telefono: client.phone,
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
    description: 'Conversaciones de WhatsApp con actividad reciente, con el último mensaje y si el bot está pausado. Usala para "¿alguien está esperando respuesta?".',
    input_schema: { type: 'object', properties: {} },
  },
  async run() {
    const rows = await db.chatListConversations();
    return {
      chats: rows.map(c => ({
        clienta: `${c.name || ''} ${c.last_name || ''}`.trim() || c.phone,
        telefono: c.phone,
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
    description: 'Caja de una fecha: cobros, totales por medio de pago, saldos a deber y comisiones. Para el cierre completo del día usá resumen_del_dia.',
    input_schema: {
      type: 'object',
      properties: { fecha: { type: 'string', description: 'dd/mm/aaaa o "hoy". Por defecto hoy.' } },
    },
  },
  async run({ fecha }) {
    const f = normFecha(fecha);
    const q = conn();
    const [pagos, comis] = await Promise.all([
      q.query(`SELECT p.id, p.numero_comprobante, p.client_name, p.medio_pago, p.splits_json, p.total,
                      COALESCE(p.monto_pagado, p.total) AS monto_pagado, COALESCE(p.saldo,0) AS saldo,
                      p.status, e.nombre AS empleado
               FROM payments p LEFT JOIN empleados e ON e.id = p.empleado_id
               WHERE p.fecha_str=$1 ORDER BY p.id ASC`, [f]),
      q.query(`SELECT e.nombre, SUM(c.monto) AS total FROM comisiones c
               LEFT JOIN empleados e ON e.id=c.empleado_id
               WHERE c.fecha_str=$1 GROUP BY e.nombre`, [f]).catch(() => ({ rows: [] })),
    ]);
    const porMedio = {};
    let cobrado = 0, facturado = 0, aDeber = 0;
    for (const p of pagos.rows) {
      if (p.status === 'mp_pending') continue;
      const pagado = Number(p.monto_pagado || 0);
      for (const [medio, monto] of desglose(p)) porMedio[medio] = (porMedio[medio] || 0) + monto;
      cobrado += pagado; facturado += Number(p.total || 0); aDeber += Number(p.saldo || 0);
    }
    return {
      fecha: f, cantidad_cobros: pagos.rows.filter(p => p.status !== 'mp_pending').length,
      total_facturado: facturado, total_cobrado: cobrado, queda_a_deber: aDeber,
      por_medio_de_pago: porMedio,
      comisiones: comis.rows,
      pendientes_de_pago_mp: pagos.rows.filter(p => p.status === 'mp_pending')
        .map(p => ({ numero: p.numero_comprobante, clienta: p.client_name, total: p.total })),
      detalle: pagos.rows.filter(p => p.status !== 'mp_pending').map(p => ({
        numero: p.numero_comprobante, clienta: p.client_name, empleado: p.empleado,
        total: p.total, pagado: p.monto_pagado, saldo: p.saldo, medio: p.medio_pago,
      })),
    };
  },
};

/** Devuelve [[medio, monto], ...] respetando el cobro partido si lo hubo. */
function desglose(p) {
  const pagado = Number(p.monto_pagado || 0);
  try {
    const splits = JSON.parse(p.splits_json || 'null');
    if (Array.isArray(splits) && splits.length) {
      return splits.map(s => [s.medio || 'Sin especificar', Number(s.monto || 0)]);
    }
  } catch (e) { /* splits corrupto: caemos al medio único */ }
  return [[p.medio_pago || 'Sin especificar', pagado]];
}

TOOLS.catalogo = {
  schema: {
    name: 'catalogo',
    description: 'Servicios con precios, productos en venta y empleados activos. Usala cuando necesitás un precio o saber quién trabaja.',
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
        nombre: s.nombre, precio: s.precio,
        pide_sena: !!s.seña, sena_pct: s.pct || 0, categoria: s.categoria,
      })),
      empleados: emp.rows,
      productos: prod.rows,
      nota: emp.rows.length ? undefined : 'No hay ningún empleado cargado. Sin empleados no se calculan comisiones — dalos de alta con alta_empleado.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS DE ESCRITURA — ALTAS
// ─────────────────────────────────────────────────────────────────────────────

TOOLS.crear_clienta = {
  schema: {
    name: 'crear_clienta',
    description: [
      'Da de alta una clienta nueva y le asigna su código (C-4K7Q). Usala apenas aparece alguien que no está en la base:',
      'no frenes a preguntar si hay que darla de alta, si vino al salón hay que darla de alta.',
      'El teléfono es muy deseable —sin él no se le puede escribir por WhatsApp— pero NO es obligatorio:',
      'si la administrativa no lo tiene a mano, creala igual y pedíselo después. Todo lo demás (puntos, saldos, notas, cobros) funciona sin teléfono.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        apellido: { type: 'string' },
        phone: { type: 'string', description: 'Si la administrativa lo dijo. Si no, omitilo.' },
        email: { type: 'string' },
        preferencias: { type: 'string', description: 'Algo que convenga recordar desde el arranque' },
      },
      required: ['nombre'],
    },
  },
  async run(input, ctx) {
    const q = conn();
    const phone = normPhone(input.phone);

    if (phone) {
      const ya = await q.query('SELECT * FROM clients WHERE phone=$1', [phone]);
      if (ya.rows[0]) {
        return { ya_existia: true, clienta: fmtOpcion(ya.rows[0]),
          aviso: `Ese teléfono ya es de ${nombreDe(ya.rows[0])} (${ya.rows[0].codigo}). No creé nada nuevo.` };
      }
    }

    const codigo = await codigoLibre();
    const r = await q.query(`
      INSERT INTO clients (codigo, name, last_name, phone, email, preferences, source, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'salon',NOW(),NOW())
      RETURNING *
    `, [codigo, input.nombre, input.apellido || null, phone,
        input.email ? input.email.toLowerCase() : null, input.preferencias || null]);
    const c = r.rows[0];

    const out = {
      ok: true, codigo: c.codigo, clienta: nombreDe(c),
      telefono: c.phone || null,
      falta_telefono: !c.phone,
      resumen: `${nombreDe(c)} dada de alta con el código ${c.codigo}` + (c.phone ? '' : ' — falta el teléfono'),
    };
    await opsLog({ actor: ctx?.actor, tool: 'crear_clienta', input, result: out,
      undo: { sql: 'DELETE FROM clients WHERE client_id=$1', params: [c.client_id] } });
    return out;
  },
};

TOOLS.actualizar_ficha = {
  schema: {
    name: 'actualizar_ficha',
    description: 'Actualiza los datos de una clienta que ya existe: nombre, apellido, teléfono, email, preferencias. Usala también para completar el teléfono que faltaba.',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string', description: 'Código, nombre, teléfono o email' },
        nombre: { type: 'string' }, apellido: { type: 'string' },
        phone: { type: 'string' }, email: { type: 'string' }, preferencias: { type: 'string' },
      },
      required: ['clienta'],
    },
  },
  async run(input, ctx) {
    const { client, error, opciones, no_existe } = await resolverClienta(input.clienta);
    if (error) return { error, opciones, no_existe };
    const q = conn();
    const phone = normPhone(input.phone);

    if (phone && phone !== client.phone) {
      const choque = await q.query('SELECT codigo, name, last_name FROM clients WHERE phone=$1 AND client_id<>$2',
        [phone, client.client_id]);
      if (choque.rows[0]) {
        return { error: `Ese teléfono ya es de ${nombreDe(choque.rows[0])} (${choque.rows[0].codigo}). No lo cambié.` };
      }
    }

    const antes = { name: client.name, last_name: client.last_name, phone: client.phone,
                    email: client.email, preferences: client.preferences };
    const sets = [], params = []; let i = 1;
    if (input.nombre)       { sets.push(`name=$${i++}`);        params.push(input.nombre); }
    if (input.apellido)     { sets.push(`last_name=$${i++}`);   params.push(input.apellido); }
    if (phone)              { sets.push(`phone=$${i++}`);       params.push(phone); }
    if (input.email)        { sets.push(`email=$${i++}`);       params.push(input.email.toLowerCase()); }
    if (input.preferencias) { sets.push(`preferences=$${i++}`); params.push(input.preferencias); }
    if (!sets.length) return { error: 'No me pasaste ningún dato para actualizar.' };
    params.push(client.client_id);
    await q.query(`UPDATE clients SET ${sets.join(', ')}, updated_at=NOW() WHERE client_id=$${i}`, params);

    // Si le acabamos de poner teléfono, atamos lo viejo que quedó suelto
    if (phone && !antes.phone) {
      for (const [tabla, col] of [['bookings','client_phone'], ['payments','client_phone']]) {
        await q.query(`UPDATE ${tabla} SET ${col}=$1 WHERE client_id=$2 AND ${col} IS NULL`,
          [phone, client.client_id]).catch(() => {});
      }
    }

    const out = { ok: true, codigo: client.codigo, clienta: nombreDe(client), actualizado: input };
    await opsLog({ actor: ctx?.actor, tool: 'actualizar_ficha', input, result: out,
      undo: { sql: `UPDATE clients SET name=$1, last_name=$2, phone=$3, email=$4, preferences=$5 WHERE client_id=$6`,
              params: [antes.name, antes.last_name, antes.phone, antes.email, antes.preferences, client.client_id] } });
    return out;
  },
};

TOOLS.alta_empleado = {
  schema: {
    name: 'alta_empleado',
    description: 'Da de alta a alguien del equipo con su rol y su porcentaje de comisión. Sin empleados cargados los cobros no registran quién atendió y no se calculan comisiones.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        rol: { type: 'string', description: 'Colorista, Estilista, Asistente...' },
        comision_pct: { type: 'integer', description: 'Porcentaje sobre servicios. Si no lo sabés, omitilo.' },
      },
      required: ['nombre'],
    },
  },
  async run(input, ctx) {
    const q = conn();
    const ya = await q.query(`SELECT id, nombre, activo FROM empleados WHERE ${sinTildes('nombre')} = $1`,
      [limpiar(input.nombre)]);
    if (ya.rows[0]) {
      if (!ya.rows[0].activo) await q.query('UPDATE empleados SET activo=TRUE WHERE id=$1', [ya.rows[0].id]);
      return { ya_existia: true, empleado_id: ya.rows[0].id, nombre: ya.rows[0].nombre,
               aviso: `${ya.rows[0].nombre} ya estaba en el equipo.` };
    }
    const r = await q.query(
      `INSERT INTO empleados (nombre, rol, comision_servicios_pct, activo) VALUES ($1,$2,$3,TRUE) RETURNING id`,
      [input.nombre, input.rol || null, input.comision_pct || 0]
    );
    const out = { ok: true, empleado_id: r.rows[0].id, nombre: input.nombre, rol: input.rol || null,
                  comision_pct: input.comision_pct || 0 };
    await opsLog({ actor: ctx?.actor, tool: 'alta_empleado', input, result: out,
      undo: { sql: 'DELETE FROM empleados WHERE id=$1', params: [r.rows[0].id] } });
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS DE ESCRITURA — TURNOS
// ─────────────────────────────────────────────────────────────────────────────

TOOLS.crear_turno = {
  schema: {
    name: 'crear_turno',
    description: 'Agenda un turno. Si la clienta no está en la base la da de alta sola con su código — no hace falta llamar a crear_clienta antes.',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string', description: 'Código o nombre de una clienta que ya existe. Si es nueva, usá nombre (y phone si lo sabés).' },
        nombre: { type: 'string', description: 'Nombre, para dar de alta a una clienta nueva' },
        phone: { type: 'string' },
        servicio: { type: 'string' },
        fecha: { type: 'string', description: 'dd/mm/aaaa' },
        hora: { type: 'string', description: 'HH:MM' },
        monto: { type: 'integer', description: 'Si se omite, precio de lista' },
        notas: { type: 'string' },
      },
      required: ['servicio', 'fecha', 'hora'],
    },
  },
  async run(input, ctx) {
    // 1. La clienta: buscarla, o darla de alta
    let client = null;
    const buscar = input.clienta || input.nombre;
    if (buscar) {
      const r = await resolverClienta(buscar);
      if (r.opciones) return { error: r.error, opciones: r.opciones };
      client = r.client || null;
    }
    if (!client) {
      const nombre = input.nombre || input.clienta;
      if (!nombre) return { error: 'Falta el nombre de la clienta.' };
      const alta = await TOOLS.crear_clienta.run({ nombre, phone: input.phone }, ctx);
      if (alta.error) return alta;
      const r = await conn().query('SELECT * FROM clients WHERE codigo=$1', [alta.codigo || alta.clienta?.codigo]);
      client = r.rows[0];
      if (!client) return { error: 'No pude crear la ficha de la clienta.' };
    } else if (input.phone && !client.phone) {
      await TOOLS.actualizar_ficha.run({ clienta: client.codigo, phone: input.phone }, ctx);
      client.phone = normPhone(input.phone);
    }

    // 2. El servicio
    const s = resolverServicio(input.servicio);
    if (s.opciones) {
      return { error: `"${input.servicio}" puede ser más de un servicio. Preguntale a la administrativa cuál es.`,
               opciones: s.opciones.map(fmtServicio) };
    }
    if (s.desconocido && input.monto == null) {
      return { error: `"${input.servicio}" no está en el catálogo. Preguntale el precio a la administrativa y volvé a llamarme con monto.`,
               catalogo: SERVICIOS.map(fmtServicio) };
    }
    const servicioNombre = s.servicio?.nombre || input.servicio;
    const monto = input.monto != null ? input.monto : s.servicio.precio;

    const saved = await db.bookingSave({
      sessionId: `staff-${Date.now()}`, nombre: nombreDe(client), phone: client.phone || null,
      clientId: client.client_id,
      servicio: servicioNombre, fecha: normFecha(input.fecha), hora: input.hora,
      monto, senaPaid: false, notes: input.notas || null, status: 'Confirmado',
      email: client.email || null,
    });
    // bookingSave no siempre escribe client_id — lo aseguramos acá
    if (saved?.id) {
      await conn().query('UPDATE bookings SET client_id=$1 WHERE id=$2', [client.client_id, saved.id]).catch(() => {});
    }

    const out = { ok: true, booking_id: saved?.id, codigo_turno: saved?.code,
      clienta: nombreDe(client), codigo_clienta: client.codigo,
      servicio: servicioNombre, monto,
      cuando: `${normFecha(input.fecha)} ${input.hora}` };
    await opsLog({ actor: ctx?.actor, tool: 'crear_turno', input, result: out,
      undo: saved?.id ? { sql: 'DELETE FROM bookings WHERE id=$1', params: [saved.id] } : null });
    return out;
  },
};

TOOLS.marcar_asistencia = {
  schema: {
    name: 'marcar_asistencia',
    description: 'Cambia el estado de un turno: "Atendido" cuando vino, "No vino" para el ausente, "Confirmado" para volver atrás. No cobra nada — para eso está registrar_cobro.',
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
    const out = { ok: true, booking_id, clienta: prev.rows[0].client_name,
                  estado_anterior: prev.rows[0].status, estado_nuevo: estado };
    await opsLog({ actor: ctx?.actor, tool: 'marcar_asistencia', input: { booking_id, estado }, result: out,
      undo: { sql: 'UPDATE bookings SET status=$1 WHERE id=$2', params: [prev.rows[0].status, booking_id] } });
    return out;
  },
};

TOOLS.reprogramar_turno = {
  schema: {
    name: 'reprogramar_turno',
    description: 'Mueve un turno a otra fecha y/u hora. Avisa por WhatsApp salvo que se pida lo contrario.',
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
    description: 'Cancela un turno y libera el horario. Usala SOLO cuando la clienta canceló de verdad — nunca como paso intermedio para corregir un dato.',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'integer' },
        motivo: { type: 'string' },
        avisar: { type: 'boolean', description: 'Mandar WhatsApp. Por defecto false — la administrativa suele avisar ella.' },
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
    const out = { ok: true, booking_id, clienta: prev.client_name,
                  era: `${prev.date_str} ${prev.time_str}`, motivo: motivo || null };
    await opsLog({ actor: ctx?.actor, tool: 'cancelar_turno', input: { booking_id, motivo }, result: out,
      undo: { sql: `UPDATE bookings SET status=$1, cancelled_at=NULL, notes=$2 WHERE id=$3`,
              params: [prev.status, prev.notes, booking_id] } });
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS DE ESCRITURA — PLATA
// ─────────────────────────────────────────────────────────────────────────────

/** Arma la lista de servicios con precio, o explica por qué no puede. */
function armarServicios(lista) {
  const servicios = [], dudosos = [], sinPrecio = [];
  for (const item of (lista || [])) {
    const s = resolverServicio(item.nombre);
    if (s.servicio) {
      servicios.push({ nombre: s.servicio.nombre, monto: item.monto != null ? item.monto : s.servicio.precio });
    } else if (item.monto != null) {
      servicios.push({ nombre: item.nombre, monto: item.monto });
    } else if (s.opciones) {
      dudosos.push({ pediste: item.nombre, puede_ser: s.opciones.map(fmtServicio) });
    } else {
      sinPrecio.push(item.nombre);
    }
  }
  return { servicios, dudosos, sinPrecio };
}

const PAGOS_SCHEMA = {
  type: 'array',
  description: 'Cómo pagó. Una entrada por medio de pago — así se registra un cobro partido (parte efectivo, parte Mercado Pago).',
  items: {
    type: 'object',
    properties: {
      medio: { type: 'string', description: 'Efectivo, Transferencia, Débito, Crédito, Mercado Pago...' },
      monto: { type: 'integer' },
    },
    required: ['medio', 'monto'],
  },
};

TOOLS.registrar_cobro = {
  schema: {
    name: 'registrar_cobro',
    description: [
      'Registra lo que se le hizo y lo que pagó una clienta. Es la tool principal del día a día.',
      'Acepta servicios que NO estaban agendados — agregalos a la lista igual.',
      'PAGOS PARTIDOS: si pagó con más de un medio (parte efectivo, parte Mercado Pago), pasá una entrada por medio en "pagos".',
      'Si pagó menos que el total, el resto queda como saldo a deber automáticamente.',
      'Suma los puntos (1 cada $1.000 efectivamente pagados), marca el turno como Completado, incrementa la visita y calcula comisiones. No llames a ajustar_puntos después.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string', description: 'Código, nombre o teléfono. Si no existe, dala de alta primero con crear_clienta.' },
        booking_id: { type: 'integer', description: 'Id del turno si existe. Omitir si vino sin turno.' },
        servicios: {
          type: 'array',
          description: 'Servicios efectivamente realizados, incluidos los no agendados.',
          items: {
            type: 'object',
            properties: {
              nombre: { type: 'string' },
              monto: { type: 'integer', description: 'Precio cobrado. Si se omite, el de lista.' },
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
        empleado: { type: 'string', description: 'Quién la atendió' },
        pagos: PAGOS_SCHEMA,
        medio_pago: { type: 'string', description: 'Atajo para cuando pagó todo con un solo medio. Si usás "pagos", omitilo.' },
        monto_pagado: { type: 'integer', description: 'Solo con medio_pago único. Lo que realmente entró.' },
        descuento: { type: 'integer' },
        sena_ya_pagada: { type: 'integer', description: 'Seña pagada por adelantado, para descontarla.' },
        notas: { type: 'string' },
      },
      required: ['clienta', 'servicios'],
    },
  },
  async run(input, ctx) {
    const { client, error, opciones, no_existe } = await resolverClienta(input.clienta);
    if (error) return { error, opciones, no_existe };
    const q = conn();

    const { servicios, dudosos, sinPrecio } = armarServicios(input.servicios);
    if (dudosos.length) {
      return { error: 'Necesito que la administrativa aclare cuál servicio es antes de cobrar.', ambiguos: dudosos };
    }
    if (sinPrecio.length) {
      return { error: `No sé cuánto cobrar por: ${sinPrecio.join(', ')}. Preguntale el monto a la administrativa.`,
               catalogo: SERVICIOS.map(fmtServicio) };
    }
    if (!servicios.length) return { error: 'No me pasaste ningún servicio.' };

    // Productos
    const productos = [];
    for (const p of (input.productos || [])) {
      let row = null;
      if (p.id) row = (await q.query('SELECT * FROM productos WHERE id=$1', [p.id])).rows[0];
      if (!row && p.nombre) {
        row = (await q.query(`SELECT * FROM productos WHERE ${sinTildes('nombre')} LIKE $1 AND activo LIMIT 1`,
          [`%${limpiar(p.nombre)}%`])).rows[0];
      }
      productos.push({
        id: row?.id || null, nombre: row?.nombre || p.nombre,
        precio: p.precio != null ? p.precio : (row?.precio || 0),
        cantidad: p.cantidad || 1, comision_pct: row?.comision_pct || 0,
      });
    }

    // Empleado
    let empleadoId = null, empleadoNombre = null, avisoEmpleado;
    if (input.empleado) {
      const e = (await q.query(`SELECT id, nombre FROM empleados WHERE ${sinTildes('nombre')} LIKE $1 AND activo LIMIT 1`,
        [`%${limpiar(input.empleado)}%`])).rows[0];
      if (e) { empleadoId = e.id; empleadoNombre = e.nombre; }
      else avisoEmpleado = `${input.empleado} no está cargado en el equipo, así que el cobro quedó sin asignar. Dalo de alta con alta_empleado.`;
    }

    const totalServicios = servicios.reduce((s, x) => s + x.monto, 0);
    const totalProductos = productos.reduce((s, x) => s + x.precio * x.cantidad, 0);
    const descuento      = input.descuento || 0;
    const sena           = input.sena_ya_pagada || 0;
    const total          = totalServicios + totalProductos - descuento;
    const aCobrar        = Math.max(total - sena, 0);

    // Cómo pagó: lista de medios, o el atajo de un solo medio
    const pagos = Array.isArray(input.pagos) && input.pagos.length
      ? input.pagos.map(p => ({ medio: p.medio, monto: Number(p.monto || 0) }))
      : null;
    const pagado = pagos
      ? pagos.reduce((s, p) => s + p.monto, 0)
      : (input.monto_pagado != null ? input.monto_pagado : aCobrar);
    const saldo = Math.max(aCobrar - pagado, 0);
    const medioLabel = pagos ? pagos.map(p => p.medio).join(' + ') : (input.medio_pago || 'Efectivo');

    const r = await q.query(`
      INSERT INTO payments
        (booking_id, client_id, client_phone, client_name, empleado_id, medio_pago, splits_json,
         servicios_json, productos_json, total_servicios, total_productos,
         descuento, total, monto_pagado, saldo, notas, email, fecha_str, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
              TO_CHAR(NOW() AT TIME ZONE '${TZ}','DD/MM/YYYY'), $18)
      RETURNING id, numero_comprobante
    `, [
      input.booking_id || null, client.client_id, client.phone || null, nombreDe(client),
      empleadoId, medioLabel, pagos ? JSON.stringify(pagos) : null,
      JSON.stringify(servicios), JSON.stringify(productos),
      totalServicios, totalProductos, descuento, total, pagado, saldo,
      input.notas || null, client.email || null,
      saldo > 0 ? 'partial' : 'paid',
    ]);
    const cobro = r.rows[0];

    if (input.booking_id) {
      await q.query(`UPDATE bookings SET status='Completado' WHERE id=$1`, [input.booking_id]).catch(() => {});
    }

    await q.query(`
      UPDATE clients SET visit_count = COALESCE(visit_count,0)+1, last_visit = NOW(),
                         total_spent = COALESCE(total_spent,0) + $1
      WHERE client_id=$2
    `, [pagado, client.client_id]).catch(() => {});

    for (const p of productos) {
      if (!empleadoId || !p.comision_pct) continue;
      const monto = Math.round(p.precio * p.cantidad * p.comision_pct / 100);
      await q.query(`
        INSERT INTO comisiones (empleado_id, payment_id, producto_id, monto, descripcion, fecha_str)
        VALUES ($1,$2,$3,$4,$5, TO_CHAR(NOW() AT TIME ZONE '${TZ}','DD/MM/YYYY'))
      `, [empleadoId, cobro.id, p.id, monto, `${p.nombre} x${p.cantidad}`]).catch(() => {});
    }

    const puntos = Math.floor(pagado / 1000);
    await sumarPuntos(client, puntos, `Cobro #${cobro.numero_comprobante}`);

    const out = {
      ok: true, comprobante: cobro.numero_comprobante, payment_id: cobro.id,
      clienta: nombreDe(client), codigo_clienta: client.codigo,
      atendio: empleadoNombre, aviso: avisoEmpleado,
      servicios, productos,
      total, sena_descontada: sena, pagado, saldo_de_este_cobro: saldo,
      pagos: pagos || [{ medio: medioLabel, monto: pagado }],
      saldo_total_clienta: await saldoDe(client),
      puntos_sumados: puntos,
      resumen: `Cobro #${cobro.numero_comprobante} · ${money(pagado)} (${medioLabel})` +
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
    description: 'La clienta viene a pagar lo que había quedado debiendo. Baja el saldo y suma los puntos correspondientes.',
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string' },
        monto: { type: 'integer', description: 'Cuánto pagó ahora' },
        medio_pago: { type: 'string' },
        comprobante: { type: 'integer', description: 'Si se sabe. Si no, se aplica al saldo más viejo.' },
      },
      required: ['clienta', 'monto'],
    },
  },
  async run(input, ctx) {
    const { client, error, opciones, no_existe } = await resolverClienta(input.clienta);
    if (error) return { error, opciones, no_existe };
    const q = conn();
    const a = argsClienta(client);
    const p = input.comprobante
      ? (await q.query(`SELECT * FROM payments WHERE ${porClienta('client_phone')} AND numero_comprobante=$3`,
          [...a, input.comprobante])).rows[0]
      : (await q.query(`SELECT * FROM payments WHERE ${porClienta('client_phone')} AND saldo>0 ORDER BY id ASC LIMIT 1`,
          a)).rows[0];
    if (!p) return { error: `${nombreDe(client)} no tiene saldos pendientes.` };

    const aplicado = Math.min(input.monto, Number(p.saldo || 0));
    const nuevoSaldo = Number(p.saldo || 0) - aplicado;
    await q.query(`UPDATE payments SET monto_pagado = COALESCE(monto_pagado,0)+$1, saldo=$2,
                   status = CASE WHEN $2 = 0 THEN 'paid' ELSE 'partial' END WHERE id=$3`,
      [aplicado, nuevoSaldo, p.id]);
    await q.query(`UPDATE clients SET total_spent = COALESCE(total_spent,0)+$1 WHERE client_id=$2`,
      [aplicado, client.client_id]).catch(() => {});

    const puntos = Math.floor(aplicado / 1000);
    await sumarPuntos(client, puntos, `Saldo cobro #${p.numero_comprobante}`);

    const out = {
      ok: true, comprobante: p.numero_comprobante, clienta: nombreDe(client), aplicado,
      saldo_restante: nuevoSaldo, puntos_sumados: puntos,
      vuelto: input.monto > aplicado ? input.monto - aplicado : 0,
    };
    await opsLog({ actor: ctx?.actor, tool: 'registrar_pago_de_saldo', input, result: out,
      undo: { sql: 'UPDATE payments SET monto_pagado = COALESCE(monto_pagado,0)-$1, saldo=$2, status=$3 WHERE id=$4',
              params: [aplicado, Number(p.saldo || 0), p.status, p.id] } });
    return out;
  },
};

TOOLS.link_de_pago = {
  schema: {
    name: 'link_de_pago',
    description: [
      'Genera un link de Mercado Pago para que la clienta pague, y lo manda por WhatsApp si tiene teléfono.',
      'El cobro queda registrado como pendiente y se confirma solo cuando Mercado Pago avisa que pagó — no lo registres a mano después.',
      'Usala para señas por adelantado, para cobrar a distancia, o cuando en el mostrador prefieren mandar el link en vez de pasar la tarjeta.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        clienta: { type: 'string', description: 'Código, nombre o teléfono' },
        monto: { type: 'integer', description: 'Cuánto cobrar. Si se omite se calcula de los servicios.' },
        servicios: {
          type: 'array',
          items: {
            type: 'object',
            properties: { nombre: { type: 'string' }, monto: { type: 'integer' } },
            required: ['nombre'],
          },
        },
        booking_id: { type: 'integer', description: 'Turno al que corresponde, si aplica' },
        concepto: { type: 'string', description: 'Qué se está cobrando, para que la clienta lo entienda' },
        enviar: { type: 'boolean', description: 'Mandarlo por WhatsApp. Por defecto true si tiene teléfono.' },
      },
      required: ['clienta'],
    },
  },
  async run(input, ctx) {
    const MP = process.env.MP_ACCESS_TOKEN;
    if (!MP) return { error: 'Falta MP_ACCESS_TOKEN en el servidor. Sin eso no puedo generar links de Mercado Pago.' };

    const { client, error, opciones, no_existe } = await resolverClienta(input.clienta);
    if (error) return { error, opciones, no_existe };

    const { servicios, dudosos, sinPrecio } = armarServicios(input.servicios);
    if (dudosos.length) return { error: 'Aclarame cuál servicio es antes de generar el link.', ambiguos: dudosos };
    if (sinPrecio.length && input.monto == null) {
      return { error: `No sé cuánto cobrar por: ${sinPrecio.join(', ')}. Pedile el monto a la administrativa.` };
    }
    const total = input.monto != null ? input.monto : servicios.reduce((s, x) => s + x.monto, 0);
    if (!total || total <= 0) return { error: 'Necesito un monto mayor a cero para generar el link.' };

    const q = conn();
    const r = await q.query(`
      INSERT INTO payments
        (booking_id, client_id, client_phone, client_name, medio_pago, servicios_json,
         total_servicios, total, notas, email, fecha_str, status)
      VALUES ($1,$2,$3,$4,'Mercado Pago',$5,$6,$7,$8,$9,
              TO_CHAR(NOW() AT TIME ZONE '${TZ}','DD/MM/YYYY'), 'mp_pending')
      RETURNING id, numero_comprobante
    `, [input.booking_id || null, client.client_id, client.phone || null, nombreDe(client),
        JSON.stringify(servicios), total, total, input.concepto || null, client.email || null]);
    const cobro = r.rows[0];

    const axios = require('axios');
    let mpUrl;
    try {
      const mpRes = await axios.post('https://api.mercadopago.com/checkout/preferences', {
        items: [{
          title: input.concepto || (servicios.length ? servicios.map(s => s.nombre).join(' + ') : 'Estefan Peluquería'),
          quantity: 1, unit_price: total, currency_id: 'ARS',
        }],
        payer: { name: nombreDe(client) },
        external_reference: `cobro:${cobro.id}`,
        back_urls: { success: `${PUBLIC_URL}/mp/success`, failure: `${PUBLIC_URL}/mp/failure` },
        auto_return: 'approved',
        notification_url: `${PUBLIC_URL}/mp/webhook`,
      }, { headers: { Authorization: `Bearer ${MP}`, 'Content-Type': 'application/json' } });
      mpUrl = mpRes.data?.init_point;
    } catch (e) {
      await q.query('DELETE FROM payments WHERE id=$1', [cobro.id]).catch(() => {});
      return { error: `Mercado Pago rechazó el pedido: ${e.response?.data?.message || e.message}` };
    }
    if (!mpUrl) {
      await q.query('DELETE FROM payments WHERE id=$1', [cobro.id]).catch(() => {});
      return { error: 'Mercado Pago no devolvió link.' };
    }
    await q.query('UPDATE payments SET mp_payment_link=$1 WHERE id=$2', [mpUrl, cobro.id]).catch(() => {});

    let enviado = false;
    const quiereEnviar = input.enviar !== false;
    if (quiereEnviar && ctx?.sendWhatsApp && client.phone) {
      const txt = `Hola ${client.name || ''}! Te dejo el link para pagar ${input.concepto ? input.concepto + ' ' : ''}(${money(total)}): ${mpUrl}\n\nCuando lo pagues nos llega solo, no hace falta que mandes comprobante 💛`;
      await ctx.sendWhatsApp(client.phone, txt).catch(() => {});
      await db.conversationLog(client.phone, 'staff', txt).catch(() => {});
      enviado = true;
    }

    const out = {
      ok: true, url: mpUrl, comprobante: cobro.numero_comprobante, payment_id: cobro.id,
      clienta: nombreDe(client), codigo_clienta: client.codigo, monto: total,
      enviado_por_whatsapp: enviado,
      aviso: enviado ? undefined : (client.phone ? 'No se envió, pasale el link vos.' : `${nombreDe(client)} no tiene teléfono cargado — pasale el link a mano.`),
      resumen: `Link de ${money(total)} generado${enviado ? ' y enviado por WhatsApp' : ''}. Queda pendiente hasta que Mercado Pago confirme el pago.`,
    };
    await opsLog({ actor: ctx?.actor, tool: 'link_de_pago', input, result: out,
      undo: { sql: `UPDATE payments SET status='cancelled' WHERE id=$1 AND status='mp_pending'`, params: [cobro.id] } });
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS DE ESCRITURA — FICHA Y COMUNICACIÓN
// ─────────────────────────────────────────────────────────────────────────────

TOOLS.agregar_nota = {
  schema: {
    name: 'agregar_nota',
    description: 'Guarda una nota en la ficha de la clienta: fórmula de color, cómo le gusta el corte, qué pidió para la próxima. Usala cada vez que la administrativa cuente algo que valga la pena recordar.',
    input_schema: {
      type: 'object',
      properties: { clienta: { type: 'string' }, nota: { type: 'string' } },
      required: ['clienta', 'nota'],
    },
  },
  async run({ clienta, nota }, ctx) {
    const { client, error, opciones, no_existe } = await resolverClienta(clienta);
    if (error) return { error, opciones, no_existe };
    const r = await conn().query(
      `INSERT INTO client_notes (client_id, ${COLS.client_notes}, type, content, created_by)
       VALUES ($1,$2,'nota',$3,$4) RETURNING id`,
      [client.client_id, client.phone || null, nota, ctx?.actor || 'stefi']
    );
    const out = { ok: true, nota_id: r.rows[0].id, clienta: nombreDe(client), codigo_clienta: client.codigo, nota };
    await opsLog({ actor: ctx?.actor, tool: 'agregar_nota', input: { clienta, nota }, result: out,
      undo: { sql: 'DELETE FROM client_notes WHERE id=$1', params: [r.rows[0].id] } });
    return out;
  },
};

TOOLS.ajustar_puntos = {
  schema: {
    name: 'ajustar_puntos',
    description: 'Suma o resta puntos a mano (cortesía, corrección, canje presencial). NO la uses después de registrar_cobro — ese ya suma solo.',
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
    const { client, error, opciones, no_existe } = await resolverClienta(clienta);
    if (error) return { error, opciones, no_existe };
    await sumarPuntos(client, puntos, motivo);
    const now = (await conn().query('SELECT points FROM clients WHERE client_id=$1', [client.client_id])).rows[0];
    const out = { ok: true, clienta: nombreDe(client), codigo_clienta: client.codigo,
                  ajuste: puntos, puntos_ahora: now?.points || 0, motivo };
    await opsLog({ actor: ctx?.actor, tool: 'ajustar_puntos', input: { clienta, puntos, motivo }, result: out,
      undo: { sql: 'UPDATE clients SET points = GREATEST(COALESCE(points,0) - $1, 0) WHERE client_id=$2',
              params: [puntos, client.client_id] } });
    return out;
  },
};

TOOLS.enviar_whatsapp = {
  schema: {
    name: 'enviar_whatsapp',
    description: 'Manda un WhatsApp a una clienta desde el número del salón. Queda en el historial. Escribí el texto con la voz del salón: cercano, rioplatense, sin sonar a robot.',
    input_schema: {
      type: 'object',
      properties: { clienta: { type: 'string' }, mensaje: { type: 'string' } },
      required: ['clienta', 'mensaje'],
    },
  },
  async run({ clienta, mensaje }, ctx) {
    const { client, error, opciones, no_existe } = await resolverClienta(clienta);
    if (error) return { error, opciones, no_existe };
    if (!client.phone) {
      return { error: `${nombreDe(client)} (${client.codigo}) no tiene teléfono cargado. Pedíselo a la administrativa y guardalo con actualizar_ficha.` };
    }
    if (!ctx?.sendWhatsApp) return { error: 'WhatsApp no está configurado en este servidor.' };
    await ctx.sendWhatsApp(client.phone, mensaje);
    await db.conversationLog(client.phone, 'staff', mensaje).catch(() => {});
    const out = { ok: true, a: nombreDe(client), telefono: client.phone, mensaje };
    await opsLog({ actor: ctx?.actor, tool: 'enviar_whatsapp', input: { clienta, mensaje }, result: out });
    return out;
  },
};

TOOLS.control_del_bot = {
  schema: {
    name: 'control_del_bot',
    description: 'Pausa o reactiva el bot para una clienta puntual. Pausalo cuando el salón quiera manejar esa conversación a mano.',
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
    const { client, error, opciones, no_existe } = await resolverClienta(clienta);
    if (error) return { error, opciones, no_existe };
    if (!client.phone) return { error: `${nombreDe(client)} no tiene teléfono, así que no hay conversación que pausar.` };
    await db.chatSetHumanMode(client.phone, accion === 'pausar', ctx?.actor || 'staff');
    const out = { ok: true, clienta: nombreDe(client), bot: accion === 'pausar' ? 'pausado' : 'activo' };
    await opsLog({ actor: ctx?.actor, tool: 'control_del_bot', input: { clienta, accion }, result: out });
    return out;
  },
};

TOOLS.deshacer = {
  schema: {
    name: 'deshacer',
    description: 'Revierte la última acción registrada, o una puntual por su id de ops_log. Usala cuando digan "no, era otra", "cancelá eso", "me equivoqué".',
    input_schema: {
      type: 'object',
      properties: { ops_id: { type: 'integer', description: 'Id de la acción. Si se omite, la última.' } },
    },
  },
  async run({ ops_id }) {
    const q = conn();
    const row = ops_id
      ? (await q.query('SELECT * FROM ops_log WHERE id=$1', [ops_id])).rows[0]
      : (await q.query('SELECT * FROM ops_log WHERE undo_json IS NOT NULL AND NOT undone ORDER BY id DESC LIMIT 1')).rows[0];
    if (!row) return { error: 'No hay nada que deshacer.' };
    if (row.undone) return { error: `La acción ${row.id} ya estaba deshecha.` };
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
    description: 'Últimas acciones que ejecutaste en la base, con su id. Usala para "¿qué cargaste hoy?" o antes de deshacer algo puntual.',
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
      'saldos que quedaron a deber, productos vendidos, puntos otorgados, notas cargadas y movimiento de WhatsApp.',
      'Usala cuando pidan el resumen del día, el cierre, "cómo nos fue hoy" o cuánto entró y por qué canal.',
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
      q.query(`SELECT b.id, b.time_str, b.client_name, b.client_phone, b.client_id, b.service, b.monto,
                      b.status, b.notes, b.cancelled_at, c.visit_count, c.codigo
               FROM bookings b
               LEFT JOIN clients c ON c.client_id = b.client_id OR (b.client_id IS NULL AND c.phone = b.client_phone)
               WHERE b.date_str=$1 ORDER BY b.time_str ASC`, [f]),
      q.query(`SELECT p.id, p.numero_comprobante, p.client_name, p.client_phone, p.client_id, p.medio_pago,
                      p.splits_json, p.total, COALESCE(p.monto_pagado,p.total) AS monto_pagado,
                      COALESCE(p.saldo,0) AS saldo, p.servicios_json, p.productos_json, p.descuento,
                      p.notas, p.status, e.nombre AS empleado
               FROM payments p LEFT JOIN empleados e ON e.id=p.empleado_id
               WHERE p.fecha_str=$1 ORDER BY p.id ASC`, [f]),
      q.query(`SELECT e.nombre, SUM(c.monto)::int AS total FROM comisiones c
               LEFT JOIN empleados e ON e.id=c.empleado_id
               WHERE c.fecha_str=$1 GROUP BY e.nombre`, [f]).catch(() => ({ rows: [] })),
      q.query(`SELECT n.content, n.created_by, n.created_at,
                      COALESCE(c.name,'') || ' ' || COALESCE(c.last_name,'') AS clienta
               FROM client_notes n
               LEFT JOIN clients c ON c.client_id = n.client_id OR (n.client_id IS NULL AND c.phone = n.${COLS.client_notes})
               WHERE (n.created_at AT TIME ZONE '${TZ}')::date = TO_DATE($1,'DD/MM/YYYY')
               ORDER BY n.created_at ASC`, [f]).catch(() => ({ rows: [] })),
      q.query(`SELECT COALESCE(name,'') || ' ' || COALESCE(last_name,'') AS nombre, codigo, phone, source
               FROM clients WHERE (created_at AT TIME ZONE '${TZ}')::date = TO_DATE($1,'DD/MM/YYYY')`, [f])
        .catch(() => ({ rows: [] })),
      q.query(`SELECT
                 COUNT(DISTINCT phone)::int AS conversaciones,
                 COUNT(*) FILTER (WHERE role='user')::int      AS de_clientas,
                 COUNT(*) FILTER (WHERE role='assistant')::int AS del_bot,
                 COUNT(*) FILTER (WHERE role='staff')::int     AS del_salon
               FROM conversation_log
               WHERE (created_at AT TIME ZONE '${TZ}')::date = TO_DATE($1,'DD/MM/YYYY')`, [f])
        .catch(() => ({ rows: [{}] })),
    ]);

    const porEstado = {};
    for (const t of turnos.rows) {
      const e = t.cancelled_at ? 'Cancelado' : (t.status || 'Sin estado');
      (porEstado[e] = porEstado[e] || []).push({
        hora: t.time_str, clienta: t.client_name, servicio: t.service, notas: t.notes,
      });
    }

    const cobrados = pagos.rows.filter(p => p.status !== 'mp_pending');
    const porMedio = {}, porEmpleada = {}, productos = {}, servicios = {};
    let facturado = 0, cobrado = 0, aDeber = 0, descuentos = 0;
    for (const p of cobrados) {
      const pagado = Number(p.monto_pagado || 0);
      facturado  += Number(p.total || 0);
      cobrado    += pagado;
      aDeber     += Number(p.saldo || 0);
      descuentos += Number(p.descuento || 0);
      for (const [medio, monto] of desglose(p)) porMedio[medio] = (porMedio[medio] || 0) + monto;
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
      SELECT COALESCE(SUM(points),0)::int AS otorgados FROM loyalty_transactions
      WHERE (created_at AT TIME ZONE '${TZ}')::date = TO_DATE($1,'DD/MM/YYYY') AND points > 0
    `, [f]).catch(() => ({ rows: [{ otorgados: 0 }] }));

    const atendidas = [...new Set(cobrados.map(p => p.client_id || p.client_phone).filter(Boolean))];
    const primeraVez = cobrados.filter(p => {
      const t = turnos.rows.find(x => (x.client_id && x.client_id === p.client_id) || x.client_phone === p.client_phone);
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
        ticket_promedio: cobrados.length ? Math.round(facturado / cobrados.length) : 0,
        por_medio_de_pago: Object.fromEntries(
          Object.entries(porMedio).sort((a, b) => b[1] - a[1])
            .map(([k, v]) => [k, { monto: v, porcentaje: porcentaje(v) }])
        ),
        por_empleada: porEmpleada,
        comisiones_generadas: comis.rows,
      },
      links_de_pago_sin_cobrar: pagos.rows.filter(p => p.status === 'mp_pending')
        .map(p => ({ clienta: p.client_name, monto: p.total })),
      servicios_realizados: servicios,
      productos_vendidos: productos,
      puntos_otorgados: Number(puntos.rows[0].otorgados),
      comentarios_del_dia: notas.rows.map(n => ({
        clienta: (n.clienta || '').trim() || null, nota: n.content, quien: n.created_by,
      })),
      whatsapp: wa.rows[0],
      cobros: cobrados.map(p => ({
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
    return { error: `Falló ${name}: ${e.message}`, error_tecnico: true };
  }
}

module.exports = {
  TOOLS, SCHEMAS, execute, initOps, opsLog,
  resolverClienta, resolverServicio, normFecha, hoyStr, money, nombreDe,
};
