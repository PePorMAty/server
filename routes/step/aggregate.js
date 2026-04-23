// routes/step/aggregate.js
//
// POST /gpt/step/aggregate — обобщить найденные источники в РОВНО ОДИН
// следующий шаг производственной цепочки. Вывод модели — Markdown по
// заданному шаблону, либо ровно строка "needs-sources".
//
// Совместимость: существующий /gpt/sources/aggregate НЕ трогаем. Этот роут параллельный.

const express = require("express");
const router = express.Router();

const {
  callOpenAIResponsesRaw,
  extractOutputText,
  pickTechnologyBlocksFromSources,
} = require("../sources/utils");

const { buildStepAggregatePrompts } = require("./utils/prompts");

// ---------- heartbeat ----------
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

function clip(s, limit) {
  const t = String(s || "").trim();
  return t.length > limit ? t.slice(0, limit) + "…" : t;
}

// Парсит "needs-sources" маркер и опциональный хвост с перечислением продуктов.
// Формат, который мы принимаем от модели:
//   "needs-sources"
//   либо
//   "needs-sources: аммиак, синтез-газ"
//   либо просто Markdown.
function parseNeedsSources(text) {
  if (!text) return null;
  const firstLine = text.split("\n", 1)[0].trim().toLowerCase();
  if (firstLine === "needs-sources") {
    return { insufficientProducts: [] };
  }
  const m = text.match(/^needs-sources\s*[:\-]\s*(.+)$/im);
  if (m) {
    const list = m[1]
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return { insufficientProducts: list };
  }
  return null;
}

router.post("/gpt/step/aggregate", async (req, res) => {
  const t0 = Date.now();

  // ---------- валидация ДО стрима ----------
  const productName = String(req.body?.productName || "").trim();
  const direction = req.body?.direction === "up" ? "up" : "down";
  const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
  const existingChain = req.body?.existingChain ?? "";
  const maxBlockCharsRaw = Number(req.body?.maxBlockChars ?? 2500);
  const maxBlockChars = Number.isFinite(maxBlockCharsRaw)
    ? maxBlockCharsRaw
    : 2500;

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

  // Отсечка по количеству релевантных блоков (как в /sources/aggregate)
  const { picked, blocks: rawBlocks } = pickTechnologyBlocksFromSources(
    sources,
    5,
  );
  const blocks = rawBlocks.map((b) => clip(b, maxBlockChars)).filter(Boolean);

  if (blocks.length < 1) {
    return res.status(400).json({
      success: false,
      error: "Need at least 1 technology_description block to aggregate",
      got: blocks.length,
    });
  }

  // ---------- heartbeat ----------
  const stream = startAntiIdle(res, req, { heartbeatMs: 15000 });
  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;
    return res.end(
      JSON.stringify({ ...obj, http_status: status, took_ms: Date.now() - t0 }),
    );
  };

  try {
    const { SYSTEM, USER_PROMPT } = buildStepAggregatePrompts({
      productName,
      existingChain,
      blocks,
    });

    // direction preamble (если когда-то понадобится — по аналогии с /sources/aggregate)
    const systemWithDir =
      direction === "up"
        ? `НАПРАВЛЕНИЕ: ВВЕРХ. "${productName}" рассматривай как ВХОДНОЕ СЫРЬЁ.\n\n${SYSTEM}`
        : SYSTEM;

    const payload = {
      model: "gpt-5-mini",
      instructions: systemWithDir,
      input: USER_PROMPT,
      truncation: "auto",
      max_output_tokens: 16000,
    };

    const resp = await callOpenAIResponsesRaw({
      apiKey: process.env.GPT_API_KEY,
      payload,
      timeoutMs: 10 * 60 * 1000,
    });

    if (resp?.status !== "completed") {
      return reply(502, {
        success: false,
        error: "OpenAI response status is not completed",
        debug: {
          status: resp?.status,
          incomplete_details: resp?.incomplete_details ?? null,
        },
      });
    }

    const markdown = (extractOutputText(resp) || "").trim();
    if (!markdown) {
      return reply(502, { success: false, error: "OpenAI returned empty output" });
    }

    const needs = parseNeedsSources(markdown);
    if (needs) {
      return reply(200, {
        success: true,
        status: "needs-sources",
        product: productName,
        direction,
        insufficientProducts: needs.insufficientProducts,
      });
    }

    return reply(200, {
      success: true,
      product: productName,
      direction,
      aggregated_markdown: markdown,
      sources: picked,
    });
  } catch (err) {
    return reply(500, {
      success: false,
      error: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

module.exports = router;
