// ── CORE: CALENDAR ───────────────────────────────────────────────────────────
// Google Calendar — crear eventos, agregar invitados, generar links
// Soporta OAuth (usuario) y Service Account

const axios = require('axios');




function setGoogleTokens(tokens) { googleTokens = tokens; }
function getGoogleTokens() { return googleTokens; }

async function refreshGoogleToken() {
  if (!googleTokens?.refresh_token) return false;
  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: googleTokens.refresh_token,
      grant_type:    'refresh_token',
    });
    googleTokens.access_token = res.data.access_token;
    googleTokens.expiry_date  = Date.now() + (res.data.expires_in * 1000);
    await saveTokensToDB(googleTokens);
    return true;
  } catch(e) {
    console.error('[google] Refresh failed:', e.message);
    return false;
  }
}

async function getValidAccessToken() {
  if (!googleTokens) return null;
  if (Date.now() > (googleTokens.expiry_date - 60000)) await refreshGoogleToken();
  return googleTokens.access_token;
}

// ── SERVICE ACCOUNT AUTH (para Sheets) ───────────────────────────────────────
let serviceAccountToken = null;
let serviceAccountTokenExpiry = 0;

async function getServiceAccountToken() {
  if (serviceAccountToken && Date.now() < serviceAccountTokenExpiry - 60000) {
    return serviceAccountToken;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!email || !privateKey) {
    console.log('[sa] Sin credenciales de service account');
    return null;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const crypto = require('crypto');
    
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const claimSet = Buffer.from(JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const sigInput = `${header}.${claimSet}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(sigInput);
    sign.end();
    const sig = sign.sign(privateKey, 'base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const jwt = `${sigInput}.${sig}`;

    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    });

    const res = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    serviceAccountToken = res.data.access_token;
    serviceAccountTokenExpiry = Date.now() + (res.data.expires_in * 1000);
    console.log('[sa] ✓ Token obtenido, longitud:', serviceAccountToken?.length);
    console.log('[sa] Token preview:', serviceAccountToken?.slice(0, 50));
    console.log('[sa] Full response keys:', Object.keys(res.data).join(', '));
    return serviceAccountToken;
  } catch(e) {
    console.error('[sa] Error obteniendo token:', JSON.stringify(e.response?.data) || e.message);
    return null;
  }
}

// ── GOOGLE CALENDAR ───────────────────────────────────────────────────────────
// Helper: format date as Argentina local ISO string (no UTC conversion)
function toArgentinaISO(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00-03:00`;
}
async function addToCalendar({ clientName, phone, service, date, time, duration, sena }) {
  const token = await getValidAccessToken();
  if (!token) { console.log('[calendar] Sin token — turno no agregado'); return null; }

  const now = new Date();
  let startDate;
  try {
    // Parsear hora (acepta "10:00", "10:00 am", "14hs", "14h", "14")
    let hours = 10, minutes = 0;
    if (time) {
      const t = time.toLowerCase().replace(/hs?$/, '').replace(/ ?(am|pm)/, '').trim();
      const tp = t.split(':');
      hours = parseInt(tp[0]) || 10;
      minutes = parseInt(tp[1]) || 0;
      if (time.toLowerCase().includes('pm') && hours < 12) hours += 12;
    }

    // Parsear fecha
    const months = {enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11};
    const days = {domingo:0,lunes:1,martes:2,miercoles:3,miércoles:3,jueves:4,viernes:5,sabado:6,sábado:6};
    const dateStr = (date || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');

    startDate = null;

    // Prioridad 1: fecha con número Y mes (ej: "4 de marzo", "martes 4 de marzo", "7 de marzo")
    const dayNumMatch = dateStr.match(/(\d{1,2})\s+de\s+(\w+)/);
    const monthFromMatch = dayNumMatch ? months[dayNumMatch[2]] : undefined;
    if (dayNumMatch && monthFromMatch !== undefined) {
      const day = parseInt(dayNumMatch[1]);
      startDate = new Date(now.getFullYear(), monthFromMatch, day, hours, minutes, 0);
      if (startDate < now) startDate.setFullYear(now.getFullYear() + 1);
    }

    // Prioridad 2: formato dd/mm o dd/mm/yyyy
    if (!startDate) {
      const slashMatch = dateStr.match(/(\d{1,2})[\/](\d{1,2})(?:[\/](\d{2,4}))?/);
      if (slashMatch) {
        const day = parseInt(slashMatch[1]);
        const month = parseInt(slashMatch[2]) - 1;
        const year = slashMatch[3] ? parseInt(slashMatch[3]) : now.getFullYear();
        startDate = new Date(year < 100 ? 2000 + year : year, month, day, hours, minutes, 0);
      }
    }

    // Prioridad 3: solo nombre de día de la semana
    if (!startDate) {
      const dayName = Object.keys(days).find(d => dateStr.includes(d));
      if (dayName !== undefined) {
        const targetDay = days[dayName];
        startDate = new Date(now);
        startDate.setHours(hours, minutes, 0, 0);
        const currentDay = startDate.getDay();
        let daysAhead = targetDay - currentDay;
        if (daysAhead < 0) daysAhead += 7;
        if (daysAhead === 0) {
          // Same day — only use today if the time hasn't passed yet
          const testDate = new Date(now);
          testDate.setHours(hours, minutes, 0, 0);
          if (testDate <= now) daysAhead = 7; // already passed, go next week
        }
        startDate.setDate(startDate.getDate() + daysAhead);
      }
    }

    // Fallback
    if (!startDate) {
      startDate = new Date(now.getTime() + 86400000);
      startDate.setHours(hours, minutes, 0, 0);
    }
  } catch(e) {
    console.error('[calendar] Error parseando fecha:', e.message, '| date:', date, '| time:', time);
    startDate = new Date(now.getTime() + 86400000);
    startDate.setHours(10, 0, 0, 0);
  }
  const pad = n => String(n).padStart(2, '0');
  const fechaFormateada = `${pad(startDate.getDate())}/${pad(startDate.getMonth()+1)}/${startDate.getFullYear()}`;
  const horaFormateada = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;
  console.log(`[calendar] Fecha parseada: ${startDate.toLocaleString('es-AR')} → ${fechaFormateada} (input: "${date}" "${time}")`);

  const endDate = new Date(startDate.getTime() + (duration || 60) * 60000);

  try {
    const res = await axios.post(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`,
      {
        summary:     `✂️ ${service} — ${clientName}`,
        description: `📱 Tel: ${phone}\n💰 Seña: ${sena ? '$' + sena.toLocaleString('es-AR') + ' (pagada)' : 'Sin seña'}\n🤖 Bot`,
        start: { dateTime: toArgentinaISO(startDate), timeZone: 'America/Argentina/Buenos_Aires' },
        end:   { dateTime: toArgentinaISO(endDate),   timeZone: 'America/Argentina/Buenos_Aires' },
        colorId: '6',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('[calendar] ✓ Evento creado:', res.data.id);
    return { ...res.data, fechaFormateada, horaFormateada };
  } catch(e) {
    console.error('[calendar] Error:', e.response?.data || e.message);
    return null;
  }
}

// ── GOOGLE SHEETS ────────────────────────────────────────────────────────────
const SHEET_TURNOS     = 'Turnos';
const SHEET_HOY        = 'Hoy';
const SHEET_FACTURA    = 'Facturación';
const SHEET_CLIENTES   = 'Clientes';
const SHEET_METRICAS   = 'Métricas';


function generateCalendarLink(nombre, servicio, fechaFormateada, horaFormateada) {
  try {
    const [day, month, year] = fechaFormateada.split('/').map(Number);
    const [hours, minutes] = horaFormateada.split(':').map(Number);
    const pad = n => String(n).padStart(2, '0');
    const dtStart = year + pad(month) + pad(day) + 'T' + pad(hours) + pad(minutes) + '00';
    const endHour = hours + 1;
    const dtEnd = year + pad(month) + pad(day) + 'T' + pad(endHour) + pad(minutes) + '00';
    const title = encodeURIComponent(servicio + ' — Estefan Peluqueria');
    const details = encodeURIComponent('Turno en Estefan Peluqueria, Puertos. Codigo de reserva disponible en WhatsApp.');
    const location = encodeURIComponent('Estefan Peluqueria, Puertos, Buenos Aires');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + title + '&dates=' + dtStart + '/' + dtEnd + '&details=' + details + '&location=' + location;
  } catch(e) { return null; }
}

async function addGuestToCalendarEvent(eventId, email) {
  try {
    const token = await getValidAccessToken();
    if (!token) return false;
    // Get current event
    const res = await axios.get(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events/${eventId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const event = res.data;
    const attendees = event.attendees || [];
    if (attendees.some(a => a.email === email)) return true; // already added
    attendees.push({ email, responseStatus: 'accepted' });
    await axios.patch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events/${eventId}`,
      { attendees, guestsCanModifyEvent: false, guestsCanSeeOtherGuests: false },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[calendar] ✓ Invitado agregado: ${email}`);
    return true;
  } catch(e) {
    console.error('[calendar] Error agregando invitado:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

// ── CANCEL BOOKING ───────────────────────────────────────────────────────────
async function cancelBooking(phone, bookingId, status = 'Cancelado') {
  if (!db) return false;
  try {
    // Get booking details
    const res = await db.query(
      'SELECT * FROM bookings WHERE id = $1 AND client_phone = $2',
      [bookingId, phone]
    );
    if (!res.rows.length) return false;
    const booking = res.rows[0];

    // Delete from Calendar if we have the event ID
    if (booking.calendar_event_id && googleTokens) {
      try {
        const token = await getValidAccessToken();
        await axios.delete(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events/${booking.calendar_event_id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log(`[cancel] ✓ Evento eliminado del calendario: ${booking.calendar_event_id}`);
      } catch(e) {
        console.log(`[cancel] Calendar delete failed (may already be gone):`, e.response?.status);
      }
    }

    // Update DB status
    const dbStatus = status === 'Reprogramado' ? 'rescheduled' : 'cancelled';
    await db.query('UPDATE bookings SET status = $1 WHERE id = $2', [dbStatus, bookingId]);

    // Update Sheets - use booking_code if available for precise matching
    await updateTurnoStatus(booking.booking_code || booking.client_name, booking.service, status);

    console.log(`[cancel] ✓ Turno ${dbStatus}: ${booking.client_name} — ${booking.service}`);
    return booking;
  } catch(e) {
    console.error('[cancel] Error:', e.message);
    return false;
  }
}

async function getActiveBookings(phone) {
  if (!db) return [];
  try {
    const res = await db.query(
      `SELECT * FROM bookings WHERE client_phone = $1 AND status = 'confirmed' ORDER BY created_at DESC LIMIT 5`,
      [phone]
    );
    return res.rows;
  } catch(e) { return []; }
}

module.exports = { setGoogleTokens, getGoogleTokens, refreshGoogleToken, getValidAccessToken, getServiceAccountToken, addToCalendar, addGuestToCalendarEvent, generateCalendarLink };
