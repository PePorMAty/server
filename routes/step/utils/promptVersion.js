// routes/step/utils/promptVersion.js
//
// Какие промпты построения шага действуют: прежние (legacy,
// routes/step/utils/prompts.js) или v4 (2026-11-17, тексты владельца в
// routes/step/prompts-v4/).
//
// С 2026-11-18 по решению владельца снова действуют прежние: v4 после живых
// прогонов (тупик у изделий вверх, нет поля «Побочные продукты») — выключены,
// но остаются в коде вместе с одобренными правками. Включить v4 без git —
// STEP_PROMPTS=v4 в .env и `pm2 restart all`. Значение не задано, «legacy»
// или любое другое — прежние. Читается при каждом запросе, так что
// достаточно перезапуска.

function promptsVersion() {
  return String(process.env.STEP_PROMPTS || "").trim().toLowerCase() === "v4" ? "v4" : "legacy";
}

module.exports = { promptsVersion };
