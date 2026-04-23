// routes/sources/utils/index.js

const {
  buildSourcesPrompt,
  buildAggregatePrompts,
  buildSourcesPromptUp,
} = require("./prompt");

const {
  extractOutputText,
  safeJsonParse,
  callOpenAIResponses,
  normalizeAndFilterItems,
  pickTechnologyBlocksFromSources,
  callOpenAIResponsesRaw,
} = require("./openai");

module.exports = {
  buildSourcesPrompt,
  buildSourcesPromptUp,
  buildAggregatePrompts,
  extractOutputText,
  safeJsonParse,
  callOpenAIResponses,
  normalizeAndFilterItems,
  pickTechnologyBlocksFromSources,
  callOpenAIResponsesRaw,
};
