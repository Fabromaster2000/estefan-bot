// ── SEED DEMO ─────────────────────────────────────────────────────────────────
// Llena la base con un día de salón realista para poder probar el chat de
// operación sin tocar datos reales.
//
//   DEMO_SEED=si DATABASE_URL=... node seed-demo.js
//   DEMO_SEED=si DATABASE_URL=... node seed-demo.js --limpiar   ← borra lo sembrado
//
// Todo lo que crea queda marcado (clients.source='demo', bookings.session_id
// empieza con 'demo-') así se puede borrar después sin llevarse nada más puesto.
// Sin DEMO_SEED=si no hace nada: es la traba para no correrlo contra producción
// por accidente.

'use strict';

const db  = require('./core/db');
const ops = require('./core/ops_tools');

const MARCA = 'demo';

const CLIENTAS = [
  { phone: '+5491190000001', name: 'Marta',    last: 'Gómez',    visitas: 8, puntos: 145, email: 'marta.demo@mail.com' },
  { phone: '+5491190000002', name: 'Sofía',    last: 'Ruiz',     visitas: 3, puntos: 40 },
  { phone: '+5491190000003', name: 'Vicky',    last: 'Paz',      visitas: 0, puntos: 0 },
  { phone: '+5491190000004', name: 'Carla',    last: 'Medina',   visitas: 12, puntos: 210 },
  { phone: '+5491190000005', name: 'Luciana',  last: 'Ferrari',  visitas: 1, puntos: 15 },
  { phone: '+5491190000006', name: 'Romina',   last: 'Duarte',   visitas: 5, puntos: 62 },
  { phone: '+5491190000007', name: 'Agustina', last: 'Sosa',     visitas: 2, puntos: 28 },
];

const TURNOS = [
  { phone: '+5491190000001', hora: '09:30', servicio: 'Corte + Brushing',    monto: 70000 },
  { phone: '+5491190000004', hora: '10:00', servicio: 'Balayage',            monto: 200000, sena: 30000 },
  { phone: '+5491190000002', hora: '11:30', servicio: 'Retoque / Raíz',      monto: 60000,  sena: 6000 },
  { phone: '+5491190000006', hora: '13:00', servicio: 'Corte de pelo',       monto: 50000 },
  { phone: '+5491190000003', hora: '15:00', servicio: 'Head Spa completo',   monto: 120000, sena: 12000 },
  { phone: '+5491190000005', hora: '16:30', servicio: 'Brushing / Planchita', monto: 20000 },
  { phone: '+5491190000007', hora: '18:00', servicio: 'Color entero',        monto: 90000,  sena: 9000 },
];

// Conversaciones de WhatsApp con distintos estados, para probar el panorama
const CHATS = [
  { phone: '+5491190000003', msgs: [
    ['user',      'Hola! quería saber si tienen turno para hoy a la tarde'],
    ['assistant', 'Hola Vicky! Sí, tengo las 15:00 disponible para Head Spa. Te la reservo?'],
    ['user',      'Dale, perfecto'],
    ['assistant', 'Listo, te esperamos a las 15:00. Te mandé el link para la seña 💛'],
  ]},
  { phone: '+5491190000006', msgs: [
    ['user',      'Buenas, tengo turno hoy a las 13 no?'],
    ['assistant', 'Hola Romina! Sí, 13:00 corte. Te esperamos!'],
    ['user',      'Puedo llegar 15 minutos tarde?'],
  ]},
  { phone: '+5491190000005', msgs: [
    ['user',      'Hola! cuánto sale el brushing?'],
    ['staff',     'Hola Luciana! El brushing sale $20.000. Querés que te agende?'],
    ['user',      'Sí porfa, hoy a la tarde si se puede'],
  ]},
];

async function limpiar(q) {
  const phones = CLIENTAS.map(c => c.phone);
  await q.query(`DELETE FROM comisiones WHERE payment_id IN
                 (SELECT id FROM payments WHERE client_phone = ANY($1))`, [phones]).catch(() => {});
  await q.query(`DELETE FROM payments            WHERE client_phone = ANY($1)`, [phones]).catch(() => {});
  await q.query(`DELETE FROM bookings            WHERE client_phone = ANY($1)`, [phones]).catch(() => {});
  await q.query(`DELETE FROM conversation_log    WHERE phone        = ANY($1)`, [phones]).catch(() => {});
  await q.query(`DELETE FROM loyalty_transactions WHERE phone       = ANY($1)`, [phones]).catch(() => {});
  await q.query(`DELETE FROM human_mode_control  WHERE phone        = ANY($1)`, [phones]).catch(() => {});
  await q.query(`DELETE FROM client_notes        WHERE ${'client_phone'} = ANY($1)`, [phones]).catch(() => {});
  await q.query(`DELETE FROM client_notes        WHERE phone        = ANY($1)`, [phones]).catch(() => {});
  await q.query(`DELETE FROM clients             WHERE phone        = ANY($1)`, [phones]).catch(() => {});
  await q.query(`DELETE FROM empleados WHERE nombre IN ('Estefanía','Belén','Nadia')`).catch(() => {});
  await q.query(`DELETE FROM productos WHERE nombre IN ('Shampoo Karsell','Ampolla de brillo','Óleo reparador')`).catch(() => {});
  console.log('🧹 Datos de demo borrados');
}

(async () => {
  if (process.env.DEMO_SEED !== 'si') {
    console.error('\n  Falta DEMO_SEED=si — es la traba para no sembrar datos falsos en producción.');
    console.error('  Uso: DEMO_SEED=si DATABASE_URL=... node seed-demo.js\n');
    process.exit(1);
  }
  const q = await db.initDB();
  if (!q) { console.error('Sin DATABASE_URL'); process.exit(1); }
  await ops.initOps();

  await limpiar(q);
  if (process.argv.includes('--limpiar')) process.exit(0);

  const hoy = ops.hoyStr();

  // ── Equipo ────────────────────────────────────────────────────────────────
  for (const [nombre, rol, pct] of [
    ['Estefanía', 'Colorista', 40], ['Belén', 'Estilista', 35], ['Nadia', 'Asistente', 15],
  ]) {
    await q.query(`INSERT INTO empleados (nombre, rol, comision_servicios_pct, activo)
                   VALUES ($1,$2,$3,TRUE)`, [nombre, rol, pct]);
  }

  // ── Productos ─────────────────────────────────────────────────────────────
  for (const [nombre, precio, pct] of [
    ['Shampoo Karsell', 25000, 10], ['Ampolla de brillo', 12000, 15], ['Óleo reparador', 18000, 12],
  ]) {
    await q.query(`INSERT INTO productos (nombre, precio, categoria, comision_pct, activo)
                   VALUES ($1,$2,'Cuidado',$3,TRUE)`, [nombre, precio, pct]);
  }

  // ── Clientas ──────────────────────────────────────────────────────────────
  for (const c of CLIENTAS) {
    await db.clientUpsert(c.phone, c.name, c.email || null, MARCA);
    await q.query(`UPDATE clients SET last_name=$1, visit_count=$2, points=$3, source=$4,
                          last_visit = CASE WHEN $2 > 0 THEN NOW() - INTERVAL '35 days' ELSE NULL END
                   WHERE phone=$5`, [c.last, c.visitas, c.puntos, MARCA, c.phone]);
  }

  // ── Turnos de hoy ─────────────────────────────────────────────────────────
  for (const t of TURNOS) {
    const c = CLIENTAS.find(x => x.phone === t.phone);
    await db.bookingSave({
      sessionId: `demo-${t.hora}`, nombre: `${c.name} ${c.last}`, phone: t.phone,
      servicio: t.servicio, fecha: hoy, hora: t.hora, monto: t.monto,
      senaAmount: t.sena || 0, senaPaid: !!t.sena, status: 'Confirmado',
      email: c.email || null,
    });
  }

  // ── Conversaciones de WhatsApp ────────────────────────────────────────────
  for (const chat of CHATS) {
    for (const [role, content] of chat.msgs) await db.conversationLog(chat.phone, role, content);
  }

  // ── Una ficha de color, para probar que la trae ───────────────────────────
  await q.query(`INSERT INTO client_ficha (client_phone, color_actual, tecnica, alergias, observaciones)
                 VALUES ($1,'Rubio 8.1','Balayage','Ninguna','No le gusta el secador muy caliente')
                 ON CONFLICT DO NOTHING`, ['+5491190000004']).catch(async () => {
    await q.query(`INSERT INTO client_ficha (phone, color_actual, tecnica, alergias, observaciones)
                   VALUES ($1,'Rubio 8.1','Balayage','Ninguna','No le gusta el secador muy caliente')
                   ON CONFLICT DO NOTHING`, ['+5491190000004']).catch(() => {});
  });

  console.log(`
✅ Día de prueba sembrado — ${hoy}

   ${CLIENTAS.length} clientas · ${TURNOS.length} turnos · 3 empleadas · 3 productos
   ${CHATS.length} conversaciones de WhatsApp (2 esperando respuesta)

   Agenda de hoy:`);
  for (const t of TURNOS) {
    const c = CLIENTAS.find(x => x.phone === t.phone);
    console.log(`   ${t.hora}  ${(c.name + ' ' + c.last).padEnd(18)} ${t.servicio.padEnd(22)} ${ops.money(t.monto)}${t.sena ? ` (seña ${ops.money(t.sena)})` : ''}`);
  }
  console.log(`
   Abrí /ops y probá:
     "vino marta, al final se hizo corte y brushing y una ampolla, pagó todo en efectivo"
     "carla no vino"
     "qué le contestamos a luciana?"
     "cuánto debe sofía?"
     "resumen del día"

   Para borrar todo esto: DEMO_SEED=si node seed-demo.js --limpiar
`);
  process.exit(0);
})().catch(e => { console.error('Error sembrando:', e); process.exit(1); });
