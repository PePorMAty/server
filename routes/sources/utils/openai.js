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

// ---------------------------------------------------------------------------
// Qwen: Responses API → Chat Completions API conversion
// DashScope не поддерживает /v1/responses, поэтому для Qwen используем
// /v1/chat/completions через client.chat.completions.create()
// ---------------------------------------------------------------------------

function responsesToChatParams(params) {
  const messages = [];

  if (params.instructions) {
    messages.push({ role: "system", content: params.instructions });
  }

  if (typeof params.input === "string") {
    messages.push({ role: "user", content: params.input });
  } else if (Array.isArray(params.input)) {
    for (const item of params.input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item?.role && item?.content) {
        messages.push(item);
      }
    }
  }

  const chatParams = {
    model: params.model,
    messages,
    max_tokens: params.max_output_tokens || 16000,
  };

  if (params.text?.format?.type === "json_schema") {
    chatParams.response_format = {
      type: "json_schema",
      json_schema: {
        name: params.text.format.name,
        schema: params.text.format.schema,
      },
    };
  }

  // DashScope Chat Completions: enable_search вместо tools: [web_search]
  if (Array.isArray(params.tools)) {
    const hasWebSearch = params.tools.some(
      (t) => t.type === "web_search" || t.type === "web_search_preview",
    );
    if (hasWebSearch) {
      chatParams.enable_search = true;
    }
    const funcTools = params.tools.filter((t) => t.type === "function");
    if (funcTools.length) {
      chatParams.tools = funcTools;
    }
  }

  return chatParams;
}

function chatToResponsesFormat(chatResp) {
  const content = chatResp.choices?.[0]?.message?.content || "";
  return {
    output_text: content,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: content }],
      },
    ],
    status: "completed",
  };
}

// ---------------------------------------------------------------------------

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

function extractApiError(err) {
  console.error("[AI debug] error status:", err?.status);
  console.error("[AI debug] error.error:", JSON.stringify(err?.error, null, 2));
  console.error("[AI debug] error.message:", err?.message);
  console.error("[AI debug] error.code:", err?.code);
  if (err?.error?.message) return err.error.message;
  if (err?.message) return err.message;
  if (typeof err?.body === "string" && err.body) return err.body;
  if (err?.body?.message) return err.body.message;
  if (err?.status) return `API returned status ${err.status}`;
  return String(err);
}

async function callOpenAIResponses({
  prompt,
  maxItems,
  provider,
  model,
  timeoutMs = 35 * 60 * 1000,
  allowedDomains,
}) {
  const { client, defaultModel, name } = getClient(provider);
  const isQwen = name === "qwen";

  const effectiveModel = model || defaultModel;

  if (isQwen) {
    if (allowedDomains?.length) {
      console.log(
        `[${name}] allowedDomains не поддерживается провайдером (enable_search), игнорирую:`,
        allowedDomains,
      );
    }
    const chatParams = {
      model: effectiveModel,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 16000,
      enable_search: true,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "technology_sources",
          schema: buildSourcesSchema(maxItems),
        },
      },
    };

    console.log(
      `[${name}] sending chat.completions request, model=${effectiveModel}`,
    );

    try {
      const chatResp = await client.chat.completions.create(chatParams, {
        timeout: timeoutMs,
      });
      return chatToResponsesFormat(chatResp);
    } catch (err) {
      const msg = extractApiError(err);
      console.error(`[${name}] callOpenAIResponses error:`, msg);
      throw new Error(`[${name}] ${msg}`);
    }
  }

  // OpenAI — Responses API
  const params = {
    model: effectiveModel,
    input: prompt,
    tools: [
      {
        type: "web_search",
        search_context_size: "medium",
        ...(allowedDomains?.length
          ? { filters: { allowed_domains: allowedDomains } }
          : {}),
      },
    ],
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
  };

  console.log(
    `[${name}] sending responses request, model=${effectiveModel}` +
      (allowedDomains?.length
        ? `, allowed_domains=[${allowedDomains.join(", ")}]`
        : ""),
  );

  try {
    const response = await client.responses.create(params, {
      timeout: timeoutMs,
    });
    return response;
  } catch (err) {
    const msg = extractApiError(err);
    console.error(`[${name}] callOpenAIResponses error:`, msg);
    throw new Error(`[${name}] ${msg}`);
  }
}

async function callOpenAIResponsesRaw({
  payload,
  timeoutMs = 10 * 60 * 1000,
  provider,
  model,
}) {
  const { client, defaultModel, name } = getClient(provider);
  const isQwen = name === "qwen";

  const effectiveModel = model || payload.model || defaultModel;

  if (isQwen) {
    const chatParams = responsesToChatParams({
      ...payload,
      model: effectiveModel,
    });

    console.log(
      `[${name}] sending chat.completions (raw) request, model=${effectiveModel}`,
    );

    try {
      const chatResp = await client.chat.completions.create(chatParams, {
        timeout: timeoutMs,
      });
      return chatToResponsesFormat(chatResp);
    } catch (err) {
      const msg = extractApiError(err);
      console.error(`[${name}] callOpenAIResponsesRaw error:`, msg);
      throw new Error(`[${name}] ${msg}`);
    }
  }

  // OpenAI — Responses API
  const effectivePayload = {
    ...payload,
    model: effectiveModel,
  };

  console.log(
    `[${name}] sending responses (raw) request, model=${effectiveModel}`,
  );

  try {
    const response = await client.responses.create(effectivePayload, {
      timeout: timeoutMs,
    });
    return response;
  } catch (err) {
    const msg = extractApiError(err);
    console.error(`[${name}] callOpenAIResponsesRaw error:`, msg);
    throw new Error(`[${name}] ${msg}`);
  }
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
