// routes/sources/utils/openai.js

const OpenAI = require("openai");

const PROVIDERS = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "GPT_API_KEY",
    defaultModel: "gpt-5-mini",
  },
  qwen: {
    baseURL:
      process.env.QWEN_BASE_URL ||
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "QWEN_API_KEY",
    defaultModel: process.env.QWEN_MODEL || "qwen-plus",
  },
};

const clientCache = {};

function getClient(providerName) {
  const name = providerName || process.env.AI_PROVIDER || "openai";
  const cfg = PROVIDERS[name];
  if (!cfg) throw new Error(`Unknown AI provider: "${name}"`);

  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) throw new Error(`${cfg.apiKeyEnv} is not set in env`);

  const cacheKey = `${name}:${apiKey}`;
  if (!clientCache[cacheKey]) {
    clientCache[cacheKey] = new OpenAI({ apiKey, baseURL: cfg.baseURL });
  }

  return {
    client: clientCache[cacheKey],
    defaultModel: cfg.defaultModel,
    name,
  };
}

function extractOutputText(resp) {
  if (!resp) return "";

  if (typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }

  const out = Array.isArray(resp.output) ? resp.output : [];
  const parts = [];

  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
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

async function callOpenAIResponses({
  prompt,
  maxItems,
  provider,
  model,
  timeoutMs = 35 * 60 * 1000,
}) {
  const { client, defaultModel } = getClient(provider);

  const response = await client.responses.create(
    {
      model: model || defaultModel,
      input: prompt,

      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_tool_calls: 8,

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
    },
    { timeout: timeoutMs },
  );

  return response;
}

async function callOpenAIResponsesRaw({
  payload,
  timeoutMs = 10 * 60 * 1000,
  provider,
  model,
}) {
  const { client, defaultModel } = getClient(provider);

  const effectivePayload = {
    ...payload,
    model: model || payload.model || defaultModel,
  };

  const response = await client.responses.create(effectivePayload, {
    timeout: timeoutMs,
  });

  return response;
}

function normalizeUrl(raw) {
  let url = String(raw || "").trim();

  url = url.replace(/^URL:\s*/i, "");
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
  callOpenAIResponsesRaw,
  normalizeAndFilterItems,
  pickTechnologyBlocksFromSources,
  getClient,
};
