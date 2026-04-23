// routes/sources/utils/openai.js

const axios = require("axios");
const https = require("https");

const OPENAI_URL = "https://api.openai.com/v1/responses";

// keep-alive помогает убрать часть "socket hang up" на длинных запросах
const httpsAgent = new https.Agent({ keepAlive: true });

function extractOutputText(resp) {
  if (!resp) return "";

  // иногда есть output_text прямо в корне
  if (typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }

  const out = Array.isArray(resp.output) ? resp.output : [];
  const parts = [];

  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      // встречается type: "output_text"
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }

  return parts.join("\n").trim();
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // fallback: вытащить первый JSON-объект
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function buildSourcesSchema(maxItems) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "url",
            "access_hint",
            "technology_description",
            "inputs_outputs_hint",
            "evidence_snippets",
          ],
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            access_hint: { type: "string" },
            technology_description: { type: "string" },
            inputs_outputs_hint: { type: "array", items: { type: "string" } },
            evidence_snippets: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
}

async function callOpenAIResponses({ apiKey, prompt, maxItems }) {
  const payload = {
    model: "gpt-5-mini",
    input: prompt,

    tools: [{ type: "web_search", search_context_size: "medium" }], //low
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_tool_calls: 8,

    // как в Python: просим отдать список просмотренных URL
    include: ["web_search_call.action.sources"],

    reasoning: { effort: "low" },
    truncation: "auto",
    max_output_tokens: 16000,

    text: {
      format: {
        type: "json_schema",
        name: "technology_sources",
        strict: true,
        schema: buildSourcesSchema(maxItems),
      },
    },
  };

  const { data } = await axios.post(OPENAI_URL, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    httpsAgent,
    timeout: 35 * 60 * 1000, // 35 минут
    // важно: не роняем соединение из-за больших payloads
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return data;
}

async function callOpenAIResponsesRaw({
  apiKey,
  payload,
  timeoutMs = 10 * 60 * 1000,
}) {
  const { data } = await axios.post(OPENAI_URL, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    httpsAgent,
    timeout: timeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return data;
}

function normalizeUrl(raw) {
  let url = String(raw || "").trim();

  // если модель вдруг вернула "URL: ..."
  url = url.replace(/^URL:\s*/i, "");

  // убрать хвостовую пунктуацию
  url = url.replace(/[)\],.;]+$/g, "");

  if (!url) return "";

  if (!/^https?:\/\//i.test(url)) {
    if (url.startsWith("//")) url = "https:" + url;
    else url = "https://" + url.replace(/^\/+/, "");
  }
  return url;
}

function normalizeAndFilterItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((x) => ({
      title: String(x?.title || "").trim(),
      url: normalizeUrl(x?.url),
      access_hint: String(x?.access_hint || "").trim(),
      technology_description: String(x?.technology_description || "").trim(),
      inputs_outputs_hint: Array.isArray(x?.inputs_outputs_hint)
        ? x.inputs_outputs_hint
            .map((s) => String(s || "").trim())
            .filter(Boolean)
        : [],
      evidence_snippets: Array.isArray(x?.evidence_snippets)
        ? x.evidence_snippets.map((s) => String(s || "").trim()).filter(Boolean)
        : [],
    }))
    .filter(
      (x) => x.url.startsWith("http") && x.title && x.technology_description,
    );
}

function pickTechnologyBlocksFromSources(sources, max = 5) {
  const picked = Array.isArray(sources) ? sources.slice(0, max) : [];
  const blocks = picked
    .map((s) => String(s?.technology_description || "").trim())
    .filter(Boolean);
  return { picked, blocks };
}

module.exports = {
  extractOutputText,
  safeJsonParse,
  callOpenAIResponses,
  normalizeAndFilterItems,
  pickTechnologyBlocksFromSources,
  callOpenAIResponsesRaw,
};
