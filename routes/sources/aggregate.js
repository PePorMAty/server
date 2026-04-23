// routes/sources/aggregate.js
const express = require("express");
const router = express.Router();

const {
  callOpenAIResponsesRaw,
  extractOutputText,
  pickTechnologyBlocksFromSources,
  buildAggregatePrompts,
} = require("./utils");

// heartbeat (анти-idle)
function startAntiIdle(res, req, { heartbeatMs = 15000 } = {}) {
  let aborted = false;

  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");

  res.flushHeaders?.();
  try {
    res.write(" "); // 1 байт, чтобы прокси увидели ответ
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

// (опционально) подрезаем слишком длинные blocks — сильно ускоряет
function clip(s, limit = 2500) {
  const t = String(s || "").trim();
  return t.length > limit ? t.slice(0, limit) + "…" : t;
}

router.post("/gpt/sources/aggregate", async (req, res) => {
  const t0 = Date.now();

  // ✅ ВАЛИДАЦИЯ ДО СТРИМА
  const productName = String(req.body?.productName || "").trim();
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

  const { picked, blocks: rawBlocks } = pickTechnologyBlocksFromSources(
    sources,
    5,
  );
  const blocks = rawBlocks.map((b) => clip(b, 2500)).filter(Boolean);

  if (blocks.length < 2) {
    return res.status(400).json({
      success: false,
      error: "Need at least 2 technology_description blocks to aggregate",
      got: blocks.length,
    });
  }

  // ✅ СТАРТ HEARTBEAT
  const stream = startAntiIdle(res, req, { heartbeatMs: 15000 });

  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;
    // уже 200 — кладём статус внутрь
    return res.end(
      JSON.stringify({ ...obj, http_status: status, took_ms: Date.now() - t0 }),
    );
  };

  try {
    const direction = String(req.body?.direction || "down").trim();
    const customUserPrompt = req.body?.customUserPrompt
      ? String(req.body.customUserPrompt).trim()
      : "";
    const customSystemPrompt = req.body?.customSystemPrompt
      ? String(req.body.customSystemPrompt).trim()
      : "";

    const { SYSTEM: defaultSystem, USER_PROMPT: defaultUser } =
      buildAggregatePrompts(productName, blocks);

    /* const { SYSTEM: defaultSystem, USER_PROMPT: defaultUser } =
      buildAggregatePrompts(productName, blocks);
    const SYSTEM = customSystemPrompt || defaultSystem; */

    // For "up" direction: prepend preamble clarifying productName is INPUT feedstock
    const upSystemPreamble =
      direction === "up"
        ? `НАПРАВЛЕНИЕ: ВВЕРХ (от сырья к продуктам переработки).\n"${productName}" — это ВХОДНОЕ СЫРЬЁ, а не конечный продукт.\nВ поле «Исходный продукт» ОБЯЗАТЕЛЬНО укажи "${productName}" (это входное сырьё/реагент, который подают на вход процессов).\nВсе цепочки должны начинаться с "${productName}" как входного потока.\nОписывай что и как производят ИЗ "${productName}", а не как получают "${productName}".\n\n`
        : "";
    const upUserPreamble =
      direction === "up"
        ? `Ниже 5 описаний технологий, в которых "${productName}" используется как ВХОДНОЕ СЫРЬЁ/реагент. Сконсолидируй их в производственные цепочки переработки/использования "${productName}".\n"Исходный продукт" = "${productName}" (входное сырьё). НЕ подменяй его на выходной продукт.\n\n`
        : "";

    const SYSTEM = customSystemPrompt || upSystemPreamble + defaultSystem;

    let USER_PROMPT;
    if (customUserPrompt) {
      const blocksSection = blocks
        .map((b, i) => `${i + 1}) ${b || ""}`)
        .join("\n");
      USER_PROMPT = customUserPrompt + "\n\nБлоки:\n\n" + blocksSection;
    } else {
      USER_PROMPT = upUserPreamble + defaultUser;
    }

    const payload = {
      model: "gpt-5-mini",
      instructions: SYSTEM,
      input: USER_PROMPT,
      truncation: "auto",
      max_output_tokens: 16000,
    };

    const resp = await callOpenAIResponsesRaw({
      apiKey: process.env.GPT_API_KEY,
      payload,
      timeoutMs: 10 * 60 * 1000, // 10 минут
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

    const markdown = extractOutputText(resp)?.trim() || "";
    if (!markdown) {
      return reply(502, {
        success: false,
        error: "OpenAI returned empty output",
      });
    }

    return reply(200, {
      success: true,
      product: productName,
      aggregated_description: markdown,
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
