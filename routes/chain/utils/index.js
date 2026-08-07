// routes/chain/utils/index.js

const { buildChainSystemPrompt, buildChainUserContent } = require("./prompt");
// Транспорт берём общий (routes/sources/utils/openai.js): в нём живёт
// переключение провайдера и выбор модели. Локальная копия ./openai умела
// только OpenAI и провайдеров не знала.
const {
  extractOutputText,
  safeJsonParse,
  callOpenAIResponsesRaw,
} = require("../../sources/utils");
const { validateChain } = require("./validate");
const { buildLevel1 } = require("./level1");

module.exports = {
  buildChainSystemPrompt,
  buildChainUserContent,
  extractOutputText,
  safeJsonParse,
  callOpenAIResponsesRaw,
  validateChain,
  buildLevel1,
};
