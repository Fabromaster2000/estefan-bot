// ── CORE: UTILS ───────────────────────────────────────────────────────────────

// Formatear fecha para mostrar al usuario
async function formatFecha(fechaStr) {
  if (!fechaStr) return fechaStr;
  try {
    const [d, m, y] = fechaStr.split('/');
    const date = new Date(y, m - 1, d);
    const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    return `${dias[date.getDay()]} ${d} de ${meses[date.getMonth()]} de ${y}`;
  } catch(e) { return fechaStr; }
}

// Normalizar día escrito libremente
function normalizeDia(input) {
  const map = {
    lunes: /^(lun|lunes|lums|lumes)$/i,
    martes: /^(mar|martes|martest)$/i,
    miércoles: /^(mie|mier|miercoles|miércoles|mierc)$/i,
    jueves: /^(jue|jueves|juev)$/i,
    viernes: /^(vie|viernes|vier)$/i,
    sábado: /^(sab|sábado|sabado|sáb)$/i,
  };
  for (const [dia, regex] of Object.entries(map)) {
    if (regex.test(input?.trim())) return dia;
  }
  return null;
}

// Normalizar hora
function normalizeHora(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  // "14:00" o "14.00"
  const exact = s.match(/^(\d{1,2})[:.h](\d{2})$/);
  if (exact) return `${exact[1].padStart(2,'0')}:${exact[2]}`;
  // "14" solo
  const solo = s.match(/^(\d{1,2})$/);
  if (solo) { const h = parseInt(solo[1]); return h <= 8 ? `${h+12}:00` : `${String(h).padStart(2,'0')}:00`; }
  // "3 pm", "4 de la tarde"
  const tarde = s.match(/(\d{1,2})\s*(pm|de la tarde|de tarde)/);
  if (tarde) { const h = parseInt(tarde[1]); return `${h < 12 ? h+12 : h}:00`; }
  // "10 de la mañana"
  const manana = s.match(/(\d{1,2})\s*(am|de la ma[ñn]ana)/);
  if (manana) return `${String(parseInt(manana[1])).padStart(2,'0')}:00`;
  // "10 y media"
  const media = s.match(/(\d{1,2})\s*y\s*media/);
  if (media) return `${String(parseInt(media[1])).padStart(2,'0')}:30`;
  // "10 y cuarto"
  const cuarto = s.match(/(\d{1,2})\s*y\s*cuarto/);
  if (cuarto) return `${String(parseInt(cuarto[1])).padStart(2,'0')}:15`;
  return null;
}

// Generar ID de sesión para clientes web
function generateSessionId() {
  return 'web-' + Math.random().toString(36).substring(2, 10);
}

module.exports = { formatFecha, normalizeDia, normalizeHora, generateSessionId };
