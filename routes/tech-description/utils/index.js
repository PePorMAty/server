// routes/tech-description/utils/index.js

const {
  TECH_DESCRIPTION_PROMPT_TEMPLATE,
  TECH_DESCRIPTION_INPUT_MARKER,
  directionLabel,
  fillTechDescriptionPrompt,
  splitTechDescriptionPrompt,
  stringifyChain,
} = require("./prompt");

// Клиент LLM общий для всех AI-роутов (openai / qwen — см. sources/utils/openai.js).
const {
  callOpenAIResponsesRaw,
  extractOutputText,
} = require("../../sources/utils");

module.exports = {
  TECH_DESCRIPTION_PROMPT_TEMPLATE,
  TECH_DESCRIPTION_INPUT_MARKER,
  directionLabel,
  fillTechDescriptionPrompt,
  splitTechDescriptionPrompt,
  stringifyChain,
  callOpenAIResponsesRaw,
  extractOutputText,
};
