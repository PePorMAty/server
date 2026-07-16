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

// Строгий пост-фильтр: filters.allowed_domains ограничивает только сам
// web_search, а итоговый JSON пишет модель и может «дописать» источники из
// памяти с чужих доменов. При активном белом списке отбрасываем такие ссылки
// (сабдомены разрешены: wikipedia.org матчит en.wikipedia.org).
function filterItemsByAllowedDomains(items, allowedDomains) {
  if (!Array.isArray(items)) return [];
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return items;
  }
  const kept = items.filter((item) => {
    let host;
    try {
      host = new URL(String(item?.url || "")).hostname.toLowerCase();
    } catch {
      return false;
    }
    return allowedDomains.some((d) => host === d || host.endsWith("." + d));
  });
  if (kept.length !== items.length) {
    console.log(
      `[sources] пост-фильтр доменов: отброшено ${items.length - kept.length} из ${items.length} источников (allowed: ${allowedDomains.join(", ")})`,
    );
  }
  return kept;
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
  filterItemsByAllowedDomains,
};
