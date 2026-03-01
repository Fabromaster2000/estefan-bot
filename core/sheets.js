// ── CORE: SHEETS ─────────────────────────────────────────────────────────────
// Google Sheets — sync de turnos, clientes y métricas
// Usa Service Account para autenticación

const axios = require('axios');

const SHEET_TURNOS   = 'Turnos';
const SHEET_CLIENTES = 'Clientes';
// Soporte para ambas variantes del nombre de la variable
const SHEETS_ID = process.env.SHEETS_ID || process.env.SHEET_ID;

let _getServiceAccountToken = null;
let _getDB = null;

function init(deps) {
  _getServiceAccountToken = deps.getServiceAccountToken;
  _getDB = deps.getDB;
}

function getDB() { return _getDB ? _getDB() : null; }


async function sheetsRequest(method, path, data = null) {
  const token = await getServiceAccountToken();
  const sheetsId = SHEETS_ID;
  console.log('[sheets] sheetsId:', sheetsId ? sheetsId.slice(0,15) : 'UNDEFINED', '| path:', path.slice(0,30));
  if (!token || !sheetsId) { console.log('[sheets] Sin token SA o SHEETS_ID'); return null; }
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}${path}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    let res;
    if (method === 'GET') {
      res = await axios.get(url, { headers, timeout: 10000 });
    } else if (method === 'POST') {
      res = await axios.post(url, data, { headers, timeout: 10000 });
    } else if (method === 'PUT') {
      res = await axios.put(url, data, { headers, timeout: 10000 });
    } else {
      res = await axios({ method, url, headers, data, timeout: 10000 });
    }
    return res.data;
  } catch(e) {
    const errDetail = e.response?.data?.error;
    console.error('[sheets] Error completo:', JSON.stringify(e.response?.data || e.message));
    console.error('[sheets] URL intentada:', `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}${path}`);
    return null;
  }
}

async function initSheets() {
  if (!SHEETS_ID) { console.log('[sheets] Sin SHEETS_ID'); return; }
  try {
    console.log('[sheets] Iniciando...');
    
    // Step 1: get metadata
    const meta = await sheetsRequest('GET', '?includeGridData=false');
    if (!meta) { console.log('[sheets] No se pudo leer el spreadsheet'); return; }
    
    const sheets = meta.sheets.map(s => ({ id: s.properties.sheetId, title: s.properties.title }));
    console.log('[sheets] Hojas actuales:', sheets.map(s => s.title).join(', '));
    
    const needed = ['Turnos', 'Hoy', 'Facturación', 'Clientes', 'Métricas'];
    const existing = sheets.map(s => s.title);
    const requests = [];
    
    // Rename "Hoja 1" to "Turnos" if Turnos doesn't exist
    const hoja1 = sheets.find(s => s.title === 'Hoja 1' || s.title === 'Sheet1');
    if (hoja1 && !existing.includes('Turnos')) {
      requests.push({ updateSheetProperties: { properties: { sheetId: hoja1.id, title: 'Turnos' }, fields: 'title' } });
      existing.push('Turnos');
    }
    
    // Create missing sheets
    for (const name of needed) {
      if (!existing.includes(name)) {
        requests.push({ addSheet: { properties: { title: name } } });
        existing.push(name);
      }
    }
    
    if (requests.length > 0) {
      console.log('[sheets] Enviando batchUpdate con', requests.length, 'operaciones...');
      const batchRes = await sheetsRequest('POST', ':batchUpdate', { requests });
      if (batchRes) {
        console.log('[sheets] ✓ Hojas creadas/renombradas');
      } else {
        console.log('[sheets] ✗ batchUpdate falló');
        return;
      }
    } else {
      console.log('[sheets] Todas las hojas ya existen');
    }
    
    // Add Promociones and Canjes sheets if missing
    const needed2 = ['Promociones', 'Canjes'];
    const existingNow = (await sheetsRequest('GET', '?includeGridData=false'))?.sheets?.map(s => s.properties.title) || [];
    const requests2 = [];
    for (const name of needed2) {
      if (!existingNow.includes(name)) requests2.push({ addSheet: { properties: { title: name } } });
    }
    if (requests2.length > 0) await sheetsRequest('POST', ':batchUpdate', { requests: requests2 });

    // Step 3: Add headers to Turnos
    const headerCheck = await sheetsRequest('GET', '/values/Turnos!A1:M1');
    if (!headerCheck?.values?.length) {
      console.log('[sheets] Agregando headers a Turnos...');
      await sheetsRequest('PUT', '/values/Turnos!A1:M1?valueInputOption=RAW', {
        values: [['ID', 'Fecha', 'Hora', 'Nombre', 'Teléfono', 'Servicio', 'Precio', 'Seña', 'Seña Pagada', 'Estilista', 'Estado', 'Canal', 'Fecha Creación']]
      });
    }

    // Step 4: Add headers to Clientes
    // Always update Clientes headers to ensure 11 columns
    await sheetsRequest('PUT', '/values/Clientes!A1:K1?valueInputOption=RAW', {
      values: [['Teléfono', 'Nombre', 'Apellido', 'Email', 'Visitas', 'Total Gastado', 'Último Servicio', 'Última Visita', 'Promos', 'Perfil', 'Preferencias']]
    });
    console.log('[sheets] ✓ Headers Clientes (11 columnas)');

    // Step 5: Add headers to Facturación  
    const facturaCheck = await sheetsRequest('GET', '/values/Facturación!A1:G1');
    if (!facturaCheck?.values?.length) {
      console.log('[sheets] Agregando headers a Facturación...');
      await sheetsRequest('PUT', '/values/Facturación!A1:G1?valueInputOption=RAW', {
        values: [['Mes', 'Turnos Totales', 'Ingresos Totales', 'Señas Cobradas', 'Ticket Promedio', 'Clientes Nuevas', 'Clientes Recurrentes']]
      });
    }

    // Step 6: Promociones headers and example row
    const promosCheck = await sheetsRequest('GET', '/values/Promociones!A1:E1');
    if (!promosCheck?.values?.length) {
      await sheetsRequest('PUT', '/values/Promociones!A1:E2?valueInputOption=RAW', {
        values: [
          ['Nombre', 'Descuento', 'Descripción', 'Desde (dd/mm/yyyy)', 'Hasta (dd/mm/yyyy)'],
          ['Ejemplo: 10% Junio', '10%', 'Descuento especial en todos los servicios', '01/06/2026', '30/06/2026']
        ]
      });
    }

    // Step 7: Canjes headers and example rows
    const canjesCheck = await sheetsRequest('GET', '/values/Canjes!A1:C1');
    if (!canjesCheck?.values?.length) {
      await sheetsRequest('PUT', '/values/Canjes!A1:C4?valueInputOption=RAW', {
        values: [
          ['Puntos Necesarios', 'Premio', 'Descripción'],
          ['100', '10% de descuento', 'En cualquier servicio del menú'],
          ['250', 'Ampolla gratis', 'Con cualquier servicio'],
          ['500', 'Lavado + Aireado gratis', 'Servicio completo sin costo']
        ]
      });
    }
    
    console.log('[sheets] ✓ Sheets inicializado correctamente');
    // loadServicePricesFromSheet().catch(() => {}); // Tab no existe en este Sheets
  } catch(e) {
    console.error('[sheets] Error en initSheets:', e.message, e.stack?.slice(0,200));
  }
}


async function appendTurnoToSheet(booking) {
  if (!SHEETS_ID) return;
  try {
    const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const code = typeof booking.code === 'object' ? booking.code?.code : booking.code;
    const precioTotal = booking.precio || booking.monto || 0;
    const senaAmt = booking.senaAmount || 0;
    const row = [
      code || booking.id || '',
      booking.fecha || '',
      booking.hora || '',
      booking.nombre || '',
      booking.phone || '',
      booking.servicio || '',
      precioTotal,
      senaAmt,
      booking.senaPaid ? 'Sí' : 'No',
      booking.estilista || 'A asignar',
      booking.status || 'Confirmado',
      booking.canal || 'WhatsApp Bot',
      now,
    ];
    await sheetsRequest('POST', `/values/${SHEET_TURNOS}!A:M:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      values: [row]
    });
    console.log(`[sheets] ✓ Turno agregado: ${booking.nombre} — ${booking.servicio}`);
  } catch(e) {
    console.error('[sheets] Error appendTurno:', e.message);
  }
}

async function updateTurnoStatus(clientNameOrCode, service, newStatus) {
  if (!SHEETS_ID) return;
  try {
    const data = await sheetsRequest('GET', `/values/${SHEET_TURNOS}!A:M`);
    if (!data?.values) return;
    const rows = data.values;
    for (let i = 1; i < rows.length; i++) {
      // Match by booking code (col A) OR by name+service
      const matchByCode = rows[i][0] === clientNameOrCode;
      const matchByName = rows[i][3] === clientNameOrCode && rows[i][5] === service;
      if (matchByCode || matchByName) {
        await sheetsRequest('PUT', `/values/${SHEET_TURNOS}!K${i+1}?valueInputOption=RAW`, {
          values: [[newStatus]]
        });
        console.log(`[sheets] Estado actualizado fila ${i+1}: ${newStatus}`);
        break;
      }
    }
  } catch(e) {
    console.error('[sheets] Error updateStatus:', e.message);
  }
}

async function syncClientesToSheet() {
  if (!SHEETS_ID || !db) return;
  try {
    const res = await db.query(`
      SELECT c.phone, c.name, c.last_name, c.email, c.visit_count, c.total_spent,
        (SELECT service FROM bookings WHERE client_phone = c.phone ORDER BY created_at DESC LIMIT 1) as last_service,
        c.last_visit, c.promo_opt_in, c.profile_complete, c.preferences
      FROM clients c ORDER BY c.visit_count DESC, c.created_at DESC
    `);

    if (!res.rows.length) return;

    const rows = res.rows.map(c => [
      c.phone,
      c.name || '',
      c.last_name || '',
      c.email || '',
      c.visit_count || 0,
      c.total_spent || 0,
      c.last_service || '',
      c.last_visit ? new Date(c.last_visit).toLocaleDateString('es-AR') : '',
      c.promo_opt_in ? 'Sí' : 'No',
      c.profile_complete ? 'Completo' : 'Incompleto',
      c.preferences || ''
    ]);

    await sheetsRequest('PUT', `/values/${SHEET_CLIENTES}!A2:K${rows.length + 1}?valueInputOption=USER_ENTERED`, {
      values: rows
    });
    console.log(`[sheets] ✓ ${rows.length} clientes sincronizados en Clientes`);
  } catch(e) {
    console.error('[sheets] Error syncClientes:', e.message);
  }
}

async function refreshMetricas() {
  if (!SHEETS_ID || !db) return;
  try {
    const [turnos, clientes, factura] = await Promise.all([
      db.query(`SELECT COUNT(*) as total, SUM(sena_amount) as senas, AVG(sena_amount) as avg FROM bookings WHERE created_at > NOW() - INTERVAL '30 days'`),
      db.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN visit_count = 1 THEN 1 END) as nuevas FROM clients`),
      db.query(`SELECT DATE_TRUNC('month', created_at) as mes, COUNT(*) as turnos, SUM(sena_amount) as ingresos FROM bookings GROUP BY mes ORDER BY mes DESC LIMIT 12`),
    ]);

    // Write metrics tab
    const metricsData = [
      ['MÉTRICAS — Últimos 30 días', '', new Date().toLocaleDateString('es-AR')],
      ['', '', ''],
      ['Turnos confirmados', turnos.rows[0].total, ''],
      ['Señas cobradas', '$' + (parseInt(turnos.rows[0].senas) || 0).toLocaleString('es-AR'), ''],
      ['Ticket promedio seña', '$' + Math.round(turnos.rows[0].avg || 0).toLocaleString('es-AR'), ''],
      ['Total clientes', clientes.rows[0].total, ''],
      ['Clientes nuevas', clientes.rows[0].nuevas, ''],
      ['', '', ''],
      ['FACTURACIÓN MENSUAL', '', ''],
      ['Mes', 'Turnos', 'Ingresos (señas)'],
      ...factura.rows.map(r => [
        new Date(r.mes).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }),
        r.turnos,
        '$' + (parseInt(r.ingresos) || 0).toLocaleString('es-AR')
      ])
    ];

    await sheetsRequest('PUT', `/values/${SHEET_METRICAS}!A1:C${metricsData.length}?valueInputOption=USER_ENTERED`, {
      values: metricsData
    });
    console.log('[sheets] ✓ Métricas actualizadas');
  } catch(e) {
    console.error('[sheets] Error refreshMetricas:', e.message);
  }
}

// ── MERCADOPAGO ───────────────────────────────────────────────────────────────
const pendingPayments = new Map();

module.exports = { init, sheetsRequest, initSheets, appendTurnoToSheet, updateTurnoStatus, syncClientesToSheet, refreshMetricas };
