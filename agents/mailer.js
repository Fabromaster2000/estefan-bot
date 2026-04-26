// ── MAILER ──────────────────────────────────────────────────────────────────────
// Envía emails de confirmación, cancelación y modificación de turnos
// Usa Gmail con contraseña de aplicación (GMAIL_USER + GMAIL_APP_PASSWORD)
let nodemailer;
try { nodemailer = require('nodemailer'); } catch(e) { console.log('[mailer] nodemailer no disponible:', e.message); }

// (LOGO_ESTEFAN: base64 inline — copiá el valor del mailer original)
const LOGO_ESTEFAN = process.env.LOGO_ESTEFAN_B64 || '';

function getTransporter() {
  if (!nodemailer) { console.log('[mailer] nodemailer no instalado'); return null; }
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) { console.log('[mailer] Sin credenciales Gmail'); return null; }
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

function formatPrecio(n) { return '$' + (n||0).toLocaleString('es-AR'); }

const EMAIL_BASE_STYLE = `
  body{font-family:Arial,sans-serif;background:#0e0e0e;color:#f0f0f0;margin:0;padding:0;}
  .container{max-width:520px;margin:40px auto;background:#1a1a1a;border-radius:12px;overflow:hidden;}
  .header{background:#0e0e0e;border-bottom:2px solid #c8a96e;padding:20px 32px;text-align:center;}
  .header img{display:block;margin:0 auto;max-width:140px;height:auto;}
  .body{padding:28px 32px;}
  .greeting{font-size:16px;color:#f0f0f0;margin-bottom:20px;}
  .card{background:#242424;border-radius:8px;padding:20px;margin:16px 0;}
  .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #333;}
  .row:last-child{border-bottom:none;}
  .label{color:#888;font-size:13px;}
  .value{color:#f0f0f0;font-size:13px;font-weight:bold;}
  .code{background:#c8a96e;color:#0e0e0e;font-size:22px;font-weight:bold;letter-spacing:3px;text-align:center;padding:14px;border-radius:8px;margin:20px 0;}
  .btn{display:block;background:#c8a96e;color:#0e0e0e;text-decoration:none;text-align:center;padding:14px 24px;border-radius:8px;font-weight:bold;font-size:14px;margin:20px 0;}
  .footer{padding:20px 32px;text-align:center;color:#555;font-size:12px;border-top:1px solid #2a2a2a;}
`;

// ── EMAIL: TURNO CONFIRMADO ──────────────────────────────────────────────────────
async function mailTurnoConfirmado({ to, nombre, servicio, fecha, hora, code, calendarLink, monto, senaAmount, senaPaid }) {
  const transporter = getTransporter();
  if (!transporter || !to) return;
  const saldoRestante = senaAmount ? (monto - senaAmount) : null;
  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EMAIL_BASE_STYLE}
.pago{background:#1e2a1e;border:1px solid #2d4a2d;border-radius:8px;padding:16px;margin:16px 0;}
.pago .row{border-bottom-color:#2d4a2d;}
</style></head>
<body><div class="container">
  <div class="header"><img src="${LOGO_ESTEFAN}" alt="Estefan Peluquería"></div>
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
    </div>` : `
    <div class="card">
      <div class="row"><span class="label">Precio del servicio</span><span class="value">${formatPrecio(monto)}</span></div>
      <div class="row"><span class="label">Pago</span><span class="value">En el local</span></div>
    </div>`}
    <p style="color:#888;font-size:13px;margin-top:20px">¿Necesitás cambiar algo? Escribinos por WhatsApp o usá tu código de turno.</p>
  </div>
  <div class="footer">Estefan Peluquería · Puertos, Buenos Aires · Lunes a sábado 10:00–20:00hs</div>
</div></body></html>`;
  try {
    await transporter.sendMail({ from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`, to, subject: `✅ Turno confirmado — ${servicio} el ${fecha}`, html });
    console.log(`[mailer] ✓ Confirmación enviada a ${to}`);
  } catch(e) { console.error('[mailer] Error enviando confirmación:', e.message); }
}

// ── EMAIL: TURNO CANCELADO ────────────────────────────────────────────────────────
async function mailTurnoCancelado({ to, nombre, servicio, fecha, hora, code }) {
  const transporter = getTransporter();
  if (!transporter || !to) return;
  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EMAIL_BASE_STYLE}
.header{border-bottom-color:#c84a4a !important;}
</style></head>
<body><div class="container">
  <div class="header"><img src="${LOGO_ESTEFAN}" alt="Estefan Peluquería"></div>
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
</div></body></html>`;
  try {
    await transporter.sendMail({ from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`, to, subject: `Turno cancelado — ${servicio}`, html });
    console.log(`[mailer] ✓ Cancelación enviada a ${to}`);
  } catch(e) { console.error('[mailer] Error enviando cancelación:', e.message); }
}

// ── EMAIL: TURNO MODIFICADO ────────────────────────────────────────────────────────
async function mailTurnoModificado({ to, nombre, servicio, fechaAnterior, horaAnterior, fechaNueva, horaNueva, code, calendarLink, monto }) {
  const transporter = getTransporter();
  if (!transporter || !to) return;
  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EMAIL_BASE_STYLE}
.old{color:#555;text-decoration:line-through;font-size:12px;}
.new{color:#c8a96e;font-weight:bold;}
</style></head>
<body><div class="container">
  <div class="header"><img src="${LOGO_ESTEFAN}" alt="Estefan Peluquería"></div>
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
</div></body></html>`;
  try {
    await transporter.sendMail({ from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`, to, subject: `📅 Turno reprogramado — ${servicio} el ${fechaNueva}`, html });
    console.log(`[mailer] ✓ Modificación enviada a ${to}`);
  } catch(e) { console.error('[mailer] Error enviando modificación:', e.message); }
}

// ── COMPROBANTE DE PAGO ──────────────────────────────────────────────────────────
async function mailComprobante({ to, nombre, numero, servicios, productos, totalServicios, totalProductos, descuento, total, medioPago, pointsEarned, senaPagada = 0, splits = [] }) {
  const transporter = getTransporter();
  if (!transporter || !to) return;
  const srvRows = (servicios||[]).map(s =>
    `<tr><td style="padding:5px 0;color:#555">${s.nombre}</td><td style="text-align:right;padding:5px 0">$${(s.monto||0).toLocaleString('es-AR')}</td></tr>`
  ).join('');
  const prodRows = (productos||[]).map(p =>
    `<tr><td style="padding:5px 0;color:#555">${p.nombre} x${p.cantidad}</td><td style="text-align:right;padding:5px 0">$${(p.precio*p.cantidad).toLocaleString('es-AR')}</td></tr>`
  ).join('');
  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{font-family:'Helvetica Neue',sans-serif;background:#0e0e0e;margin:0;padding:20px;}
  .wrap{max-width:480px;margin:0 auto;background:#1a1a1a;border-radius:16px;overflow:hidden;box-shadow:0 2px 20px rgba(0,0,0,.4);}
  .header{background:#0e0e0e;border-bottom:2px solid #c8a96e;padding:24px;text-align:center;}
  .header img{display:block;margin:0 auto 12px;max-width:140px;height:auto;}
  .header h1{font-size:22px;margin:8px 0 4px;color:#c8a96e;}
  .header p{font-size:13px;opacity:.7;margin:0;color:#f0f0f0;}
  .body{padding:28px 24px;color:#f0f0f0;}
  table{width:100%;border-collapse:collapse;font-size:14px;}
  .section-label{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 6px;}
  .total-row{font-size:16px;font-weight:700;border-top:2px solid #333;padding-top:10px;margin-top:4px;}
  .pts{background:#1e1a00;border:1px solid #c8a96e;border-radius:8px;padding:10px 14px;font-size:13px;color:#c8a96e;margin-top:14px;}
  .footer{background:#111;text-align:center;padding:16px;font-size:12px;color:#555;}
</style></head><body>
<div class="wrap">
  <div class="header">
    <img src="${LOGO_ESTEFAN}" alt="Estefan Peluquería">
    <h1>Comprobante de pago</h1>
    <p>N° #${numero} · ${new Date().toLocaleDateString('es-AR')}</p>
  </div>
  <div class="body">
    <p style="font-size:15px;margin-bottom:16px">Hola <strong>${nombre}</strong>,<br>gracias por tu visita 💛 Te enviamos el detalle de tu pago.</p>
    <div class="section-label">Detalle</div>
    <table>
      ${srvRows ? `<tr><td colspan="2" style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;padding-bottom:4px">Servicios</td></tr>${srvRows}` : ''}
      ${prodRows ? `<tr><td colspan="2" style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;padding:10px 0 4px">Productos</td></tr>${prodRows}` : ''}
      ${descuento ? `<tr><td style="padding:5px 0;color:#c4685a">Descuento</td><td style="text-align:right;color:#c4685a">-$${descuento.toLocaleString('es-AR')}</td></tr>` : ''}
      ${senaPagada > 0 ? `<tr><td style="padding:5px 0;color:#4caf50">Seña ya abonada</td><td style="text-align:right;color:#4caf50">-$${senaPagada.toLocaleString('es-AR')} ✓</td></tr>` : ''}
      <tr class="total-row"><td style="color:#f0f0f0">TOTAL ABONADO HOY</td><td style="text-align:right;color:#c8a96e">$${total.toLocaleString('es-AR')}</td></tr>
    </table>
    <div class="section-label" style="margin-top:16px">Medio de pago</div>
    <p style="font-size:14px;margin:4px 0;color:#f0f0f0">${
      splits && splits.filter(s=>parseFloat(s.monto)>0).length > 1
        ? splits.filter(s=>parseFloat(s.monto)>0).map(s=>`${s.medio} <strong>$${Number(s.monto).toLocaleString('es-AR')}</strong>`).join(' + ')
        : medioPago
    }</p>
    ${pointsEarned > 0 ? `<div class="pts">⭐ Ganaste <strong>+${pointsEarned} puntos</strong> con esta visita</div>` : ''}
  </div>
  <div class="footer">Estefan Peluquería · Puertos, Buenos Aires · Lunes a sábado 10:00–20:00hs</div>
</div>
</body></html>`;
  try {
    await transporter.sendMail({ from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`, to, subject: `🧾 Comprobante N° #${numero} — Estefan Peluquería`, html });
    console.log(`[mailer] ✓ Comprobante #${numero} enviado a ${to}`);
  } catch(e) { console.error('[mailer] Error comprobante:', e.message); }
}

// ── NOTIF ADMIN ──────────────────────────────────────────────────────────────────
async function mailNotifAdmin({ asunto, html }) {
  const t = getTransporter();
  if (!t) return;
  const adminEmail = process.env.GMAIL_USER;
  if (!adminEmail) return;
  const ADMIN_NOTIF = process.env.ADMIN_EMAIL || 'faberalbi@gmail.com';
  try {
    await t.sendMail({
      from: `"Estefan Peluquería Bot" <${adminEmail}>`,
      to: ADMIN_NOTIF,
      subject: asunto,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;background:#1a1a1a;color:#f0f0f0">
        <img src="${LOGO_ESTEFAN}" alt="Estefan" style="height:40px;margin-bottom:16px">
        <h2 style="color:#c8a96e">${asunto}</h2>
        ${html}
        <hr style="margin-top:30px;border:none;border-top:1px solid #333">
        <p style="color:#555;font-size:12px">Notificación automática — Estefan Peluquería</p>
      </div>`
    });
    console.log('[mailer] ✓ Notif admin enviada:', asunto);
  } catch(e) { console.error('[mailer] Error notif admin:', e.message); }
}

// ── EMAIL: GIFT CARD ─────────────────────────────────────────────────────────────
async function mailGiftCard({ gc }) {
  const transporter = getTransporter();
  if (!transporter || !gc || !gc.recipient_email) return;

  const tipoLabel = gc.tipo === 'servicio'
    ? `Servicio: <strong>${gc.servicio}</strong>`
    : gc.tipo === 'puntos'
    ? `<strong>${gc.puntos} puntos</strong> de fidelidad`
    : `Crédito de <strong>${formatPrecio(gc.monto)}</strong>`;

  const expira = new Date(gc.expires_at).toLocaleDateString('es-AR', {
    day: '2-digit', month: 'long', year: 'numeric'
  });

  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{font-family:'Helvetica Neue',sans-serif;background:#0e0e0e;margin:0;padding:20px;}
  .wrap{max-width:480px;margin:0 auto;background:#1a1a1a;border-radius:16px;overflow:hidden;box-shadow:0 2px 20px rgba(0,0,0,.4);}
  .header{background:#0e0e0e;border-bottom:2px solid #c8a96e;padding:24px;text-align:center;}
  .header img{display:block;margin:0 auto 12px;max-width:140px;height:auto;}
  .header h1{font-size:20px;margin:8px 0 4px;color:#c8a96e;}
  .body{padding:28px 24px;color:#f0f0f0;}
  .gc-code{background:linear-gradient(135deg,#c8a96e,#a07840);color:#0e0e0e;font-size:26px;font-weight:bold;letter-spacing:5px;text-align:center;padding:20px;border-radius:12px;margin:20px 0;}
  .detail{background:#242424;border-radius:8px;padding:16px;margin:16px 0;}
  .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #2e2e2e;}
  .row:last-child{border-bottom:none;}
  .label{color:#888;font-size:13px;}
  .value{color:#f0f0f0;font-size:13px;font-weight:bold;}
  .footer{background:#111;text-align:center;padding:16px;font-size:12px;color:#555;}
</style></head><body>
<div class="wrap">
  <div class="header">
    <img src="${LOGO_ESTEFAN}" alt="Estefan Peluquería">
    <h1>🎁 ¡Recibiste una Gift Card!</h1>
  </div>
  <div class="body">
    <p style="font-size:15px;margin-bottom:8px">
      Hola <strong>${gc.recipient_name}</strong>,<br>
      ${gc.buyer_name ? `<strong>${gc.buyer_name}</strong> te regaló` : 'Recibiste'} una gift card de <strong>Estefan Peluquería</strong> 💛
    </p>
    <p style="color:#888;font-size:12px;text-align:center;margin:16px 0 4px">Tu código de regalo</p>
    <div class="gc-code">${gc.code}</div>
    <div class="detail">
      <div class="row"><span class="label">Contenido</span><span class="value">${tipoLabel}</span></div>
      <div class="row"><span class="label">Válida hasta</span><span class="value">${expira}</span></div>
    </div>
    <p style="color:#888;font-size:13px;margin-top:20px">
      Presentá este código en el salón o mencionáselo a la staff al confirmar tu turno.<br>
      ¡Esperamos verte pronto! ✂️
    </p>
  </div>
  <div class="footer">Estefan Peluquería · Puertos, Buenos Aires · Lunes a sábado 10:00–20:00hs</div>
</div>
</body></html>`;

  try {
    await transporter.sendMail({
      from: `"Estefan Peluquería" <${process.env.GMAIL_USER}>`,
      to: gc.recipient_email,
      subject: `🎁 Tu Gift Card de Estefan Peluquería — ${gc.code}`,
      html,
    });
    console.log(`[mailer] ✓ Gift card ${gc.code} enviada a ${gc.recipient_email}`);
  } catch(e) { console.error('[mailer] Error enviando gift card:', e.message); }
}

module.exports = {
  mailTurnoConfirmado,
  mailTurnoCancelado,
  mailTurnoModificado,
  mailComprobante,
  mailNotifAdmin,
  mailGiftCard,
};