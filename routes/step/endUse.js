// routes/step/endUse.js
//
// POST /gpt/step/end-use — «что делают из продукта»: проверка, когда шаг
// «вниз» не нашёл продолжения (utils/endUse.js). Один запрос к модели с
// веб-поиском; найденные ссылки сервер загружает и проверяет.
//
// Тело: { productName, provider?, model? }.
// Ответ: { success, product, verdict: processed | end_product | unknown,
//   summary, conversions: [{ product, process, coReactants, title, url,
//   quote, server_check }], uses: [{ use, how, title, url, quote,
//   server_check }], sources: [TechnologySource] — превращения источниками
//   шага, dropped: [{ title, url, reason }] }.

const express = require("express");
const router = express.Router();

const { callOpenAIResponsesRaw, extractOutputText, safeJsonParse } = require("../sources/utils");
const { SCHEMA, endUsePrompt, parseEndUse, conversionSource, verdictOf } = require("./utils/endUse");
const { verifyStepSources } = require("./utils/verifySources");

// ---------- heartbeat ----------
// Поиск идёт минуту-другую: пробел раз в 15 с держит соединение через nginx.
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

/** Записи с проверкой сервера: выброшенные — прочь, остальным — server_check. */
async function verified(items, productName) {
  const asSources = items.map((x, i) => ({ title: x.title || `${productName} ${i}`, url: x.url, access_hint: "", _i: i }));
  const { kept, dropped } = await verifyStepSources(asSources);
  return {
    items: kept.map((k) => ({ ...items[k._i], server_check: k.server_check })),
    dropped,
  };
}

router.post("/gpt/step/end-use", async (req, res) => {
  const t0 = Date.now();
  const productName = String(req.body?.productName || "").trim();
  const provider = req.body?.provider ? String(req.body.provider).trim() : undefined;
  const model = req.body?.model ? String(req.body.model).trim() : undefined;
  if (!productName) {
    return res.status(400).json({ success: false, error: "productName is required" });
  }

  const stream = startAntiIdle(res, req);
  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;
    res.end(JSON.stringify({ ...obj, http_status: status, took_ms: Date.now() - t0 }));
  };

  try {
    const resp = await callOpenAIResponsesRaw({
      payload: {
        model: "gpt-5-mini",
        input: endUsePrompt(productName),
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "auto",
        reasoning: { effort: "low" },
        truncation: "auto",
        max_output_tokens: 6000,
        text: { format: { type: "json_schema", name: "product_end_use", schema: SCHEMA, strict: true } },
      },
      timeoutMs: 6 * 60 * 1000,
      provider,
      model,
      searchRequired: true,
    });
    const text = extractOutputText(resp);
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== "object") {
      return reply(502, {
        success: false,
        error: `Модель «${model || resp?.ai?.model || "по умолчанию"}» ответила не по схеме — проверка не удалась.`,
        ai: resp?.ai,
      });
    }
    const found = parseEndUse(parsed, productName);
    const conv = await verified(found.conversions, productName);
    const uses = await verified(found.uses, productName);
    if (stream.aborted) return;
    const verdict = verdictOf(conv.items, uses.items);
    console.log(
      `[step/end-use] «${productName}»: ${verdict}; превращений ${conv.items.length}, применений ${uses.items.length}, отброшено ${conv.dropped.length + uses.dropped.length}`,
    );
    return reply(200, {
      success: true,
      product: productName,
      verdict,
      summary: found.summary,
      conversions: conv.items,
      uses: uses.items,
      sources: conv.items.map((c) => ({ ...conversionSource(c, productName), server_check: c.server_check })),
      dropped: [...conv.dropped, ...uses.dropped],
      ai: resp?.ai,
    });
  } catch (err) {
    return reply(500, { success: false, error: err?.message || "Unknown error" });
  }
});

module.exports = router;
