// routes/fill-card/fill-card.js
const express = require("express");
const router = express.Router();

const {
  buildFillCardSystemPrompt,
  buildFillCardUserPrompt,
} = require("./utils/prompt");

const {
  callOpenAIFillCard,
  extractOutputText,
  safeJsonParse,
} = require("./utils/openai");

const {
  cardKeys,
  formatInstruction,
  cardFromAnswer,
  buildCardContext,
  asText,
} = require("./utils/card");

const { explainBadAnswer } = require("../sources/utils");

/** Что ждали от модели — для текста ошибки. */
const CARD_ANSWER = { acc: "карточку", gen: "карточки" };

router.post("/gpt/fill-card", async (req, res) => {
  const t0 = Date.now();

  try {
    const nodeType = String(req.body?.nodeType || "product").trim(); // ✅
    const provider = req.body?.provider
      ? String(req.body.provider).trim()
      : undefined;
    const model = req.body?.model ? String(req.body.model).trim() : undefined;
    if (!["product", "transformation"].includes(nodeType)) {
      return res.status(400).json({
        success: false,
        error: 'nodeType must be "product" or "transformation"',
      });
    }

    const productName = String(req.body?.productName || "").trim();
    const nodeObj = req.body?.node; // ✅
    const chainObj = req.body?.chain; // ✅
    const rawText = req.body?.rawText;
    const customSystemPrompt = req.body?.customSystemPrompt;
    const selectedFields = Array.isArray(req.body?.selectedFields)
      ? req.body.selectedFields
      : null;

    let inputText = "";
    if (typeof rawText === "string" && rawText.trim()) {
      inputText = rawText.trim();
    } else {
      // Контекст — выбранный узел и граф в сжатом виде (см. buildCardContext):
      // весь граф как есть не помещался в окно контекста моделей.
      inputText = buildCardContext(nodeObj, chainObj);
    }

    if (!inputText) {
      return res.status(400).json({
        success: false,
        error: "Provide rawText or (node + chain) for context",
      });
    }

    const keys = cardKeys(nodeType, selectedFields);
    // Формат ответа дописываем к любому промпту, и к правленому в интерфейсе
    // тоже: сам промпт описывает поля в виде «Поле: …», и без этой приписки
    // модели, не держащие схему, отвечали текстом.
    const systemPrompt = `${
      customSystemPrompt
        ? String(customSystemPrompt)
        : buildFillCardSystemPrompt({ nodeType, productName })
    }\n\n${formatInstruction(nodeType, keys)}`;
    const userPrompt = buildFillCardUserPrompt({ nodeType, inputText });
    const useWebSearch = !!req.body?.useWebSearch;

    const openaiResp = await callOpenAIFillCard({
      provider,
      model,
      systemPrompt,
      userPrompt,
      nodeType,
      selectedFields,
      useWebSearch,
    });

    // Модель называем в тексте ошибки: без неё в UI не видно, какая именно не
    // справилась, а провайдеров и моделей теперь несколько.
    const usedModel = model || openaiResp?.ai?.model || null;

    const text = extractOutputText(openaiResp);
    const card = cardFromAnswer(safeJsonParse(text), text, nodeType, keys);

    // Оборванный ответ не бракуем, если поля из него прочитались.
    if (!card || typeof card !== "object") {
      // Пустой ответ, обрыв и ответ не по схеме — разные причины и разные
      // лечения: первое обычно значит, что бюджет ушёл в размышления, второе —
      // мало места на ответ, третье — модель не поняла, что от неё ждут.
      const cut = openaiResp?.status === "incomplete";
      return res.status(502).json({
        success: false,
        error:
          text && !cut
            ? `Модель «${usedModel ?? "по умолчанию"}» вернула ответ не по схеме: полей карточки в нём не нашлось. Повторите или выберите другую модель.`
            : explainBadAnswer(openaiResp, text, usedModel, CARD_ANSWER),
        ai: openaiResp?.ai,
        debug: {
          status: openaiResp?.status,
          output_text_preview: (text || "").slice(0, 1200),
        },
      });
    }

    const productCard = {};

    // Ровно запрошенные поля и в том же порядке: выбранные в интерфейсе или
    // все поля этого типа узла. Лишнее, что дописала модель, не берём.
    for (const key of keys) {
      productCard[key] = asText(card[key]);
    }

    return res.json({
      success: true,
      product: productName || null,
      card_kind: nodeType, // ✅ UI поймёт что это за карточка
      productCard,
      ai: openaiResp?.ai,
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

/* router.post("/gpt/fill-card", async (req, res) => {
  const t0 = Date.now();

  try {
    const productName = String(req.body?.productName || "").trim();
    const rawText = req.body?.rawText;
    const chainObj = req.body?.chain;

    // rawText обязателен (или chain объект)
    let inputText = "";
    if (typeof rawText === "string" && rawText.trim()) {
      inputText = rawText.trim();
    } else if (chainObj && typeof chainObj === "object") {
      inputText = JSON.stringify(chainObj, null, 2);
    }

    if (!inputText) {
      return res.status(400).json({
        success: false,
        error: "rawText (string) or chain (object) is required",
      });
    }

    const systemPrompt = buildFillCardSystemPrompt(productName);
    const userPrompt = buildFillCardUserPrompt(inputText);

    const openaiResp = await callOpenAIFillCard({
      provider,
      model,
      systemPrompt,
      userPrompt,
    });

    if (openaiResp?.status !== "completed") {
      return res.status(502).json({
        success: false,
        error: "OpenAI response status is not completed",
        debug: {
          status: openaiResp?.status,
          incomplete_details: openaiResp?.incomplete_details ?? null,
        },
      });
    }

    const text = extractOutputText(openaiResp);
    const parsed = safeJsonParse(text);
    const card = parsed?.productCard;

    if (!card || typeof card !== "object") {
      return res.status(502).json({
        success: false,
        error: "OpenAI did not return productCard",
        debug: { output_text_preview: (text || "").slice(0, 1200) },
      });
    }

    const productCard = {
      technology_name: String(card.technology_name || "").trim(),
      technology_short_description: String(
        card.technology_short_description || "",
      ).trim(),
      equipment: String(card.equipment || "").trim(),
      conditions: String(card.conditions || "").trim(),
      constraints_or_key_property: String(
        card.constraints_or_key_property || "",
      ).trim(),
      additional_materials_or_catalysts: String(
        card.additional_materials_or_catalysts || "",
      ).trim(),
      energy: String(card.energy || "").trim(),
      enterprise_and_plant: String(card.enterprise_and_plant || "").trim(),
    };

    return res.json({
      success: true,
      product: productName || null,
      productCard, // ✅
      took_ms: Date.now() - t0,
    });
  } catch (err) {
    const msg = err?.response?.data || err?.message || "Unknown error";
    return res.status(500).json({
      success: false,
      error: msg,
      took_ms: Date.now() - t0,
    });
  }
});


 */
