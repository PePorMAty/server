// routes/chain/utils/index.js

const { buildChainSystemPrompt, buildChainUserContent } = require("./prompt");

// Клиент LLM берём общий, из sources/utils: только он знает про провайдеров
// (openai / qwen). Здешний chain/utils/openai.js ходит напрямую в OpenAI через
// axios и про выбор провайдера не знает — с ним цепочка работала только с GPT.
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
