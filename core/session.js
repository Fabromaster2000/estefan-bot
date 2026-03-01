// ── CORE: SESSION ─────────────────────────────────────────────────────────────
// Manejo de sesiones en memoria. Cada sesión tiene estado, datos acumulados
// e historial de conversación para el contexto de Haiku.

const sessions = {};

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      id:        sessionId,
      step:      'LIBRE',
      data:      {},
      historial: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
  }
  sessions[sessionId].lastActivity = Date.now();
  return sessions[sessionId];
}

function resetSession(sessionId) {
  if (sessions[sessionId]) {
    sessions[sessionId].step = 'LIBRE';
    sessions[sessionId].data = {};
    // Mantener historial para contexto
  }
}

function getAllSessions() {
  return Object.entries(sessions).map(([id, s]) => ({
    id, step: s.step, lastActivity: new Date(s.lastActivity).toISOString()
  }));
}

// Limpiar sesiones viejas (más de 24hs sin actividad)
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, s] of Object.entries(sessions)) {
    if (s.lastActivity < cutoff) delete sessions[id];
  }
}, 60 * 60 * 1000);

module.exports = { getSession, resetSession, getAllSessions };
