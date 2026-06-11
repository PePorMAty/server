// routes/step/sources.js
//
// POST /gpt/step/sources — найти источники для ОДНОГО шага (один продукт).
// Возвращает TechnologySource[] в JSON (тот же shape, что и /gpt/sources).
//
// Совместимость: существующий /gpt/sources НЕ трогаем. Этот роут параллельный.

const express = require("express");
const router = express.Router();

// reuse OpenAI utils from existing sources module
const {
  callOpenAIResponses,
  extractOutputText,
  safeJsonParse,
  normalizeAndFilterItems,
} = require("../sources/utils");

const {
  buildStepSourcesPromptDown,
  buildStepSourcesPromptUp,
} = require("./utils/prompts");

// ---------- heartbeat (как в routes/sources/sources.js) ----------
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

router.post("/gpt/step/sources", async (req, res) => {
  const t0 = Date.now();

  // ---------- валидация ДО стрима ----------
  const productName = String(req.body?.productName || "").trim();
  const direction = req.body?.direction === "up" ? "up" : "down";
  const maxItemsRaw = Number(req.body?.maxItems ?? 8);
  const maxItems = Number.isFinite(maxItemsRaw) ? maxItemsRaw : 8;
  const customSystemPrompt = req.body?.customSystemPrompt
    ? String(req.body.customSystemPrompt).trim()
    : null;
  const provider = req.body?.provider
    ? String(req.body.provider).trim()
    : undefined;
  const model = req.body?.model ? String(req.body.model).trim() : undefined;
  // Уже известные источники (клиент шлёт текущий пул продукта). Нужны, чтобы
  // отличить «источники закончились» от «в этот раз не нашлось».
  const existingSources = Array.isArray(req.body?.existingSources)
    ? req.body.existingSources
    : [];
  const existingUrls = new Set(
    existingSources.map((s) => String(s?.url || "").trim()).filter(Boolean),
  );

  if (!productName) {
    return res
      .status(400)
      .json({ success: false, error: "productName is required" });
  }
  if (maxItems < 1 || maxItems > 15) {
    return res
      .status(400)
      .json({ success: false, error: "maxItems must be between 1 and 15" });
  }

  // ---------- step-up: заглушка до появления up-промпта ----------

  const stream = startAntiIdle(res, req, { heartbeatMs: 15000 });

  try {
    const defaultPrompt =
      direction === "up"
        ? buildStepSourcesPromptUp(productName, maxItems)
        : buildStepSourcesPromptDown(productName, maxItems);
    const prompt = customSystemPrompt || defaultPrompt;

    const openaiResp = await callOpenAIResponses({
      prompt,
      maxItems,
      timeoutMs: 35 * 60 * 1000,
      provider,
      model,
    });

    stream.stop();
    if (stream.aborted) return;

    if (openaiResp?.status !== "completed") {
      return res.end(
        JSON.stringify({
          success: false,
          http_status: 502,
          error: "OpenAI response status is not completed",
          debug: {
            status: openaiResp?.status,
            incomplete_details: openaiResp?.incomplete_details ?? null,
          },
        }),
      );
    }

    const text = extractOutputText(openaiResp);
    const parsed = safeJsonParse(text);

    if (!parsed || !Array.isArray(parsed.items)) {
      return res.end(
        JSON.stringify({
          success: false,
          http_status: 502,
          error: "OpenAI did not return valid JSON items[]",
          debug: { output_text_preview: (text || "").slice(0, 1200) },
        }),
      );
    }

    const items = normalizeAndFilterItems(parsed.items);
    if (items.length < 1) {
      // Если у продукта уже были источники, а поиск ничего не дал — это
      // «источники закончились», а не ошибка: не роняем клиента 422,
      // возвращаем прежние источники с флагом exhausted.
      if (existingUrls.size > 0) {
        return res.end(
          JSON.stringify({
            success: true,
            product: productName,
            direction,
            maxItems,
            blocks_preview: [],
            sources: existingSources,
            exhausted: true,
            took_ms: Date.now() - t0,
          }),
        );
      }
      return res.end(
        JSON.stringify({
          success: false,
          http_status: 422,
          error: "No valid sources found",
          got: 0,
          expected: maxItems,
        }),
      );
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

    // «Исчерпано»: источники у продукта уже были, но новый поиск не дал
    // ничего сверх известных URL — сигналим, чтобы UI показал «закончились».
    const picked = items.slice(0, maxItems);
    const exhausted =
      existingUrls.size > 0 &&
      picked.every((it) => existingUrls.has(String(it?.url || "").trim()));

    return res.end(
      JSON.stringify({
        success: true,
        product: productName,
        direction,
        maxItems,
        blocks_preview,
        sources: picked,
        exhausted,
        took_ms: Date.now() - t0,
      }),
    );
  } catch (err) {
    stream.stop();
    if (stream.aborted) return;

    const msg = err?.response?.data || err?.message || "Unknown error";
    return res.end(
      JSON.stringify({
        success: false,
        http_status: 500,
        error: msg,
        took_ms: Date.now() - t0,
      }),
    );
  }
});

module.exports = router;
