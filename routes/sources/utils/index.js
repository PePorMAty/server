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
  callOpenAIResponsesRaw,
  normalizeAndFilterItems,
  pickTechnologyBlocksFromSources,
  getClient,
} = require("./openai");

module.exports = {
  buildSourcesPrompt,
  buildSourcesPromptUp,
  buildAggregatePrompts,
  extractOutputText,
  safeJsonParse,
  callOpenAIResponses,
  callOpenAIResponsesRaw,
  normalizeAndFilterItems,
  pickTechnologyBlocksFromSources,
  getClient,
};
