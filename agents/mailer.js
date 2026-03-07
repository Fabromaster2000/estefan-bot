// ── MAILER ────────────────────────────────────────────────────────────────────
// Envía emails de confirmación, cancelación y modificación de turnos
// Usa Gmail con contraseña de aplicación (GMAIL_USER + GMAIL_APP_PASSWORD)
let nodemailer;
try { nodemailer = require('nodemailer'); } catch(e) { console.log('[mailer] nodemailer no disponible:', e.message); }
const LOGO_ESTEFAN = 'data:image/jpeg;base64,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';

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
  <div class="header" style="background:#0e0e0e;border-bottom:2px solid #c8a96e;padding:20px 32px;text-align:center;">
    <img src="${LOGO_ESTEFAN}" alt="Estefan" width="160" style="display:block;margin:0 auto;max-width:160px;height:auto;border-radius:4px;">
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
  <div class="header" style="background:#0e0e0e;border-bottom:2px solid #c8a96e;padding:20px 32px;text-align:center;">
    <img src="${LOGO_ESTEFAN}" alt="Estefan" width="160" style="display:block;margin:0 auto;max-width:160px;height:auto;border-radius:4px;">
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
  <div class="header" style="background:#0e0e0e;border-bottom:2px solid #c8a96e;padding:20px 32px;text-align:center;">
    <img src="${LOGO_ESTEFAN}" alt="Estefan" width="160" style="display:block;margin:0 auto;max-width:160px;height:auto;border-radius:4px;">
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
      <img src="${LOGO_ESTEFAN}" alt="Estefan" width="140" style="display:block;margin:0 auto 12px;max-width:140px;height:auto;border-radius:4px;">
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
async function mailNotifAdmin({ asunto, html }) {
  const t = getTransporter();
  if (!t) return;
  const adminEmail = process.env.GMAIL_USER;
  if (!adminEmail) return;
  try {
    await t.sendMail({
      from: `"Estefan Peluquería Bot" <${adminEmail}>`,
      to: adminEmail,
      subject: asunto,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <h2 style="color:#e91e8c">${asunto}</h2>
        ${html}
        <hr style="margin-top:30px;border:none;border-top:1px solid #eee">
        <p style="color:#999;font-size:12px">Notificación automática — Estefan Peluquería</p>
      </div>`
    });
    console.log('[mailer] ✓ Notif admin enviada:', asunto);
  } catch(e) { console.error('[mailer] Error notif admin:', e.message); }
}
module.exports = { mailTurnoConfirmado, mailTurnoCancelado, mailTurnoModificado, mailComprobante, mailNotifAdmin };
