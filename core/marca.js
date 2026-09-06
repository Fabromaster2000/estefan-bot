// ── CORE: MARCA ───────────────────────────────────────────────────────────────
// El nombre del bot en un solo lugar. Todos los prompts lo leen de acá, así que
// para cambiarlo alcanza con editar esta línea — o poner BOT_NAME en las env
// vars de Render, sin tocar código ni volver a deployar el repo entero.

'use strict';

const BOT = process.env.BOT_NAME || 'Stefi';

module.exports = { BOT };
