// routes/chain/chain.js

const express = require("express");
const router = express.Router();

const {
  buildChainSystemPrompt,
  buildChainUserContent,
  extractOutputText,
  safeJsonParse,
  callOpenAIResponsesRaw,
  validateChain,
  buildLevel1,
} = require("./utils");

// POST /api/graphs/gpt/chain
// body: { productName: string, techText: string, targetProductId?: "Продукт1", maxAttempts?: number }
router.post("/gpt/chain", async (req, res) => {
  const t0 = Date.now();

  try {
    const productName = String(req.body?.productName || "").trim();
    const techText = String(req.body?.techText || "").trim();
    const targetProductId = String(
      req.body?.targetProductId || "Продукт1",
    ).trim();

    const maxAttemptsRaw = Number(req.body?.maxAttempts ?? 3);
    const maxAttempts = Number.isFinite(maxAttemptsRaw) ? maxAttemptsRaw : 3;

    const customSystemPrompt = req.body?.customSystemPrompt
      ? String(req.body.customSystemPrompt).trim()
      : "";

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

    let extra = "";
    let last = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const SYSTEM = customSystemPrompt || buildChainSystemPrompt(productName);
      const USER = buildChainUserContent(techText, extra);

      const payload = {
        model: "gpt-5-mini",
        max_output_tokens: 12000,
        truncation: "auto",
        input: [
          { role: "system", content: SYSTEM },
          { role: "user", content: USER },
        ],
        // ✅ как в Python: гарантирует валидный JSON-объект
        text: { format: { type: "json_object" } },
      };

      const resp = await callOpenAIResponsesRaw({
        apiKey: process.env.GPT_API_KEY,
        payload,
        timeoutMs: 10 * 60 * 1000,
      });

      if (resp?.status !== "completed") {
        return res.status(502).json({
          success: false,
          error: "OpenAI response status is not completed",
          debug: {
            status: resp?.status,
            incomplete_details: resp?.incomplete_details ?? null,
          },
        });
      }

      const txt = extractOutputText(resp);
      const data = safeJsonParse(txt);

      if (!data) {
        last = { _raw_preview: (txt || "").slice(0, 2000) };
        extra =
          "В предыдущем ответе JSON не распарсился. Исправь и верни ТОЛЬКО валидный JSON-объект.";
        continue;
      }

      const errs = validateChain(data);
      if (!errs.length) {
        const level1 = buildLevel1(data, targetProductId);

        return res.json({
          success: true,
          product: productName,
          chain: data,
          level1,
          attempts_used: attempt,
          took_ms: Date.now() - t0,
        });
      }

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

    return res.status(500).json({
      success: false,
      error:
        "Не удалось получить валидный JSON после исправлений. Последний JSON доступен в debug_last.",
      debug_last: last,
      took_ms: Date.now() - t0,
    });
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";
    return res
      .status(500)
      .json({ success: false, error: msg, took_ms: Date.now() - t0 });
  }
});

module.exports = router;
