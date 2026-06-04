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

// POST /api/graphs/gpt/transformation-between
// body: {
//   "Цепочка": ChainProductNode[],
//   "Связи":   ChainLink[],
//   customSystemPrompt?: string
// }
router.post("/gpt/transformation-between", async (req, res) => {
  const t0 = Date.now();

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
    if (!process.env.GPT_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "GPT_API_KEY is not set in env",
      });
    }

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
      model: "gpt-5-mini",
      max_output_tokens: 12000,
      truncation: "auto",
      input: messages,
      text: { format: { type: "json_object" } },
    };

    const resp = await callOpenAIResponsesRaw({
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
        took_ms: Date.now() - t0,
      });
    }

    const txt = extractOutputText(resp);
    const data = safeJsonParse(txt);

    if (!data || !Array.isArray(data["Цепочка"])) {
      return res.status(502).json({
        success: false,
        error: 'OpenAI did not return valid JSON with "Цепочка" array',
        debug: { output_text_preview: (txt || "").slice(0, 1500) },
        took_ms: Date.now() - t0,
      });
    }

    return res.json({
      success: true,
      Цепочка: data["Цепочка"],
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
