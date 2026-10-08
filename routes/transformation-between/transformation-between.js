// routes/transformation-between/transformation-between.js

const express = require("express");
const router = express.Router();

const {
  buildTransformationsBetweenSystemPrompt,
  buildTransformationsBetweenUserContent,
  callOpenAIResponsesRaw,
  extractOutputText,
  safeJsonParse,
} = require("./utils");

// Ответ с веб-поиском идёт минутами. Статус и заголовки отдаём сразу, а
// пока модель думает, пишем пробелы: иначе nginx, не дождавшись заголовков,
// обрывает запрос. Пробелы перед JSON разбору не мешают. Как в остальных
// долгих маршрутах (step/aggregate.js, sources/sources.js).
function startAntiIdle(res, req, { heartbeatMs = 15000 } = {}) {
  let aborted = false;

  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  try {
    res.write(" ");
  } catch {}

  const hb = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(" \n");
    } catch {}
  }, heartbeatMs);

  const stop = () => clearInterval(hb);
  req.on("aborted", () => {
    aborted = true;
    stop();
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      stop();
    }
  });

  return {
    stop,
    get aborted() {
      return aborted;
    },
  };
}

// POST /api/graphs/gpt/transformation-between
// body: {
//   "Цепочка": ChainProductNode[],
//   "Связи":   ChainLink[],
//   customSystemPrompt?: string
// }
// Ошибки после начала ответа приходят со статусом 200: { success: false,
// http_status, error }.
router.post("/gpt/transformation-between", async (req, res) => {
  const t0 = Date.now();
  let stream = null;
  const reply = (status, obj) => {
    if (!stream) return res.status(status).json(obj);
    stream.stop();
    if (stream.aborted) return;
    return res.end(JSON.stringify({ ...obj, http_status: status }));
  };

  try {
    const chain = Array.isArray(req.body?.["Цепочка"])
      ? req.body["Цепочка"]
      : null;
    const links = Array.isArray(req.body?.["Связи"]) ? req.body["Связи"] : null;
    const customSystemPrompt = req.body?.customSystemPrompt
      ? String(req.body.customSystemPrompt)
      : "";

    if (!chain || chain.length === 0) {
      return res.status(400).json({
        success: false,
        error: '"Цепочка" is required and must be a non-empty array',
      });
    }
    if (!links || links.length === 0) {
      return res.status(400).json({
        success: false,
        error: '"Связи" is required and must be a non-empty array',
      });
    }
    // Провайдера и модель выбирает пользователь на клиенте; ключ проверяет сам
    // транспорт — у каждого провайдера он свой, и проверка GPT_API_KEY здесь
    // отбивала бы запросы к DashScope.
    const provider = req.body?.provider
      ? String(req.body.provider).trim()
      : undefined;
    const model = req.body?.model ? String(req.body.model).trim() : undefined;

    const inputJsonText = JSON.stringify(
      { Цепочка: chain, Связи: links },
      null,
      2,
    );

    let systemPrompt =
      customSystemPrompt.trim() || buildTransformationsBetweenSystemPrompt();
    const hasPlaceholder = systemPrompt.includes("{INPUT_JSON}");
    if (hasPlaceholder) {
      systemPrompt = systemPrompt.replace("{INPUT_JSON}", inputJsonText);
    }

    const messages = [{ role: "system", content: systemPrompt }];
    if (!hasPlaceholder) {
      messages.push({
        role: "user",
        content: buildTransformationsBetweenUserContent(inputJsonText),
      });
    }

    const payload = {
      // Дефолт на случай, если клиент модель не прислал.
      model: "gpt-5-mini",
      max_output_tokens: 12000,
      truncation: "auto",
      input: messages,
      // Поиск — чтобы «Источники» были настоящими ссылками: промпт просит
      // проверить технологию поиском, а без инструмента модель брала ссылки
      // из памяти. DashScope получает вместо него enable_search (транспорт).
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: "auto",
      text: { format: { type: "json_object" } },
    };

    stream = startAntiIdle(res, req);
    const resp = await callOpenAIResponsesRaw({
      payload,
      timeoutMs: 10 * 60 * 1000,
      provider,
      model,
    });

    if (resp?.status !== "completed") {
      return reply(502, {
        success: false,
        error: "OpenAI response status is not completed",
        debug: {
          status: resp?.status,
          incomplete_details: resp?.incomplete_details ?? null,
        },
        took_ms: Date.now() - t0,
      });
    }

    const txt = extractOutputText(resp);
    const data = safeJsonParse(txt);

    if (!data || !Array.isArray(data["Цепочка"])) {
      return reply(502, {
        success: false,
        error: 'OpenAI did not return valid JSON with "Цепочка" array',
        debug: { output_text_preview: (txt || "").slice(0, 1500) },
        took_ms: Date.now() - t0,
      });
    }

    return reply(200, {
      success: true,
      Цепочка: data["Цепочка"],
      took_ms: Date.now() - t0,
    });
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";
    return reply(500, { success: false, error: msg, took_ms: Date.now() - t0 });
  }
});

module.exports = router;
