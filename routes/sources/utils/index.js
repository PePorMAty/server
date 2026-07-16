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

// Санитайзер списка доменов для web_search filters.allowed_domains:
// API принимает только «голые» домены (без протокола/пути), максимум 20.
function sanitizeAllowedDomains(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    let s = item.trim().toLowerCase();
    if (!s) continue;
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname;
    } catch {
      // не URL — дорежем вручную ниже
    }
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    s = s.split(/[/?#]/)[0];
    s = s.split("@").pop();
    s = s.split(":")[0];
    s = s.replace(/^\.+|\.+$/g, "");
    if (!s.includes(".") || !/^[a-z0-9.-]+$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

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
  sanitizeAllowedDomains,
};
