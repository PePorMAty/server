// routes/sources/sources.js
const express = require("express");
const router = express.Router();

const {
  buildSourcesPrompt,
  buildSourcesPromptUp,
  explainBadAnswer,
  isSchemaEcho,
  sanitizeAllowedDomains,
  filterItemsByAllowedDomains,
  searchSources,
} = require("./utils");
const { saveWebSources } = require("../local-sources/utils/store");

// аккуратный heartbeat, который НЕ ломает JSON
function startAntiIdle(res, req, { heartbeatMs = 15000 } = {}) {
  let aborted = false;

  // статус/хедеры надо отдать сразу, иначе nginx будет ждать "response header"
  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");

  // важно: протолкнуть заголовки и хотя бы 1 байт
  res.flushHeaders?.();
  try {
    res.write(" "); // ведущий пробел допустим для JSON
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

router.post("/gpt/sources", async (req, res) => {
  const t0 = Date.now();

  // 1) Валидация ДО старта стрима (чтобы можно было вернуть 400/500 нормальным способом)
  const productName = String(req.body?.productName || "").trim();
  const maxItemsRaw = Number(req.body?.maxItems ?? 5);
  const maxItems = Number.isFinite(maxItemsRaw) ? maxItemsRaw : 5;
  const direction = req.body?.direction === "up" ? "up" : "down";
  const provider = req.body?.provider
    ? String(req.body.provider).trim()
    : undefined;
  const model = req.body?.model ? String(req.body.model).trim() : undefined;
  // Опциональный whitelist доменов для web_search (задача 3.3)
  const allowedDomains = sanitizeAllowedDomains(req.body?.allowedDomains);

  if (!productName) {
    return res
      .status(400)
      .json({ success: false, error: "productName is required" });
  }
  if (maxItems < 1 || maxItems > 10) {
    return res
      .status(400)
      .json({ success: false, error: "maxItems must be between 1 and 10" });
  }

  // 2) Стартуем anti-idle, чтобы браузер/прокси не резали долгий "молчаливый" запрос
  const stream = startAntiIdle(res, req, { heartbeatMs: 15000 });

  try {
    const prompt =
      direction === "up"
        ? buildSourcesPromptUp(productName, maxItems)
        : buildSourcesPrompt(productName, maxItems);

    // Пустой результат поиск повторяет сам (searchSources): модели порой
    // отвечают, не поискав, а со второго раза находят.
    const {
      resp: openaiResp,
      text,
      parsed,
      rawItems,
      items,
    } = await searchSources({
      prompt,
      maxItems,
      timeoutMs: 35 * 60 * 1000,
      provider,
      model,
      allowedDomains,
      filter: (xs) => filterItemsByAllowedDomains(xs, allowedDomains),
      isAborted: () => stream.aborted,
    });

    stream.stop();
    if (stream.aborted) return;

    // Оборванный ответ всё равно разбираем: если JSON в нём цел, источники
    // годятся. Статус уже 200 — поэтому причину отказа кладём внутрь.
    if (!rawItems) {
      return res.end(
        JSON.stringify({
          success: false,
          http_status: 502,
          error: isSchemaEcho(parsed)
            ? `Модель «${model || "по умолчанию"}» вернула схему ответа вместо источников — для поиска она не подходит, выберите другую модель.`
            : explainBadAnswer(openaiResp, text, model, {
                acc: "список источников",
                gen: "списка источников",
              }),
          ai: openaiResp?.ai,
          debug: {
            status: openaiResp?.status,
            incomplete_details: openaiResp?.incomplete_details ?? null,
            output_text_preview: (text || "").slice(0, 1200),
          },
        }),
      );
    }

    if (items.length < 1) {
      return res.end(
        JSON.stringify({
          success: false,
          http_status: 422,
          error: allowedDomains.length
            ? "Модель не нашла источников на разрешённых сайтах."
            : "Модель не нашла ни одного источника со ссылкой и описанием.",
          got: 0,
          expected: maxItems,
        }),
      );
    }

    // Найденное — в общую базу (как в /gpt/step/sources).
    saveWebSources(
      productName,
      direction,
      items.slice(0, maxItems),
      model || openaiResp?.ai?.model,
    );

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

    return res.end(
      JSON.stringify({
        success: true,
        product: productName,
        maxItems,
        direction,
        blocks_preview,
        sources: items.slice(0, maxItems),
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
