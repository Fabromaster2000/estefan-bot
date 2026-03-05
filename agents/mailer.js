// ── MAILER ────────────────────────────────────────────────────────────────────
// Envía emails de confirmación, cancelación y modificación de turnos
// Usa Gmail con contraseña de aplicación (GMAIL_USER + GMAIL_APP_PASSWORD)

let nodemailer;
try { nodemailer = require('nodemailer'); } catch(e) { console.log('[mailer] nodemailer no disponible:', e.message); }

function getTransporter() {
  if (!nodemailer) { console.log('[mailer] nodemailer no instalado'); return null; }
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) { console.log('[mailer] Sin credenciales Gmail (GMAIL_USER/GMAIL_APP_PASSWORD)'); return null; }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

function formatPrecio(n) {
  return '$' + (n||0).toLocaleString('es-AR');
}

// ── EMAIL: TURNO CONFIRMADO ───────────────────────────────────────────────────
async function mailTurnoConfirmado({ to, nombre, servicio, fecha, hora, code, calendarLink, monto, senaAmount, senaPaid }) {
  const transporter = getTransporter();
  if (!transporter || !to) return;

  const saldoRestante = senaAmount ? (monto - senaAmount) : null;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; background: #0e0e0e; color: #f0f0f0; margin: 0; padding: 0; }
  .container { max-width: 520px; margin: 40px auto; background: #1a1a1a; border-radius: 12px; overflow: hidden; }
  .header { background: #1a1a1a; border-bottom: 2px solid #c8a96e; padding: 32px; text-align: center; }
  .header h1 { color: #c8a96e; margin: 0; font-size: 22px; letter-spacing: 1px; }
  .header p { color: #888; margin: 6px 0 0; font-size: 13px; }
  .body { padding: 28px 32px; }
  .greeting { font-size: 16px; color: #f0f0f0; margin-bottom: 20px; }
  .card { background: #242424; border-radius: 8px; padding: 20px; margin: 16px 0; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #333; }
  .row:last-child { border-bottom: none; }
  .label { color: #888; font-size: 13px; }
  .value { color: #f0f0f0; font-size: 13px; font-weight: bold; }
  .code { background: #c8a96e; color: #0e0e0e; font-size: 22px; font-weight: bold; letter-spacing: 3px; text-align: center; padding: 14px; border-radius: 8px; margin: 20px 0; }
  .btn { display: block; background: #c8a96e; color: #0e0e0e; text-decoration: none; text-align: center; padding: 14px 24px; border-radius: 8px; font-weight: bold; font-size: 14px; margin: 20px 0; }
  .pago { background: #1e2a1e; border: 1px solid #2d4a2d; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .pago .row { border-bottom-color: #2d4a2d; }
  .footer { padding: 20px 32px; text-align: center; color: #555; font-size: 12px; border-top: 1px solid #2a2a2a; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>✂️ ESTEFAN PELUQUERÍA</h1>
    <p>Puertos, Buenos Aires</p>
  </div>
  <div class="body">
    <p class="greeting">¡Hola, <strong>${nombre}</strong>! Tu turno está confirmado 💛</p>
    
    <div class="card">
      <div class="row"><span class="label">Servicio</span><span class="value">${servicio}</span></div>
      <div class="row"><span class="label">Fecha</span><span class="value">${fecha}</span></div>
      <div class="row"><span class="label">Hora</span><span class="value">${hora}</span></div>
    </div>

    <p style="color:#888;font-size:12px;text-align:center;margin:8px 0">Tu código de reserva</p>
    <div class="code">${code}</div>
    <p style="color:#888;font-size:11px;text-align:center;margin:-12px 0 16px">Guardalo — con este código podés cambiar o cancelar tu turno</p>

    ${calendarLink ? `<a href="${calendarLink}" class="btn">📅 Agregar al calendario</a>` : ''}

    ${senaAmount ? `
    <div class="pago">
      <p style="color:#4caf50;margin:0 0 10px;font-size:13px;font-weight:bold">💳 Detalle de pago</p>
      <div class="row"><span class="label">Precio total</span><span class="value">${formatPrecio(monto)}</span></div>
      <div class="row"><span class="label">Seña abonada</span><span class="value" style="color:#4caf50">${formatPrecio(senaAmount)} ✓</span></div>
      <div class="row"><span class="label">Saldo a pagar en local</span><span class="value" style="color:#c8a96e">${formatPrecio(saldoRestante)}</span></div>
    </div>
    ` : `
    <div class="card">
      <div class="row"><span class="label">Precio del servicio</span><span class="value">${formatPrecio(monto)}</span></div>
      <div class="row"><span class="label">Pago</span><span class="value">En el local</span></div>
    </div>
    `}

    <p style="color:#888;font-size:13px;margin-top:20px">¿Necesitás cambiar algo? Escribinos por WhatsApp o usá tu código de turno.</p>
  </div>
  <div class="footer">Estefan Peluquería · Puertos, Buenos Aires · Lunes a sábado 10:00–20:00hs</div>
</div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`,
      to,
      subject: `✅ Turno confirmado — ${servicio} el ${fecha}`,
      html
    });
    console.log(`[mailer] ✓ Confirmación enviada a ${to}`);
  } catch(e) {
    console.error('[mailer] Error enviando confirmación:', e.message);
  }
}

// ── EMAIL: TURNO CANCELADO ────────────────────────────────────────────────────
async function mailTurnoCancelado({ to, nombre, servicio, fecha, hora, code }) {
  const transporter = getTransporter();
  if (!transporter || !to) return;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; background: #0e0e0e; color: #f0f0f0; margin: 0; padding: 0; }
  .container { max-width: 520px; margin: 40px auto; background: #1a1a1a; border-radius: 12px; overflow: hidden; }
  .header { background: #1a1a1a; border-bottom: 2px solid #c84a4a; padding: 32px; text-align: center; }
  .header h1 { color: #c8a96e; margin: 0; font-size: 22px; }
  .body { padding: 28px 32px; }
  .card { background: #242424; border-radius: 8px; padding: 20px; margin: 16px 0; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #333; }
  .row:last-child { border-bottom: none; }
  .label { color: #888; font-size: 13px; }
  .value { color: #f0f0f0; font-size: 13px; font-weight: bold; }
  .footer { padding: 20px 32px; text-align: center; color: #555; font-size: 12px; border-top: 1px solid #2a2a2a; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>✂️ ESTEFAN PELUQUERÍA</h1>
  </div>
  <div class="body">
    <p>Hola <strong>${nombre}</strong>, tu turno fue cancelado.</p>
    <div class="card">
      <div class="row"><span class="label">Servicio cancelado</span><span class="value">${servicio}</span></div>
      <div class="row"><span class="label">Fecha</span><span class="value">${fecha}</span></div>
      <div class="row"><span class="label">Hora</span><span class="value">${hora}</span></div>
      <div class="row"><span class="label">Código</span><span class="value">${code}</span></div>
    </div>
    <p style="color:#888;font-size:13px">Cuando quieras reservar de nuevo, escribinos por WhatsApp 💛</p>
  </div>
  <div class="footer">Estefan Peluquería · Puertos, Buenos Aires</div>
</div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`,
      to,
      subject: `Turno cancelado — ${servicio}`,
      html
    });
    console.log(`[mailer] ✓ Cancelación enviada a ${to}`);
  } catch(e) {
    console.error('[mailer] Error enviando cancelación:', e.message);
  }
}

// ── EMAIL: TURNO MODIFICADO ───────────────────────────────────────────────────
async function mailTurnoModificado({ to, nombre, servicio, fechaAnterior, horaAnterior, fechaNueva, horaNueva, code, calendarLink, monto }) {
  const transporter = getTransporter();
  if (!transporter || !to) return;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; background: #0e0e0e; color: #f0f0f0; margin: 0; padding: 0; }
  .container { max-width: 520px; margin: 40px auto; background: #1a1a1a; border-radius: 12px; overflow: hidden; }
  .header { background: #1a1a1a; border-bottom: 2px solid #c8a96e; padding: 32px; text-align: center; }
  .header h1 { color: #c8a96e; margin: 0; font-size: 22px; }
  .body { padding: 28px 32px; }
  .card { background: #242424; border-radius: 8px; padding: 20px; margin: 16px 0; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #333; }
  .row:last-child { border-bottom: none; }
  .label { color: #888; font-size: 13px; }
  .value { color: #f0f0f0; font-size: 13px; font-weight: bold; }
  .old { color: #555; text-decoration: line-through; font-size: 12px; }
  .new { color: #c8a96e; font-weight: bold; }
  .code { background: #c8a96e; color: #0e0e0e; font-size: 22px; font-weight: bold; letter-spacing: 3px; text-align: center; padding: 14px; border-radius: 8px; margin: 20px 0; }
  .btn { display: block; background: #c8a96e; color: #0e0e0e; text-decoration: none; text-align: center; padding: 14px 24px; border-radius: 8px; font-weight: bold; font-size: 14px; margin: 20px 0; }
  .footer { padding: 20px 32px; text-align: center; color: #555; font-size: 12px; border-top: 1px solid #2a2a2a; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>✂️ ESTEFAN PELUQUERÍA</h1>
  </div>
  <div class="body">
    <p>¡Hola, <strong>${nombre}</strong>! Tu turno fue reprogramado 💛</p>
    <div class="card">
      <div class="row"><span class="label">Servicio</span><span class="value">${servicio}</span></div>
      <div class="row">
        <span class="label">Fecha</span>
        <span class="value"><span class="old">${fechaAnterior}</span> → <span class="new">${fechaNueva}</span></span>
      </div>
      <div class="row">
        <span class="label">Hora</span>
        <span class="value"><span class="old">${horaAnterior}</span> → <span class="new">${horaNueva}</span></span>
      </div>
      <div class="row"><span class="label">Precio</span><span class="value">${formatPrecio(monto)}</span></div>
    </div>

    <p style="color:#888;font-size:12px;text-align:center;margin:8px 0">Tu nuevo código de reserva</p>
    <div class="code">${code}</div>

    ${calendarLink ? `<a href="${calendarLink}" class="btn">📅 Agregar al calendario</a>` : ''}

    <p style="color:#888;font-size:13px">¿Necesitás otro cambio? Escribinos por WhatsApp con tu código.</p>
  </div>
  <div class="footer">Estefan Peluquería · Puertos, Buenos Aires · Lunes a sábado 10:00–20:00hs</div>
</div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`,
      to,
      subject: `📅 Turno reprogramado — ${servicio} el ${fechaNueva}`,
      html
    });
    console.log(`[mailer] ✓ Modificación enviada a ${to}`);
  } catch(e) {
    console.error('[mailer] Error enviando modificación:', e.message);
  }
}

// ── COMPROBANTE DE PAGO ───────────────────────────────────────────────────────
async function mailComprobante({ to, nombre, numero, servicios, productos,
  totalServicios, totalProductos, descuento, total, medioPago, pointsEarned }) {

  const transporter = getTransporter();
  if (!transporter || !to) return;

  const srvRows = (servicios||[]).map(s =>
    `<tr><td style="padding:5px 0;color:#555">${s.nombre}</td><td style="text-align:right;padding:5px 0">$${(s.monto||0).toLocaleString('es-AR')}</td></tr>`
  ).join('');
  const prodRows = (productos||[]).map(p =>
    `<tr><td style="padding:5px 0;color:#555">${p.nombre} x${p.cantidad}</td><td style="text-align:right;padding:5px 0">$${(p.precio*p.cantidad).toLocaleString('es-AR')}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    body{font-family:'Helvetica Neue',sans-serif;background:#f5f0f2;margin:0;padding:20px;}
    .wrap{max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 20px rgba(0,0,0,.08);}
    .header{background:linear-gradient(135deg,#e8447a,#a020a0);padding:32px 24px;text-align:center;color:#fff;}
    .header h1{font-size:22px;margin:8px 0 4px;}
    .header p{font-size:13px;opacity:.8;margin:0;}
    .body{padding:28px 24px;}
    table{width:100%;border-collapse:collapse;font-size:14px;}
    .section-label{font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 6px;}
    .total-row{font-size:16px;font-weight:700;border-top:2px solid #f0e8ec;padding-top:10px;margin-top:4px;}
    .pts{background:#fffbf0;border:1px solid #f0d080;border-radius:8px;padding:10px 14px;font-size:13px;color:#a07820;margin-top:14px;}
    .footer{background:#f5f0f2;text-align:center;padding:16px;font-size:12px;color:#999;}
  </style></head><body>
  <div class="wrap">
    <div class="header">
      <div style="font-size:32px">✂️</div>
      <h1>Comprobante de pago</h1>
      <p>N° #${numero} · ${new Date().toLocaleDateString('es-AR')}</p>
    </div>
    <div class="body">
      <p style="font-size:15px">Hola <strong>${nombre}</strong>,<br>gracias por tu visita 💛 Te enviamos el detalle de tu pago.</p>
      <div class="section-label">Detalle</div>
      <table>
        ${srvRows ? `<tr><td colspan="2" style="font-size:11px;font-weight:600;color:#bbb;text-transform:uppercase;padding-bottom:4px">Servicios</td></tr>${srvRows}` : ''}
        ${prodRows ? `<tr><td colspan="2" style="font-size:11px;font-weight:600;color:#bbb;text-transform:uppercase;padding:10px 0 4px">Productos</td></tr>${prodRows}` : ''}
        ${descuento ? `<tr><td style="padding:5px 0;color:#e85c5c">Descuento</td><td style="text-align:right;color:#e85c5c">-$${descuento.toLocaleString('es-AR')}</td></tr>` : ''}
        <tr class="total-row"><td>TOTAL</td><td style="text-align:right;color:#e8447a">$${total.toLocaleString('es-AR')}</td></tr>
      </table>
      <div class="section-label" style="margin-top:16px">Medio de pago</div>
      <p style="font-size:14px;margin:4px 0">${medioPago}</p>
      ${pointsEarned > 0 ? `<div class="pts">⭐ Ganaste <strong>+${pointsEarned} puntos</strong> con esta visita</div>` : ''}
    </div>
    <div class="footer">Estefan Peluquería · Puertos, Buenos Aires · Lunes a sábado 10:00–20:00hs</div>
  </div>
  </body></html>`;

  try {
    await transporter.sendMail({
      from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`,
      to,
      subject: `🧾 Comprobante N° #${numero} — Estefan Peluquería`,
      html
    });
    console.log(`[mailer] ✓ Comprobante #${numero} enviado a ${to}`);
  } catch(e) {
    console.error('[mailer] Error comprobante:', e.message);
  }
}

module.exports = { mailTurnoConfirmado, mailTurnoCancelado, mailTurnoModificado, mailComprobante };
