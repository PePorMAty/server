// routes/step/utils/promptVersion.js
//
// Какие промпты построения шага действуют: v4 (2026-11-17, тексты владельца
// в routes/step/prompts-v4/) или прежние (legacy, routes/step/utils/prompts.js).
//
// Переключатель — для отката в любой момент без git: STEP_PROMPTS=legacy в
// .env и `pm2 restart all` возвращают прежние промпты поиска источников и
// обобщения, вверх и вниз. Читается при каждом запросе, так что достаточно
// перезапуска. Значение не задано или любое другое — v4.

function promptsVersion() {
  return String(process.env.STEP_PROMPTS || "").trim().toLowerCase() === "legacy" ? "legacy" : "v4";
}

module.exports = { promptsVersion };
