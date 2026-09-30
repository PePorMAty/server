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
    // qwen-plus нашему ключу недоступен (403 AccessDenied.Unpurchased) —
    // дефолтом берём модель из доступных аккаунту.
    defaultModel: process.env.QWEN_MODEL || "qwen3.7-plus",
  },
};

const clientCache = {};

function getClient(providerName) {
  const name = providerName || process.env.AI_PROVIDER || "openai";
  const cfg = PROVIDERS[name];
  if (!cfg) throw new Error(`Unknown AI provider: "${name}"`);

  // Ключ из .env/секретов часто приезжает с пробелом, переводом строки или
  // кавычками по краям — провайдер на такой ключ отвечает "Incorrect API key",
  // что выглядит как неверный ключ, хотя он верный.
  const rawKey = process.env[cfg.apiKeyEnv];
  const apiKey = String(rawKey ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!apiKey) throw new Error(`${cfg.apiKeyEnv} is not set in env`);

  const cacheKey = `${name}:${apiKey}`;
  if (!clientCache[cacheKey]) {
    // Логируем длину, а не сам ключ: этого хватает, чтобы поймать обрезанный
    // или частично скопированный ключ, и не утекает секрет.
    console.log(
      `[${name}] client init: baseURL=${cfg.baseURL}, keyLen=${apiKey.length}, keyPrefix=${apiKey.slice(0, 6)}…`,
    );
    clientCache[cacheKey] = new OpenAI({ apiKey, baseURL: cfg.baseURL });
  }

  return {
    client: clientCache[cacheKey],
    defaultModel: cfg.defaultModel,
    name,
  };
}

// ---------------------------------------------------------------------------
// DashScope: размышления, поиск и параметры, которых модель не знает
// ---------------------------------------------------------------------------

/**
 * Режим размышлений у моделей DashScope: off | on | default (из AI_THINKING).
 *
 * Новые Qwen и DeepSeek по умолчанию «думают» перед ответом. Нашим задачам —
 * найти источники, заполнить карточку, собрать шаг по готовому тексту — это
 * вредит: запрос идёт минутами (DeepSeek V4 Pro заполнял карточку 11 минут
 * и падал), размышления съедают лимит длины, так что на ответ не остаётся
 * места, а схему ответа (json_schema) в режиме размышлений модели держат
 * плохо — отсюда «ответ не по схеме» у Flash-моделей. Поэтому по умолчанию
 * размышления выключены.
 *
 * on — включить, default — не передавать параметр, пусть решает модель.
 */
function thinkingMode() {
  const v = String(process.env.AI_THINKING || "off").trim().toLowerCase();
  return ["on", "off", "default"].includes(v) ? v : "off";
}

/**
 * Бюджет размышлений для модели, которая без них не отвечает.
 *
 * Такая модель отвергает enable_thinking: false, и мы отпускаем её думать, но
 * с потолком: без него DeepSeek V4 Pro размышлял больше десяти минут.
 */
const FORCED_THINKING_BUDGET = 4000;

function withThinking(params) {
  const mode = thinkingMode();
  if (mode === "default") return params;
  return { ...params, enable_thinking: mode === "on" };
}

/**
 * Настройки веб-поиска DashScope.
 *
 * forced_search — искать всегда: иначе модель сама решает, нужен ли поиск, и
 * порой отвечает по памяти одним-двумя источниками. search_strategy (из
 * QWEN_SEARCH_STRATEGY, по умолчанию max) — глубина поиска: max собирает
 * больше страниц, чем turbo, ценой времени и токенов.
 */
function searchOptions() {
  const strategy = String(process.env.QWEN_SEARCH_STRATEGY || "max")
    .trim()
    .toLowerCase();
  return {
    forced_search: true,
    ...(strategy && strategy !== "default" ? { search_strategy: strategy } : {}),
  };
}

/** Текст ошибки провайдера: у DashScope он лежит в error.message тела ответа. */
function apiErrorText(err) {
  if (typeof err?.error?.message === "string") return err.error.message;
  if (typeof err?.message === "string") return err.message;
  if (typeof err?.body === "string") return err.body;
  if (typeof err?.body?.message === "string") return err.body.message;
  return String(err ?? "");
}

function without(obj, key) {
  const { [key]: _drop, ...rest } = obj;
  return rest;
}

/**
 * Как поправить запрос, который модель отвергла из-за параметра.
 *
 * Модели в одном тарифе умеют разное, а отказ приходит одинаково — ошибкой 400
 * с текстом про параметр. Вместо того чтобы вести таблицу «что умеет каждая
 * модель» (она устаревает с каждой новой моделью), читаем отказ и убираем
 * именно то, на что модель пожаловалась. Возвращает { params, note } или null,
 * если отказ не про параметры и повтор не поможет.
 *
 * @param err            ошибка SDK
 * @param params         параметры запроса, на которые пришёл отказ
 * @param searchRequired без поиска запрос не имеет смысла (поиск источников)
 */
function paramFix(err, params, { searchRequired = false } = {}) {
  if (err?.status !== 400) return null;
  const msg = apiErrorText(err);

  if ("thinking_budget" in params && /thinking_budget/i.test(msg)) {
    return {
      params: without(params, "thinking_budget"),
      note: "модель не принимает thinking_budget",
    };
  }

  // Бывает и обратное: в режиме без потока часть моделей требует
  // enable_thinking: false явно.
  if (
    params.enable_thinking !== false &&
    /enable_thinking[^.]*(must|should|need)[^.]*false/i.test(msg)
  ) {
    return {
      params: { ...params, enable_thinking: false },
      note: "модель требует выключить размышления",
    };
  }

  if (
    params.response_format &&
    /response_format|json_schema|json_object|json mode|structured output/i.test(msg)
  ) {
    if (params.response_format.type === "json_schema") {
      return {
        params: { ...params, response_format: { type: "json_object" } },
        note: "json_schema не поддерживается — прошу просто JSON",
      };
    }
    return {
      params: without(params, "response_format"),
      note: "формат ответа не поддерживается — JSON только по промпту",
    };
  }

  if ("enable_thinking" in params && /enable_thinking|thinking/i.test(msg)) {
    // Модель не выключает размышления. Пусть думает, но в пределах бюджета, а
    // лимит ответа растёт на тот же бюджет: размышления расходуют его же.
    const next = without(params, "enable_thinking");
    if (params.enable_thinking === false) {
      next.thinking_budget = FORCED_THINKING_BUDGET;
      next.max_tokens = (params.max_tokens || 16000) + FORCED_THINKING_BUDGET;
    }
    return {
      params: next,
      note: "модель не выключает размышления — ограничиваю их бюджетом",
    };
  }

  if (params.search_options?.search_strategy && /search_strategy/i.test(msg)) {
    return {
      params: {
        ...params,
        search_options: without(params.search_options, "search_strategy"),
      },
      note: "модель не знает search_strategy",
    };
  }
  if (params.search_options && /search_options|forced_search/i.test(msg)) {
    return {
      params: without(params, "search_options"),
      note: "модель не принимает настройки поиска",
    };
  }
  if (params.enable_search && !searchRequired && /search/i.test(msg)) {
    return {
      params: without(without(params, "enable_search"), "search_options"),
      note: "модель не умеет искать в интернете — отвечаю без поиска",
    };
  }

  const cap = /max_tokens[^[\d]*\[\s*\d+\s*,\s*(\d+)\s*\]/i.exec(msg);
  if (cap && Number(cap[1]) > 0 && params.max_tokens > Number(cap[1])) {
    return {
      params: { ...params, max_tokens: Number(cap[1]) },
      note: `лимит ответа снижен до ${cap[1]} токенов — больше модель не даёт`,
    };
  }

  return null;
}

/**
 * Отказ провайдера — человеческим языком, с названием модели.
 *
 * Уходит прямо в интерфейс. Исходный текст провайдера пишется в лог сервера.
 */
function describeApiError(err, model, { timeoutMs, searchRequired } = {}) {
  const who = model ? `Модель «${model}»` : "Модель";
  const text = apiErrorText(err);

  if (
    err instanceof OpenAI.APIConnectionTimeoutError ||
    /timed? ?out/i.test(text)
  ) {
    const min = timeoutMs ? Math.max(1, Math.round(timeoutMs / 60000)) : null;
    return `${who} не ответила${min ? ` за ${min} мин` : ""} — запрос прерван. Повторите или выберите модель побыстрее.`;
  }
  if (err?.status === 401) {
    return `Провайдер не принял ключ API (${who.toLowerCase()}). Проверьте ключ в .env на сервере.`;
  }
  if (err?.status === 403 || /AccessDenied|access_denied|Unpurchased/i.test(text)) {
    return `${who} недоступна по вашему ключу или тарифу.`;
  }
  if (err?.status === 429) {
    return `${who}: превышен лимит запросов. Подождите минуту и повторите.`;
  }
  if (err?.status >= 500) {
    return `Сервис модели «${model}» ответил ошибкой ${err.status}. Повторите чуть позже.`;
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return `Нет связи с сервисом модели «${model}». Повторите чуть позже.`;
  }

  // Дальше — отказы 400 по содержанию запроса.
  if (
    /input length|context length|context window|maximum context|too long|too many tokens/i.test(
      text,
    )
  ) {
    const limit = /input length[^[\d]*\[\s*\d+\s*,\s*(\d+)\s*\]/i.exec(text)?.[1];
    return (
      `Запрос не поместился в окно контекста модели «${model}»` +
      (limit ? ` (предел — ${Number(limit).toLocaleString("ru-RU")} токенов)` : "") +
      ": данных слишком много. Выберите модель с окном побольше."
    );
  }
  if (searchRequired && /search/i.test(text)) {
    return `${who} не умеет искать в интернете — для поиска источников выберите другую модель.`;
  }
  return `${who}: ${text}`;
}

/** Отказ, который стоит повторить: перегрузка, сбой сервиса, обрыв связи. */
function isTransient(err) {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return false;
  if (err instanceof OpenAI.APIConnectionError) return true;
  return err?.status === 429 || err?.status >= 500;
}

/**
 * Запрос к Chat Completions DashScope с поправками на модель.
 *
 * Повторяет запрос, когда модель отвергла параметр (см. paramFix), и один раз —
 * при перегрузке или сбое сервиса. Истёкший таймаут не повторяем: SDK делал это
 * сам дважды, и медленная модель держала запрос втрое дольше таймаута.
 *
 * Возвращает { resp, fixes, ms } — fixes перечисляют применённые поправки.
 */
async function createChat(client, params, { timeoutMs, name, searchRequired }) {
  const t0 = Date.now();
  const fixes = [];
  let current = params;
  let transientLeft = 1;

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const resp = await client.chat.completions.create(current, {
        timeout: timeoutMs,
        maxRetries: 0,
      });
      return { resp, fixes, ms: Date.now() - t0 };
    } catch (err) {
      const fix = paramFix(err, current, { searchRequired });
      if (fix) {
        fixes.push(fix.note);
        console.warn(
          `[${name}] model=${current.model}: ${fix.note} (${apiErrorText(err)}) — повторяю`,
        );
        current = fix.params;
        continue;
      }
      if (isTransient(err) && transientLeft > 0) {
        transientLeft--;
        console.warn(
          `[${name}] model=${current.model}: ${apiErrorText(err)} — повторяю через 3 с`,
        );
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      err.fixes = fixes;
      throw err;
    }
  }
  throw new Error(`[${name}] слишком много поправок к запросу: ${fixes.join("; ")}`);
}

// ---------------------------------------------------------------------------
// Qwen: Responses API → Chat Completions API conversion
// DashScope не поддерживает /v1/responses, поэтому для Qwen используем
// /v1/chat/completions через client.chat.completions.create()
// ---------------------------------------------------------------------------

// DashScope отклоняет response_format, если ни в одном сообщении нет слова
// "json" (InternalError.Algo.InvalidParameter). Дефолтные промпты его содержат,
// но пользователь может отредактировать промпт в UI и убрать — подстраховываемся.
function ensureJsonMention(messages) {
  const mentioned = messages.some(
    (m) => typeof m?.content === "string" && /json/i.test(m.content),
  );
  if (mentioned) return messages;

  const note = "Ответ верни строго в формате JSON по заданной схеме.";
  const sysIndex = messages.findIndex(
    (m) => m?.role === "system" && typeof m?.content === "string",
  );
  if (sysIndex === -1) return [{ role: "system", content: note }, ...messages];

  const patched = messages.slice();
  patched[sysIndex] = {
    ...patched[sysIndex],
    content: `${patched[sysIndex].content}\n\n${note}`,
  };
  return patched;
}

/**
 * Схема ответа — ещё и текстом в промпте.
 *
 * DashScope держит json_schema не всегда: модель, которая не выключает
 * размышления или не поддерживает схему, молча отвечает по тексту промпта —
 * а схему она не видит, её видит только API. Отсюда «ответ не по схеме».
 * Схема в промпте страхует оба случая; модели, которая схему держит, она не
 * мешает.
 */
function withSchemaNote(messages, schema) {
  if (!schema) return messages;
  const note =
    "Ответ — один JSON-объект строго по этой схеме (JSON Schema), без пояснений вне JSON:\n" +
    JSON.stringify(schema);
  const sysIndex = messages.findIndex(
    (m) => m?.role === "system" && typeof m?.content === "string",
  );
  if (sysIndex === -1) return [{ role: "system", content: note }, ...messages];
  const patched = messages.slice();
  patched[sysIndex] = {
    ...patched[sysIndex],
    content: `${patched[sysIndex].content}\n\n${note}`,
  };
  return patched;
}

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
        // Без strict модель вправе вернуть JSON произвольной формы: проверено
        // на qwen3.6-flash — вместо схемы приходил свободный ответ, и разбор
        // ломался. Роуты передают strict: true, раньше он терялся здесь.
        strict: params.text.format.strict !== false,
      },
    };
    chatParams.messages = withSchemaNote(
      ensureJsonMention(chatParams.messages),
      params.text.format.schema,
    );
  }

  // DashScope Chat Completions: enable_search вместо tools: [web_search]
  if (Array.isArray(params.tools)) {
    const hasWebSearch = params.tools.some(
      (t) => t.type === "web_search" || t.type === "web_search_preview",
    );
    if (hasWebSearch) {
      chatParams.enable_search = true;
      chatParams.search_options = searchOptions();
    }
    const funcTools = params.tools.filter((t) => t.type === "function");
    if (funcTools.length) {
      chatParams.tools = funcTools;
    }
  }

  return chatParams;
}

/**
 * @param meta  как прошёл запрос (createChat): время и применённые поправки.
 *              Лежит в ответе полем ai — его видно во вкладке Network браузера
 *              и в скрипте проверки моделей.
 */
function chatToResponsesFormat(chatResp, meta = {}) {
  const choice = chatResp.choices?.[0];
  const content = choice?.message?.content || "";

  // Рассуждающие модели DashScope кладут размышления отдельным полем. Когда
  // весь бюджет токенов уходит туда, content приходит пустым — без этого
  // признака причину пустого ответа было не отличить от любой другой.
  const reasoning = choice?.message?.reasoning_content || "";
  const cutByLimit = choice?.finish_reason === "length";

  return {
    output_text: content,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: content }],
      },
    ],
    status: cutByLimit ? "incomplete" : "completed",
    ...(cutByLimit
      ? { incomplete_details: { reason: "max_output_tokens" } }
      : {}),
    reasoningOnly: !content.trim() && reasoning.trim().length > 0,
    ai: {
      model: chatResp.model || meta.model || null,
      ms: meta.ms ?? null,
      fixes: meta.fixes ?? [],
      reasoningChars: reasoning.length,
      usage: chatResp.usage ?? null,
    },
  };
}

/** Строка лога о завершённом запросе: сколько шёл и что пришлось поправить. */
function logDone(name, model, meta, resp) {
  const secs = (meta.ms / 1000).toFixed(1);
  const think = resp.ai.reasoningChars
    ? `, размышления ${resp.ai.reasoningChars} симв.`
    : "";
  const fixes = meta.fixes.length ? `, поправки: ${meta.fixes.join("; ")}` : "";
  console.log(`[${name}] model=${model}: ответ за ${secs} с${think}${fixes}`);
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

/**
 * Почему ответ модели не годится — человеческим языком.
 *
 * Прежние сообщения («GPT did not return JSON») не говорили пользователю
 * ничего: непонятно, виноват сервер, сеть или выбранная модель. Здесь
 * различаются реальные причины, и текст уходит прямо в интерфейс.
 *
 * @param resp   ответ транспорта (уже приведённый к виду Responses API)
 * @param text   извлечённый из него текст
 * @param model  модель, которой отправляли запрос
 * @param what   что ждали от модели: { acc: «граф», gen: «графа» } — роуты
 *               ждут разного, а без этого каждому сообщению доставался граф
 */
function explainBadAnswer(
  resp,
  text,
  model,
  what = { acc: "граф", gen: "графа" },
) {
  const who = model ? `Модель «${model}»` : "Модель";

  const cutByLimit =
    resp?.status === "incomplete" &&
    resp?.incomplete_details?.reason === "max_output_tokens";

  // Рассуждающие модели умеют потратить весь бюджет на размышления и не
  // написать ответа: у DashScope это отдельное поле, у OpenAI — блок reasoning
  // в output без текстового сообщения.
  const reasoningOnly =
    resp?.reasoningOnly === true ||
    (!text &&
      Array.isArray(resp?.output) &&
      resp.output.some((item) => item?.type === "reasoning"));

  if (!text) {
    if (reasoningOnly) {
      return `${who} израсходовала весь запас токенов на размышления и не выдала ответ. Выберите модель попроще или сократите запрос.`;
    }
    if (cutByLimit) {
      return `${who} упёрлась в предел длины ответа и не успела ничего вернуть. Сократите запрос или выберите другую модель.`;
    }
    return `${who} вернула пустой ответ. Попробуйте повторить запрос или выбрать другую модель.`;
  }

  if (cutByLimit) {
    const whose = model ? `модели «${model}»` : "модели";
    return `Ответ ${whose} оборвался на пределе длины — ${what.acc} из него не собрать. Сократите запрос или выберите другую модель.`;
  }

  return `${who} ответила обычным текстом вместо ${what.gen} в формате JSON. Попробуйте повторить запрос или выбрать другую модель.`;
}

/**
 * Первое целое JSON-значение в тексте, начиная с позиции start.
 *
 * Скобки считаем с учётом строк: иначе «}» внутри текста ломает разбор, а
 * жадное регулярное выражение хватало лишнее, если после JSON модель что-то
 * дописывала. Возвращает подстроку или null.
 */
function balancedJsonAt(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * JSON из ответа модели.
 *
 * Модели без строгой схемы (или те, что её не держат) заворачивают JSON в
 * ```json … ```, предваряют пояснением или дописывают что-то после. Берём
 * первый объект или массив, который действительно разбирается.
 */
function safeJsonParse(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced.trim());
    } catch {}
  }

  for (let i = 0, tries = 0; i < trimmed.length && tries < 20; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    tries++;
    const block = balancedJsonAt(trimmed, i);
    if (!block) continue;
    try {
      return JSON.parse(block);
    } catch {}
  }
  return null;
}

/**
 * Список источников из ответа модели.
 *
 * По схеме это { items: [...] }, но модель без строгой схемы называет поле
 * по-своему или отдаёт голый массив.
 */
function pickItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return null;
  for (const key of ["items", "sources", "results", "technology_sources"]) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  const arrays = Object.values(parsed).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : null;
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
    const chatParams = withThinking({
      model: effectiveModel,
      messages: withSchemaNote(
        ensureJsonMention([{ role: "user", content: prompt }]),
        buildSourcesSchema(maxItems),
      ),
      max_tokens: 16000,
      enable_search: true,
      search_options: searchOptions(),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "technology_sources",
          schema: buildSourcesSchema(maxItems),
          strict: true,
        },
      },
    });

    console.log(
      `[${name}] sending chat.completions request, model=${effectiveModel}`,
    );

    try {
      const { resp, fixes, ms } = await createChat(client, chatParams, {
        timeoutMs,
        name,
        searchRequired: true,
      });
      const out = chatToResponsesFormat(resp, { model: effectiveModel, fixes, ms });
      logDone(name, effectiveModel, { fixes, ms }, out);
      return out;
    } catch (err) {
      extractApiError(err);
      console.error(`[${name}] callOpenAIResponses error:`, apiErrorText(err));
      throw new Error(
        describeApiError(err, effectiveModel, { timeoutMs, searchRequired: true }),
      );
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
    throw new Error(
      describeApiError(err, effectiveModel, { timeoutMs, searchRequired: true }),
    );
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

  // payload.model роуты задают хардкодом ("gpt-5-mini") — это дефолт OpenAI.
  // Для другого провайдера такое имя модели бессмысленно (DashScope ответит
  // AccessDenied), поэтому подставляем дефолт самого провайдера.
  const effectiveModel =
    model || (name === "openai" ? payload.model : null) || defaultModel;

  if (isQwen) {
    const chatParams = withThinking(
      responsesToChatParams({
        ...payload,
        model: effectiveModel,
      }),
    );

    console.log(
      `[${name}] sending chat.completions (raw) request, model=${effectiveModel}`,
    );

    try {
      const { resp, fixes, ms } = await createChat(client, chatParams, {
        timeoutMs,
        name,
      });
      const out = chatToResponsesFormat(resp, { model: effectiveModel, fixes, ms });
      logDone(name, effectiveModel, { fixes, ms }, out);
      return out;
    } catch (err) {
      extractApiError(err);
      console.error(`[${name}] callOpenAIResponsesRaw error:`, apiErrorText(err));
      throw new Error(describeApiError(err, effectiveModel, { timeoutMs }));
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
    throw new Error(describeApiError(err, effectiveModel, { timeoutMs }));
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

/**
 * Первые max источников, у которых есть текст технологии, и сами тексты.
 *
 * Сперва отбираем источники с текстом, потом берём первые max — не наоборот.
 * Раньше брались первые max как есть, и если это были записи из сохранённого
 * графа (там у источника только название и ссылка), обобщение отказывало
 * «Need at least 1 technology_description block», хотя шестой и дальше
 * источники текст имели.
 */
function pickTechnologyBlocksFromSources(sources, max = 5) {
  const withText = Array.isArray(sources)
    ? sources.filter((s) => String(s?.technology_description || "").trim())
    : [];
  const picked = withText.slice(0, max);
  const blocks = picked.map((s) => String(s.technology_description).trim());
  return { picked, blocks };
}

module.exports = {
  extractOutputText,
  explainBadAnswer,
  safeJsonParse,
  pickItems,
  callOpenAIResponses,
  callOpenAIResponsesRaw,
  normalizeAndFilterItems,
  pickTechnologyBlocksFromSources,
  getClient,
  // для проверок: как транспорт чинит запрос и что говорит пользователю
  paramFix,
  describeApiError,
};
