// server/routes/graphs.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

// Основной endpoint для создания графа
router.post("/gpt", async (req, res) => {
  const { userPrompt, promptLayout } = req.body;

  // ✅ ВАЛИДАЦИЯ ДО СТРИМА
  if (!userPrompt?.trim()) {
    return res
      .status(400)
      .json({ success: false, error: "userPrompt is required" });
  }

  // ✅ Теперь можно начинать "anti-idle" стрим
  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let aborted = false;

  const stop = (timer) => {
    if (timer) clearInterval(timer);
  };

  const hb = setInterval(() => {
    try {
      res.write(" \n");
    } catch {}
  }, 15000);

  // Надёжнее так:
  req.on("aborted", () => {
    aborted = true;
    stop(hb);
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      stop(hb);
    }
  });

  try {
    const systemPrompt =
      promptLayout?.trim() || process.env.GPT_PROMT_LAYOUT || "";
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const gptResponse = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4.1",
        input: fullPrompt,
        temperature: 0.3,
        max_output_tokens: 12000,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GPT_API_KEY}`,
          "Content-Type": "application/json",
        },
        // лучше не бесконечно:
        timeout: 35 * 60 * 1000,
      },
    );

    if (aborted) return;

    const text = gptResponse.data.output?.[0]?.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("GPT did not return JSON");

    const parsedJSON = JSON.parse(jsonMatch[0]);

    stop(hb);
    // ✅ после res.write(...) лучше res.end(...)
    res.end(JSON.stringify({ success: true, ...parsedJSON }));
  } catch (error) {
    stop(hb);
    if (aborted) return;

    // ⚠️ после начала стрима статус-код менять уже поздно/бессмысленно
    res.end(
      JSON.stringify({
        success: false,
        error: error.response?.data || error.message,
      }),
    );
  }
});

router.get("/prompt-layout", (req, res) => {
  res.json({
    promptLayout: process.env.GPT_PROMT_LAYOUT || "",
  });
});

// --------------------------
//   CONTINUE GRAPH
// --------------------------
router.post("/gpt/continue", async (req, res) => {
  try {
    const { originalPrompt, existingGraph, leafNodes } = req.body;

    if (!originalPrompt || !existingGraph || !leafNodes) {
      return res.status(400).json({ error: "Bad request" });
    }

    const prompt = `
Ты — система для расширения DAG-графов.
Вот текущий граф:

${JSON.stringify(existingGraph, null, 2)}

Расширь граф ТОЛЬКО для узлов:
${leafNodes.join(", ")}

Правила:
- Не изменяй существующие nodes и edges
- Добавляй только новые nodes и edges
- Возвращай JSON строго в формате:
{
  "nodes": [],
  "edges": [],
  "leaf_nodes": [],
  "has_more": boolean
}
`;

    const gptResponse = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4.1",
        input: prompt,
        temperature: 0.2,
        max_output_tokens: 6000,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GPT_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 0,
      },
    );

    const text = gptResponse.data.output[0].content[0].text;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("GPT did not return JSON");

    const parsedJSON = JSON.parse(jsonMatch[0]);

    res.status(200).json({
      success: true,
      ...parsedJSON,
    });
  } catch (error) {
    console.error(
      "Continue graph error:",
      error.response?.data || error.message,
    );
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// --------------------------
//   FIND SOURCES
// --------------------------

// routes/gptSources.js

const OPENAI_URL = "https://api.openai.com/v1/responses";

/* ============================
   Helpers
   ============================ */

async function openaiResponsesWithRetry(payload, axiosConfig) {
  // 1-я попытка
  let { data } = await axios.post(OPENAI_URL, payload, axiosConfig);

  // 1 ретрай, если модель упёрлась в max_output_tokens
  if (
    data?.status === "incomplete" &&
    data?.incomplete_details?.reason === "max_output_tokens"
  ) {
    const bumped = {
      ...payload,
      max_output_tokens: Math.max(
        (payload.max_output_tokens || 6000) * 2,
        12000,
      ),
      reasoning: { effort: "low" },
      parallel_tool_calls: false,
      max_tool_calls: payload.max_tool_calls ?? 10,
      tools: Array.isArray(payload.tools)
        ? payload.tools.map((t) =>
            t?.type === "web_search" ? { ...t, search_context_size: "low" } : t,
          )
        : payload.tools,
    };

    ({ data } = await axios.post(OPENAI_URL, bumped, axiosConfig));
  }

  return data;
}

function extractAssistantText(respJson) {
  const out = Array.isArray(respJson?.output) ? respJson.output : [];
  const parts = [];

  for (const item of out) {
    if (Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractStructuredJSON(respJson) {
  const txt = extractAssistantText(respJson);

  try {
    return JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/* ============================
   Route: ONLY SEARCH SOURCES
   POST /graphs/gpt/sources
   ============================ */

function withAntiIdleJson(res, req, { heartbeatMs = 15000 } = {}) {
  let started = false;
  let aborted = false;
  let hb = null;

  const stop = () => {
    if (hb) clearInterval(hb);
    hb = null;
  };

  const start = () => {
    if (started) return;
    started = true;

    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");

    // важно: реально выдать headers + 1 байт
    res.flushHeaders?.();
    try {
      res.write(" ");
    } catch {}

    // если стоит compression middleware — это помогает выталкивать буфер
    res.flush?.();

    hb = setInterval(() => {
      if (!res.writableEnded) {
        try {
          res.write(" \n");
          res.flush?.();
        } catch {}
      }
    }, heartbeatMs);
  };

  const onClose = () => {
    aborted = true;
    stop();
  };

  req.on("aborted", onClose);
  req.on("close", onClose);
  res.on("close", onClose);

  return {
    start,
    stop,
    get started() {
      return started;
    },
    get aborted() {
      return aborted;
    },
  };
}
/* router.post("/gpt/sources", async (req, res) => {
  // 0) Валидация ДО стрима
  const productName = String(req.body?.productName || "").trim();
  const maxItems = Number.isFinite(Number(req.body?.maxItems))
    ? Number(req.body.maxItems)
    : 5;

  if (!productName) {
    return res
      .status(400)
      .json({ success: false, error: "productName is required" });
  }
  if (!process.env.GPT_API_KEY) {
    return res
      .status(500)
      .json({ success: false, error: "GPT_API_KEY is not set in env" });
  }
  if (maxItems < 1 || maxItems > 10) {
    return res
      .status(400)
      .json({ success: false, error: "maxItems must be between 1 and 10" });
  }

  // 1) Анти-idle
  const stream = withAntiIdleJson(res, req, {
    startAfterMs: 0,
    heartbeatMs: 10000,
  });
  stream.start();
  // 2) Универсальный ответчик
  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;

    if (stream.started) {
      // статус уже 200, поэтому кладём реальный код внутрь
      return res.end(JSON.stringify({ ...obj, http_status: status }));
    }
    return res.status(status).json(obj);
  };

  try {
    const axiosConfig = {
      headers: {
        Authorization: `Bearer ${process.env.GPT_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 0,
    };

    const searchPrompt = `
## Роль и задача
Ты — инженер-технолог. Твоя задача: найти источники, где ЯВНО описана технология/процесс промышленного получения (manufacturing / production process) указанного продукта, и извлечь из каждого источника КРАТКОЕ ОПИСАНИЕ ТЕХНОЛОГИИ (а не саммари статьи).

## Что считать “описанием технологии”
Технологическое описание = 3–5 предложений про сам процесс:
- ключевые стадии/узлы (подготовка сырья → реакция/синтез → разделение → очистка → и т.п.);
- основные реагенты/сырьё;
- условия и/или оборудование (если указаны: T, P, катализатор, тип реактора, колонна и т.д.);
- важные технологические параметры (если указаны).

⚠️ Нельзя писать: “в статье рассматривается…”, “авторы обсуждают…”.
Нужно писать: “Процесс включает…”, “Сырьё подают…”, “Реакцию ведут…”, “Продукт отделяют…”.

## Критерии отбора источников
Отбирай источники с техподробностями (стадии, сырьё, оборудование, условия, flowsheet).
Избегай источников без технологии.

Предпочитай: патенты, handbooks/учебники, обзоры с “Production/Manufacture”, тех.бюллетени, стандарты, материалы организаций.

## ВАЖНО: LLM-readable
Только источники без логина/paywall/капчи, доступные как HTML или текстовый PDF (не скан).

## Запрос
Найди источники с описанием технологии получения продукта: "${productName}".
Верни ${maxItems} лучших источников.

## По каждому источнику
1) title
2) url
3) access_hint: "open html" / "text pdf"
4) technology_description: 3–5 предложений про процесс (строго по тексту источника)
5) inputs_outputs_hint: входы/выходы только если явно указаны
6) evidence_snippets: 2–4 коротких фрагмента (до ~20 слов)

Верни РОВНО ${maxItems} источников.
Верни ТОЛЬКО JSON по схеме.
`.trim();

    const searchPayload = {
      model: "gpt-5-mini",
      input: searchPrompt,
      tools: [{ type: "web_search", search_context_size: "low" }],
      tool_choice: "auto",
      max_tool_calls: 10,
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      truncation: "auto",
      max_output_tokens: 12000,
      text: {
        format: {
          type: "json_schema",
          name: "technology_sources",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              items: {
                type: "array",
                minItems: maxItems,
                maxItems: maxItems,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    title: { type: "string" },
                    url: { type: "string" },
                    access_hint: { type: "string" },
                    technology_description: { type: "string" },
                    inputs_outputs_hint: {
                      type: "array",
                      items: { type: "string" },
                    },
                    evidence_snippets: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: [
                    "title",
                    "url",
                    "access_hint",
                    "technology_description",
                    "inputs_outputs_hint",
                    "evidence_snippets",
                  ],
                },
              },
            },
            required: ["items"],
          },
        },
      },
    };

    const searchResp = await openaiResponsesWithRetry(
      searchPayload,
      axiosConfig,
    );

    if (searchResp.status !== "completed") {
      return reply(422, {
        success: false,
        error: "Insufficient valid sources",
      });
    }

    const searchJSON = extractStructuredJSON(searchResp);
    if (!searchJSON || !Array.isArray(searchJSON.items)) {
      return reply(422, {
        success: false,
        error: "Insufficient valid sources",
        got: Array.isArray(searchJSON?.items) ? searchJSON.items.length : 0,
        expected: maxItems,
        debug: { items: searchJSON?.items ?? null },
      });
    }

    const items = searchJSON.items.filter(
      (i) => typeof i?.url === "string" && i.url.startsWith("http"),
    );

    if (items.length < maxItems) {
      return reply(422, {
        success: false,
        error: "Insufficient valid sources",
        got: items.length,
        expected: maxItems,
        debug: { items: searchJSON.items },
      });
    }

    const blocks_preview = items
      .slice(0, maxItems)
      .map((it, i) =>
        [
          `--- Блок ${i + 1} ---`,
          `URL: ${it.url}`,
          `access_hint: ${it.access_hint}`,
          `technology_description: ${it.technology_description}`,
        ].join("\n"),
      );

    return reply(200, {
      success: true,
      product: productName,
      maxItems,
      blocks_preview,
      sources: items.slice(0, maxItems),
    });
  } catch (error) {
    return reply(500, {
      success: false,
      error: error.response?.data || error.message,
    });
  }
}); */
async function openaiResponsesWithRetry(payload, axiosConfig) {
  // 1-я попытка
  let { data } = await axios.post(OPENAI_URL, payload, axiosConfig);

  // 1 ретрай, если модель упёрлась в max_output_tokens
  if (
    data?.status === "incomplete" &&
    data?.incomplete_details?.reason === "max_output_tokens"
  ) {
    const bumped = {
      ...payload,
      max_output_tokens: Math.max(
        (payload.max_output_tokens || 6000) * 2,
        12000,
      ),
      reasoning: { effort: "low" },
      parallel_tool_calls: false,
      max_tool_calls: payload.max_tool_calls ?? 10,
      tools: Array.isArray(payload.tools)
        ? payload.tools.map((t) =>
            t?.type === "web_search" ? { ...t, search_context_size: "low" } : t,
          )
        : payload.tools,
    };

    ({ data } = await axios.post(OPENAI_URL, bumped, axiosConfig));
  }

  return data;
}

/* function extractAssistantText(respJson) {
  const out = Array.isArray(respJson?.output) ? respJson.output : [];
  const parts = [];

  for (const item of out) {
    if (Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join("\n").trim();
} */
/* 
function extractStructuredJSON(respJson) {
  const txt = extractAssistantText(respJson);

  try {
    return JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
} */

/* ============================
   Route: ONLY SEARCH SOURCES
   POST /graphs/gpt/sources
   ============================ */

/* router.post("/gpt/sources", async (req, res) => {
  try {
    const productName = (req.body?.productName || "").trim();
    const maxItems = Number.isFinite(Number(req.body?.maxItems))
      ? Number(req.body.maxItems)
      : 5;

    if (!productName) {
      return res
        .status(400)
        .json({ success: false, error: "productName is required" });
    }
    if (!process.env.GPT_API_KEY) {
      return res
        .status(500)
        .json({ success: false, error: "GPT_API_KEY is not set in env" });
    }
    if (maxItems < 1 || maxItems > 10) {
      return res
        .status(400)
        .json({ success: false, error: "maxItems must be between 1 and 10" });
    }

    const axiosConfig = {
      headers: {
        Authorization: `Bearer ${process.env.GPT_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 0,
    };

    // ---------- Prompt ----------
    const searchPrompt = `
## Роль и задача

Ты — инженер-технолог. Твоя задача: найти источники, где ЯВНО описана технология/процесс промышленного получения (manufacturing / production process) указанного продукта, и извлечь из каждого источника КРАТКОЕ ОПИСАНИЕ ТЕХНОЛОГИИ (а не саммари статьи).

## Что считать “описанием технологии”
Технологическое описание = 3–5 предложений про сам процесс:
- ключевые стадии/узлы (например: подготовка сырья → реакция/синтез → разделение → очистка → сушка/грануляция и т.п.);
- основные реагенты/сырьё;
- условия и/или оборудование (если указаны: T, P, катализатор, растворитель, тип реактора, колонна, фильтрация и т.д.);
- важные технологические параметры (если указаны).

⚠️ Нельзя писать: “в статье рассматривается…”, “авторы обсуждают…”, “работа посвящена…”.
Нужно писать: “Процесс включает…”, “Сырьё подают…”, “Реакцию ведут…”, “Продукт отделяют…”.

## Критерии отбора источников

Отбирай источники, которые содержат хотя бы часть из:
- стадии процесса / flow description;
- сырьё/реагенты;
- оборудование/условия;
- схемы/flowsheet;
- типовые параметры;
- технологические обзоры/handbook-описания процесса.

Избегай источников без технических подробностей.

Предпочитай:
- патенты;
- handbooks/учебники;
- обзоры/статьи с явным разделом “Production/Manufacture/Industrial process”;
- стандарты/тех. бюллетени производителей;
- материалы гос/международных организаций.

## ВАЖНО: требование “LLM-readable”
Выбирай ТОЛЬКО такие источники, которые модель сможет прочитать напрямую:
- открываются без логина/paywall/капчи;
- текст доступен как HTML или текстовый PDF (не скан-картинки);
- если PDF — текст должен быть выделяемым.

Если источник не читается — НЕ включай.

## Запрос

Найди источники с описанием технологии получения продукта: "{productName}".
Язык результата неограничен. Верни {maxItems} лучших источников.
Не выводи дополнительные вопросы/комментарии, оставляй запрошенную информацию.

## Что сделать по каждому источнику

1) Дай реальный URL.
2) access_hint: "open html" / "text pdf".
3) technology_description: 3–5 предложений, ОПИСЫВАЮЩИХ ТЕХНОЛОГИЮ (стадии/узлы/условия/оборудование), строго по тексту источника.
   - Это НЕ summary статьи и НЕ “о чем документ”.
4) inputs_outputs_hint: перечисли входы/выходы/побочные продукты, только если явно указаны или прямо следуют из описанного пути (если сомневаешься — пропусти).
5) evidence_snippets: 2–4 коротких фрагмента (до ~20 слов каждый) из источника, которые подтверждают ключевые элементы technology_description.
   - Если не можешь найти подтверждающие фразы в тексте — источник не подходит.

## Правила честности

- Не выдумывай: если не уверен — поле не заполняй или исключи источник.
- Не включай источники, которые не удаётся открыть/прочитать.
- Не цитируй длинные фрагменты; только короткие snippets для верификации.

Верни РОВНО ${maxItems} источников.
Верни ТОЛЬКО JSON по схеме.
`.trim();

    // ---------- Payload ----------
    const searchPayload = {
      model: "gpt-5-mini",
      input: searchPrompt,

      tools: [{ type: "web_search", search_context_size: "low" }],
      tool_choice: "auto",
      max_tool_calls: 10,
      parallel_tool_calls: false,

      reasoning: { effort: "low" },
      truncation: "auto",
      max_output_tokens: 12000,

      text: {
        format: {
          type: "json_schema",
          name: "technology_sources",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              items: {
                type: "array",
                minItems: maxItems,
                maxItems: maxItems,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    title: { type: "string" },
                    url: { type: "string" },
                    access_hint: { type: "string" },
                    technology_description: { type: "string" },
                    inputs_outputs_hint: {
                      type: "array",
                      items: { type: "string" },
                    },
                    evidence_snippets: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: [
                    "title",
                    "url",
                    "access_hint",
                    "technology_description",
                    "inputs_outputs_hint",
                    "evidence_snippets",
                  ],
                },
              },
            },
            required: ["items"],
          },
        },
      },
    };

    const searchResp = await openaiResponsesWithRetry(
      searchPayload,
      axiosConfig,
    );

    if (searchResp.status !== "completed") {
      return res.status(422).json({
        success: false,
        error: "Insufficient valid sources",
      });
    }

    const searchJSON = extractStructuredJSON(searchResp);
    if (!searchJSON || !Array.isArray(searchJSON.items)) {
      return res.status(422).json({
        success: false,
        error: "Insufficient valid sources",
      });
    }

    // оставим только валидные url
    const items = searchJSON.items.filter(
      (i) => typeof i?.url === "string" && i.url.startsWith("http"),
    );

    if (items.length < maxItems) {
      return res.status(422).json({
        success: false,
        error: "Insufficient valid sources",
        got: items.length,
        expected: maxItems,
        debug: { items: searchJSON.items },
      });
    }

    const blocks_preview = items
      .slice(0, maxItems)
      .map((it, i) =>
        [
          `--- Блок ${i + 1} ---`,
          `URL: ${it.url}`,
          `access_hint: ${it.access_hint}`,
          `technology_description: ${it.technology_description}`,
        ].join("\n"),
      );

    return res.json({
      success: true,
      product: productName,
      maxItems,
      blocks_preview,
      sources: items.slice(0, maxItems).map((x) => ({
        title: x.title,
        url: x.url,
        access_hint: x.access_hint,
        technology_description: x.technology_description,
        inputs_outputs_hint: x.inputs_outputs_hint,
        evidence_snippets: x.evidence_snippets,
      })),
    });
  } catch (error) {
    console.error(
      "GPT SOURCES(SEARCH) ERROR:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});
 */
// routes/gptSources.js

/* function extractOutputText(resp) {
  // если вдруг твой wrapper уже добавляет output_text
  if (typeof resp.output_text === "string") return resp.output_text;

  const parts = [];
  const out = Array.isArray(resp.output) ? resp.output : [];

  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c.text === "string") {
          parts.push(c.text);
        }
      }
    }
  }
  return parts.join("");
}

router.post("/gpt/sources/aggregate", async (req, res) => {
  try {
    const productName = (req.body?.productName || "").trim();
    const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];

    if (!productName) {
      return res
        .status(400)
        .json({ success: false, error: "productName is required" });
    }
    if (!process.env.GPT_API_KEY) {
      return res
        .status(500)
        .json({ success: false, error: "GPT_API_KEY is not set in env" });
    }
    if (!sources.length) {
      return res
        .status(400)
        .json({ success: false, error: "sources[] is required" });
    }

    // Берём только первые 5
    const picked = sources.slice(0, 5);

    // Берём только technology_description
    const blocks = picked
      .map((s) => (s?.technology_description || "").toString().trim())
      .filter(Boolean);

    if (blocks.length < 2) {
      return res.status(400).json({
        success: false,
        error: "Need at least 2 technology_description blocks to aggregate",
      });
    }

    const axiosConfig = {
      headers: {
        Authorization: `Bearer ${process.env.GPT_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 0,
    };

    // --------- SYSTEM / USER как в Python ----------
    const SYSTEM = `Ты — инженер-технолог.
Твоя задача: по 5 описаниям промышленной технологии получения одного и того же продукта
собрать итоговое технологическое описание (НЕ пересказ документов, а описание процесса).
Если по сути один маршрут — выдай одну сводную технологию.
Если есть различные маршруты — выдели альтернативы и варианты внутри них.
Запрещено: вопросы пользователю, вступления, комментарии.
Вывод: строго по шаблону, только Markdown-текст, без лишних блоков.
`.trim();

    const USER_PROMPT = `
    Есть 5 текстовых описаний технологий получения одного и того же продукта. Сконсолидируй их и выдай максимально подробное текстовое описание (НЕ JSON) + перечисли РЕАЛЬНЫЕ альтернативные маршруты (если они упомянуты хотя бы в одном из 5 описаний).

ОГРАНИЧЕНИЯ
- Пиши только про процесс: стадии/узлы/операции/оборудование/условия (если явно есть в описаниях).
- Запрещено: “в статье говорится…”, “авторы обсуждают…”, “документ посвящён…”.
- Используй ТОЛЬКО факты из 5 описаний. Никаких внешних знаний и догадок.

КРИТИЧЕСКОЕ ПРАВИЛО, ЧТОБЫ НЕ ПОТЕРЯТЬ АЛЬТЕРНАТИВЫ
ЗАПРЕЩЕНО “склеивать” разные маршруты в одну сводную технологию через слова “или/либо/и т.п.” на уровне:
- класса сырья (например: “X или Y сырьё”),
- способа получения ключевого промежуточного/компонента,
- основного производящего узла (главного превращения),
- принципа выделения/очистки продукта.
Если в описаниях встречаются такие развилки — это НЕ одна цепочка. Это разные маршруты → оформляй как разные альтернативы (или как “Варианты”, если это неструктурные отличия).

ЧТО СЧИТАЕТСЯ “СКЕЛЕТОМ ПРОЦЕССА” (универсально для любых продуктов)
Скелет = 4 блока:
1) маршрут получения/подготовки ключевых потоков/полуфабрикатов (включая источник ключевых реагентов/компонентов),
2) основной производящий узел (где “делается” продукт),
3) выделение/очистка/доведение продукта,
4) рециклы/побочные потоки (если явно есть).
Любое различие в (1)-(3) — это СТРУКТУРНАЯ альтернатива.

КАК ГРУППИРОВАТЬ 5 ОПИСАНИЙ (обязательно; в ответе шаги группировки НЕ описывай)
1) Для каждого из 5 описаний составь “маршрутный ключ” (route signature) из ТОЛЬКО явных фактов:
   - Сырьё/источник ключевых потоков:
   - Способ получения ключевого промежуточного/компонента (если есть):
   - Основной производящий узел (тип превращения/операции):
   - Метод выделения/очистки/доведения продукта:
2) Сгруппируй описания по одинаковому маршрутному ключу.
3) Самая “частая” группа → “Сводная технология”.
4) Любая другая группа → отдельная “Альтернатива”.
5) Если в одном описании явно перечислены 2+ разных маршрутных ключа (например “вариант A ... / вариант B ...”) — это 2+ альтернативы, даже если остальные описания молчат про один из вариантов.

ПРАВИЛО ПРИОРИТЕТА (чтобы не было ложного “Альтернативы: []”)
Если сомневаешься, структурное ли отличие — СЧИТАЙ ЕГО СТРУКТУРНЫМ и выделяй альтернативу, но помечай неполноту через пустые потоки [] и/или короткую оговорку в “Примечаниях”.

ДЕДУПЛИКАЦИЯ (когда НЕ создавать отдельную альтернативу)
Считай две технологии ОДНОЙ альтернативой, если совпадают (1)-(3) скелета, а различия только “исполнительские”:
- катализатор/марка/материал,
- давление/температура/число слоёв/ступеней,
- фирменные названия секций/петель,
- конкретные исполнения оборудования.
Тогда НЕ делай отдельную альтернативу — добавь “Варианты внутри альтернативы”.

ВХОД/ВЫХОД ДЛЯ КАЖДОГО ШАГА (ОБЯЗАТЕЛЬНО)
Для КАЖДОГО шага в “Сводной технологии” и в КАЖДОМ шаге каждой альтернативы укажи:
- “Входные продукты”: [..] или []
- “Выходные продукты”: [..] или []
Правила:
- Только то, что явно следует из описаний; если неясно — [].
- Не включай оборудование/катализаторы/условия в списки потоков.
- Нормализуй названия продуктов кратко и единообразно.
- Последний шаг каждой технологии: в “Выходные продукты” включи “Исходный продукт” (если не противоречит тексту).
- Можно обобщённые потоки, если так в описании (“смесь”, “раствор”, “очищенный поток”, “реакционная смесь”, “полуфабрикат”).

ТРЕБОВАНИЯ К ДЕТАЛЬНОСТИ
- “Сводная технология”: максимально подробно как единая сквозная цепочка выбранного (самого частого) маршрутного ключа.
- Для шага: 1–3 абзаца по делу (операция/узел/условия — только если явно есть).
- Если один и тот же шаг в разных описаниях раскрыт по-разному — объединяй детали в рамках шага или делай подшаги.

СТРОГИЙ ВЫВОД (ТОЛЬКО ТЕКСТ ПО ШАБЛОНУ, MARKDOWN)
Верни ТОЛЬКО текст в формате Markdown, без вступлений/пояснений до/после.

# Исходный продукт
Исходный продукт: <одной строкой>

# Сводная технология (максимально подробная)
Ниже — единая консолидированная цепочка (самый частый маршрутный ключ среди 5 описаний). ВАЖНО: НЕ используй “или/либо” для объединения разных маршрутов — если есть развилка, вынеси её в “Альтернативы”.

## Шаг 1. <Название шага>
- Входные продукты: [..] / []
- Выходные продукты: [..] / []
- Описание: <1–3 абзаца>

## Шаг 2. ...
(и т.д.)

# Альтернативы (только если реально разные маршруты)
Если найдено ≥2 разных маршрутных ключа — ОБЯЗАТЕЛЬНО опиши альтернативы (даже если по ним мало деталей).
Альтернативы: [] допускается ТОЛЬКО если все 5 описаний имеют один и тот же маршрутный ключ И в текстах нет явных развилок по сырью/ключевому узлу/выделению.

Иначе для каждой альтернативы:

## Альтернатива: <Название маршрута>
Коротко (1–3 предложения): чем отличается по скелету процесса (сырьё/источник ключевых потоков → ключевой узел → выделение/очистка).

### Шаг 1. <Название шага>
- Входные продукты: [..] / []
- Выходные продукты: [..] / []
- Описание: <1–3 абзаца>

### Шаг 2. ...
(и т.д.)

### Варианты внутри альтернативы (если есть)
- Отличие: <кратко>
  - Детали: <маркированный список различий, только из описаний>
(если вариантов нет — напиши: **Варианты: []**)

# Примечания
- Только важные оговорки/неопределённости из описаний.
- ОБЯЗАТЕЛЬНО добавь “Контроль альтернатив”: перечисли найденные маршрутные ключи и какие описания (1–5) к какому ключу отнесены.
- Если нечего добавить — напиши: Примечания: []

Описания (используй только их, без внешних знаний):

1) ${blocks[0] || ""}

2) ${blocks[1] || ""}

3) ${blocks[2] || ""}

4) ${blocks[3] || ""}

5) ${blocks[4] || ""}
`.trim();

    const payload = {
      model: "gpt-5-mini",
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER_PROMPT },
      ],

      reasoning: { effort: "low" },
      truncation: "auto",
      max_output_tokens: 12000,
    };

    const resp = await openaiResponsesWithRetry(payload, axiosConfig);

    if (resp.status !== "completed") {
      return res.status(422).json({
        success: false,
        error: "Insufficient valid sources",
      });
    }

    // Надёжно вытаскиваем текст ответа (Markdown)
    const markdown = extractOutputText(resp)?.trim?.() || "";

    if (!markdown) {
      return res.status(502).json({
        success: false,
        error: "GPT aggregation returned empty output",
        debug: { raw: resp },
      });
    }

    return res.json({
      success: true,
      product: productName,
      aggregated_description: markdown, // ✅ теперь это Markdown как в Python
      sources: picked, // ✅ для аккордеонов
    });
  } catch (error) {
    console.error(
      "GPT SOURCES(AGGREGATE) ERROR:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});
 */
// ============================
//   GPT Variant Chain Endpoint
//   POST /graphs/gpt/variant-chain
// ============================

/* const VARIANT_MODEL = "gpt-5-mini";
const VARIANT_MAX_OUTPUT_TOKENS = 12000;

const FLOW_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["Продукт", "Количество"], // ✅ ВСЕ ключи из properties
  properties: {
    Продукт: { type: "string" },
    Количество: { type: "string" }, // "" если неизвестно
  },
};
 */
/* const CHAIN_NODE_SCHEMA = {
  type: "object",
  additionalProperties: false,

  // ✅ required должен включать ВСЕ ключи из properties
  required: [
    "Id узла",
    "Тип узла",
    "Название узла",
    "Продукты",
    "Название технологии",
    "Входы",
    "Выходы",
    "Описание",
  ],

  properties: {
    "Id узла": { type: "string" },
    "Тип узла": { type: "string", enum: ["Продукт", "Преобразование"] },

    "Название узла": { type: "string" },
    Продукты: { type: "array", items: { type: "string" } },

    "Название технологии": { type: "string" },
    Входы: { type: "array", items: FLOW_ITEM_SCHEMA },
    Выходы: { type: "array", items: FLOW_ITEM_SCHEMA },

    Описание: { type: "string" },
  },
};

const CHAIN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["Название", "Цепочка"], // ✅ все ключи верхнего уровня
  properties: {
    Название: { type: "string" },
    Цепочка: {
      type: "array",
      minItems: 1,
      items: CHAIN_NODE_SCHEMA,
    },
  },
};

const SYSTEM_PROMPT_ONE = `
Ты — инженер-технолог и структурировщик производственных цепочек.

На вход даётся JSON с полями:
- "Название_цепочки"
- "Исходный_продукт"
- "Шаги": массив шагов.

Шаг может быть:
1) строкой (это "Название" шага),
2) объектом {Название, Входные_продукты, Выходные_продукты, Описание}.

Задача: построить ОДНУ цепочку узлов "Продукт" и "Преобразование".

Правила:
- Каждый продукт, встречающийся во входах/выходах (если они есть), обязан иметь узел "Продукт".
- Нормализация продукта:
  - если строка содержит "/" и это похоже на альтернативы (например "природный_газ/углеводородное_сырьё"),
    то "Продукты" = split по "/", а "Название узла" = исходная строка.
  - иначе "Продукты" = [исходная строка].
- Если в названии шага несколько стадий через "→" (или явное перечисление стадий),
  разбей на несколько узлов "Преобразование", добавив промежуточные продуктовые узлы.
- Внутри "Цепочка": сначала все продуктовые узлы, затем преобразования в технологическом порядке.
- "Описание" в преобразовании: если есть во входе шага, добавь, но СЖИМАЙ до ~250 символов.

ФОРМАТ ВХОДОВ/ВЫХОДОВ (СТРОГО):
- "Входы" и "Выходы" — массив объектов вида:
  { "Продукт": "<название>", "Количество": "<строка>" }
- Если количество неизвестно: "Количество": "" (пустая строка)

ПРАВИЛА ЗАПОЛНЕНИЯ ПОЛЕЙ:
- Для узла "Продукт":
  - заполни "Название узла" и "Продукты"
  - "Название технологии" = "", "Входы" = [], "Выходы" = [], "Описание" = ""
- Для узла "Преобразование":
  - заполни "Название технологии", "Входы", "Выходы", "Описание" (если нет — "")
  - "Название узла" = "", "Продукты" = []
Верни только JSON, без текста.
`.trim();

function pickStepsFromTech(tech, selectedPath) {
  if (!tech) return null;
  if (!selectedPath || selectedPath.kind === "summary") {
    return tech?.Сводная_технология?.Шаги ?? null;
  }

  if (selectedPath.kind === "alternative") {
    const alts = Array.isArray(tech?.Альтернативы) ? tech.Альтернативы : [];
    const byIndex = Number.isFinite(selectedPath.index)
      ? alts[selectedPath.index]
      : null;
    if (byIndex?.Шаги) return byIndex.Шаги;

    if (selectedPath.name) {
      const byName = alts.find((a) => a?.Название === selectedPath.name);
      return byName?.Шаги ?? null;
    }
  }

  return null;
}

function normalizeSteps(steps) {
  // допускаем массив строк или массив объектов
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => {
      if (typeof s === "string") return s.trim();
      if (s && typeof s === "object") return s;
      return null;
    })
    .filter(Boolean);
} */

/* async function callOneChainLLM({ productName, chainName, steps }, axiosConfig) {
  const reqObj = {
    Название_цепочки: chainName || "Цепочка",
    Исходный_продукт: productName,
    Шаги: steps,
  };

  const inputText = "json\nВходной json:\n" + JSON.stringify(reqObj);

  const payload = {
    model: VARIANT_MODEL,
    instructions: SYSTEM_PROMPT_ONE,
    input: inputText,
    reasoning: { effort: "low" },
    truncation: "auto",
    max_output_tokens: VARIANT_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "chain_output",
        strict: true,
        schema: CHAIN_JSON_SCHEMA,
      },
    },
  };

  const resp = await openaiResponsesWithRetry(payload, axiosConfig);

  if (resp.status !== "completed") {
    const err = new Error("GPT variant chain did not complete");
    err.debug = {
      status: resp.status,
      incomplete_details: resp.incomplete_details,
    };
    throw err;
  }

  const jsonOut = extractStructuredJSON(resp);
  if (!jsonOut || !Array.isArray(jsonOut.Цепочка)) {
    const err = new Error("GPT variant chain returned invalid structured JSON");
    err.debug = { raw: resp };
    throw err;
  }
  return withDefaultsChain(jsonOut);
}
 */
/* router.post("/gpt/alternatives", async (req, res) => {
  try {
    const productName = String(req.body?.productName || "").trim();
    if (!productName) {
      return res
        .status(400)
        .json({ success: false, error: "productName is required" });
    }
    if (!process.env.GPT_API_KEY) {
      return res
        .status(500)
        .json({ success: false, error: "GPT_API_KEY is not set in env" });
    }

    const chainName = String(req.body?.chainName || "").trim();

    const selectedPath =
      req.body?.selectedPath && typeof req.body.selectedPath === "object"
        ? req.body.selectedPath
        : { kind: "summary" };

    // ✅ принимаем разные формы tech из фронта/других ответов
    const techIn = req.body?.tech;
    const tech =
      techIn?.aggregated_technology ?? // если шлют весь ответ sources
      techIn?.aggregated ?? // если шлют node.data.tech
      techIn ?? // если шлют чистый aggregated JSON
      null;

    // ✅ steps берём либо напрямую, либо вынимаем из tech
    const rawSteps = req.body?.steps ?? pickStepsFromTech(tech, selectedPath);
    const steps = normalizeSteps(rawSteps);

    if (!Array.isArray(steps) || steps.length < 1) {
      return res.status(400).json({
        success: false,
        error:
          "steps are required (or provide tech + selectedPath with non-empty steps)",
        debug: {
          gotStepsType: typeof rawSteps,
          stepsLen: Array.isArray(steps) ? steps.length : null,
          selectedPath,
          hasTech: !!tech,
          techKeys:
            tech && typeof tech === "object"
              ? Object.keys(tech).slice(0, 20)
              : null,
        },
      });
    }

    const axiosConfig = {
      headers: {
        Authorization: `Bearer ${process.env.GPT_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 0,
    };

    const chain = await callOneChainLLM(
      {
        productName,
        chainName:
          chainName ||
          (selectedPath?.kind === "alternative"
            ? "Альтернатива"
            : "Сводная_технология"),
        steps,
      },
      axiosConfig,
    );

    return res.json({
      success: true,
      product: productName,
      selectedPath,
      chain,
    });
  } catch (error) {
    console.error(
      "GPT VARIANT CHAIN ERROR:",
      error?.debug || error?.response?.data || error?.message,
    );
    return res.status(500).json({
      success: false,
      error: error?.response?.data || error?.message,
      debug: error?.debug,
    });
  }
});

router.post("/gpt/chain", async (req, res) => {
  try {
    const productName = (req.body?.productName || "").trim();
    const techText = (req.body?.techText || "").toString().trim();
    const targetProductId = (req.body?.targetProductId || "Продукт1")
      .toString()
      .trim();

    if (!productName) {
      return res
        .status(400)
        .json({ success: false, error: "productName is required" });
    }
    if (!techText) {
      return res
        .status(400)
        .json({ success: false, error: "techText is required" });
    }
    if (!process.env.GPT_API_KEY) {
      return res
        .status(500)
        .json({ success: false, error: "GPT_API_KEY is not set in env" });
    }

    const axiosConfig = {
      headers: {
        Authorization: `Bearer ${process.env.GPT_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 0,
    };

    // --- regex validators (как в питоне) ---
    const reProdId = /^Продукт\d+$/;
    const reTrId = /^Преобразование\d+$/;

    function validateChain(data) {
      const errors = [];

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return ["Корень JSON должен быть объектом (dict)."];
      }
      if (!("Цепочка" in data) || !Array.isArray(data["Цепочка"])) {
        return ['Должен быть ключ "Цепочка" со значением-массивом.'];
      }

      const chain = data["Цепочка"];
      if (chain.length === 0) errors.push('"Цепочка" не должна быть пустой.');

      const productIds = new Set();
      const nodeIds = new Set();

      for (let i = 0; i < chain.length; i++) {
        const node = chain[i];
        const idx = i + 1;

        if (!node || typeof node !== "object" || Array.isArray(node)) {
          errors.push(`Узел #${idx} не объект.`);
          continue;
        }

        const t = node["Тип узла"];
        const nid = node["Id узла"];

        if (
          typeof t !== "string" ||
          (t !== "Продукт" && t !== "Преобразование")
        ) {
          errors.push(
            `Узел #${idx}: неверный 'Тип узла' (ожидается Продукт/Преобразование).`,
          );
        }

        if (typeof nid !== "string") {
          errors.push(`Узел #${idx}: 'Id узла' должен быть строкой.`);
        } else {
          if (nodeIds.has(nid)) errors.push(`Дублирующийся 'Id узла': ${nid}`);
          nodeIds.add(nid);
        }

        if (t === "Продукт") {
          if (typeof nid !== "string" || !reProdId.test(nid)) {
            errors.push(`Продукт-узел #${idx}: Id узла должен быть ПродуктN.`);
          }
          const prods = node["Продукты"];
          const name = node["Название узла"];
          if (
            !Array.isArray(prods) ||
            prods.length < 1 ||
            !prods.every((x) => typeof x === "string" && x.trim())
          ) {
            errors.push(
              `Продукт-узел #${idx}: 'Продукты' должен быть массивом непустых строк.`,
            );
          }
          if (typeof name !== "string" || !name.trim()) {
            errors.push(
              `Продукт-узел #${idx}: 'Название узла' должен быть непустой строкой.`,
            );
          }
          if (typeof nid === "string" && reProdId.test(nid))
            productIds.add(nid);
        }

        if (t === "Преобразование") {
          if (typeof nid !== "string" || !reTrId.test(nid)) {
            errors.push(
              `Преобразование-узел #${idx}: Id узла должен быть ПреобразованиеN.`,
            );
          }
          const tech = node["Название технологии"];
          if (typeof tech !== "string" || !tech.trim()) {
            errors.push(
              `Преобразование-узел #${idx}: 'Название технологии' должен быть непустой строкой.`,
            );
          }

          for (const field of ["Входы", "Выходы"]) {
            const arr = node[field];
            if (!Array.isArray(arr) || arr.length === 0) {
              errors.push(
                `Преобразование-узел #${idx}: '${field}' должен быть непустым массивом.`,
              );
              continue;
            }
            for (let j = 0; j < arr.length; j++) {
              const obj = arr[j];
              const jj = j + 1;

              if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
                errors.push(
                  `Преобразование-узел #${idx}: ${field}[${jj}] должен быть объектом.`,
                );
                continue;
              }

              // новый формат: { "Продукт": "ПродуктN" }
              const keys = Object.keys(obj);
              if (keys.length !== 1 || keys[0] !== "Продукт") {
                errors.push(
                  `Преобразование-узел #${idx}: ${field}[${jj}] должен быть вида { "Продукт": "ПродуктN" }.`,
                );
                continue;
              }

              const v = obj["Продукт"];
              if (typeof v !== "string" || !reProdId.test(v)) {
                errors.push(
                  `Преобразование-узел #${idx}: ${field}[${jj}].Продукт должен быть Id продукта вида 'ПродуктN'.`,
                );
              }
            }
          }
        }
      }

      if (!productIds.has("Продукт1")) {
        errors.push("Обязательный финальный продукт 'Продукт1' отсутствует.");
      }

      // ссылки на существующие продукты
      for (const node of chain) {
        if (node?.["Тип узла"] === "Преобразование") {
          for (const field of ["Входы", "Выходы"]) {
            const arr = node[field];
            if (Array.isArray(arr)) {
              for (const obj of arr) {
                const pid = obj?.["Продукт"];
                if (
                  typeof pid === "string" &&
                  reProdId.test(pid) &&
                  !productIds.has(pid)
                ) {
                  errors.push(
                    `Ссылка на ${pid} из ${node["Id узла"]}:${field}, но такого продукт-узла нет.`,
                  );
                }
              }
            }
          }
        }
      }

      return errors;
    }

    // --- system prompt (как в питоне, плюс закрепляем Product1 = productName) ---
    const SYSTEM_PROMPT = `
Ты инженер-технолог. Преобразуй описание технологии в JSON-структуру графа.

ЖЕСТКИЕ ПРАВИЛА ФОРМАТА:
1) Верни ТОЛЬКО валидный JSON-объект, без текста вокруг.
2) Структура строго такая: {"Цепочка":[ ...узлы... ]}.
3) Узлы бывают двух типов:
   - Продукт: поля "Id узла","Тип узла"="Продукт","Продукты":[...],"Название узла".
   - Преобразование: поля "Id узла","Тип узла"="Преобразование","Название технологии","Входы","Выходы".
4) "Входы" — массив объектов вида { "Продукт": "Продукт2" }, { "Продукт": "Продукт3" } ...
   "Выходы" — массив объектов вида { "Продукт": "Продукт1" } ...
   В каждом объекте ДОЛЖЕН быть ровно один ключ: "Продукт".
5) Все ссылки во "Входы"/"Выходы" — это Id продукта вида "ПродуктN".
6) Создай продукт-узел ДЛЯ КАЖДОГО продукта, который фигурирует во входах/выходах.
7) Нумерация:
   - Финальный (целевой) продукт обязательно "Продукт1" и должен присутствовать в цепочке.
   - Остальные продукты: "Продукт2", "Продукт3", ...
   - Преобразования: "Преобразование1", "Преобразование2", ... по ходу процесса.
8) Не добавляй лишних шагов, если их нет в тексте. Если неоднозначность — выбирай самый типичный вариант.

ДОПОЛНИТЕЛЬНО:
- "Продукт1" должен соответствовать целевому продукту: ${productName}.
`.trim();

    // --- json_schema для выхода ---
    const ioRefSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        Продукт: { type: "string", pattern: "^Продукт\\d+$" },
      },
      required: ["Продукт"],
    };

    const chainSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        Цепочка: {
          type: "array",
          minItems: 1,
          items: {
            anyOf: [
              // --- Product node ---
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  "Id узла": { type: "string", pattern: "^Продукт\\d+$" },
                  "Тип узла": { type: "string", enum: ["Продукт"] },
                  Продукты: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string" },
                  },
                  "Название узла": { type: "string" },
                },
                required: ["Id узла", "Тип узла", "Продукты", "Название узла"],
              },

              // --- Transform node ---
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  "Id узла": {
                    type: "string",
                    pattern: "^Преобразование\\d+$",
                  },
                  "Тип узла": { type: "string", enum: ["Преобразование"] },
                  "Название технологии": { type: "string" },
                  Входы: { type: "array", minItems: 1, items: ioRefSchema },
                  Выходы: { type: "array", minItems: 1, items: ioRefSchema },
                },
                required: [
                  "Id узла",
                  "Тип узла",
                  "Название технологии",
                  "Входы",
                  "Выходы",
                ],
              },
            ],
          },
        },
      },
      required: ["Цепочка"],
    };

    async function callLLM(extraInstruction = "") {
      const userContent =
        `ОПИСАНИЕ ТЕХНОЛОГИИ:\n\n${techText}` +
        (extraInstruction ? `\n\n${extraInstruction}` : "");

      const payloadChain = {
        model: "gpt-5-mini",
        reasoning: { effort: "low" },
        max_output_tokens: 4000,
        truncation: "auto",
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "tech_chain",
            strict: true,
            schema: chainSchema,
          },
        },
      };

      const resp = await openaiResponsesWithRetry(payloadChain, axiosConfig);
      if (resp.status !== "completed") {
        throw new Error("GPT did not complete");
      }
      return extractStructuredJSON(resp);
    }

    // --- repair loop (как в питоне) ---
    async function generateChainWithRepairs(maxAttempts = 3) {
      let last = null;
      let extra = "";

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const data = await callLLM(extra);
        const errs = validateChain(data);

        if (!errs.length) return data;

        last = data;
        extra =
          "В предыдущем JSON есть ошибки формата. Исправь JSON, сохранив смысл технологии.\n" +
          "ВАЖНО: верни ТОЛЬКО JSON-объект.\n\n" +
          "Ошибки:\n- " +
          errs.join("\n- ") +
          "\n\n" +
          "Предыдущий JSON:\n" +
          JSON.stringify(last, null, 2);
      }

      const msg =
        "Не удалось получить валидный JSON после исправлений. Последний JSON:\n" +
        JSON.stringify(last, null, 2);

      const err = new Error(msg);
      err.debug_last = last;
      throw err;
    }

    const chain = await generateChainWithRepairs(3);

    // --- helper: сформировать “1 уровень” (target product + transformation + inputs) ---
    function buildLevel1(chainJson, targetPid = "Продукт1") {
      const items = chainJson?.["Цепочка"] || [];
      const products = new Map();
      const transforms = [];

      for (const n of items) {
        if (n?.["Тип узла"] === "Продукт") products.set(n["Id узла"], n);
        if (n?.["Тип узла"] === "Преобразование") transforms.push(n);
      }

      // найдём преобразование, которое выдаёт targetPid
      const t = transforms
        .map((x) => {
          const outs = Array.isArray(x["Выходы"]) ? x["Выходы"] : [];
          const outIds = outs.map((o) => o?.["Продукт"]).filter(Boolean);
          const num =
            parseInt(String(x["Id узла"]).replace("Преобразование", ""), 10) ||
            9999;
          return { x, outIds, num };
        })
        .filter((o) => o.outIds.includes(targetPid))
        .sort((a, b) => a.num - b.num)[0]?.x;

      if (!t) return null;

      const inArr = Array.isArray(t["Входы"]) ? t["Входы"] : [];
      const inputPids = inArr.map((o) => o?.["Продукт"]).filter(Boolean);

      const sub = [];
      if (products.get(targetPid)) sub.push(products.get(targetPid));
      sub.push(t);
      for (const pid of inputPids)
        if (products.get(pid)) sub.push(products.get(pid));

      return {
        targetPid,
        transformationId: t["Id узла"],
        inputPids,
        chain: { Цепочка: sub },
      };
    }

    const level1 = buildLevel1(chain, targetProductId);

    return res.json({
      success: true,
      product: productName,
      chain, // полный результат (в стор)
      level1, // удобный “1 уровень” (если хочешь сразу рисовать)
    });
  } catch (error) {
    console.error(
      "GPT GRAPH(CHAIN) ERROR:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});
 */
router.get("/__routes", (req, res) => {
  const routes = router.stack
    .filter((l) => l.route)
    .map((l) => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods),
    }));

  res.json({ success: true, routes });
});

module.exports = router;
