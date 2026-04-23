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

router.post("/gpt/fill-card", async (req, res) => {
  const t0 = Date.now();

  try {
    const nodeType = String(req.body?.nodeType || "product").trim(); // ✅
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
      // ✅ собираем контекст из node + chain
      const nodeText =
        nodeObj && typeof nodeObj === "object"
          ? JSON.stringify(nodeObj, null, 2)
          : "";
      const chainText =
        chainObj && typeof chainObj === "object"
          ? JSON.stringify(chainObj, null, 2)
          : "";

      inputText = [
        nodeText && `SELECTED_NODE:\n${nodeText}`,
        chainText && `FULL_CHAIN:\n${chainText}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    if (!inputText) {
      return res.status(400).json({
        success: false,
        error: "Provide rawText or (node + chain) for context",
      });
    }

    if (!process.env.GPT_API_KEY) {
      return res
        .status(500)
        .json({ success: false, error: "GPT_API_KEY is not set in env" });
    }

    const systemPrompt = customSystemPrompt
      ? String(customSystemPrompt)
      : buildFillCardSystemPrompt({ nodeType, productName });
    const userPrompt = buildFillCardUserPrompt({ nodeType, inputText });
    const useWebSearch = !!req.body?.useWebSearch;

    const openaiResp = await callOpenAIFillCard({
      apiKey: process.env.GPT_API_KEY,
      systemPrompt,
      userPrompt,
      nodeType,
      selectedFields,
      useWebSearch,
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

    // нормализация по типу
    let productCard;

    if (Array.isArray(selectedFields) && selectedFields.length > 0) {
      // кастомный набор полей — берём только запрошенные
      productCard = {};
      for (const key of selectedFields) {
        productCard[key] = String(card[key] || "").trim();
      }
    } else if (nodeType === "transformation") {
      productCard = {
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
    } else {
      productCard = {
        product_name: String(card.product_name || "").trim(),
        product_type: String(card.product_type || "").trim(),
        purity: String(card.purity || "").trim(),
        main_impurities: String(card.main_impurities || "").trim(),
        allowed_impurities: String(card.allowed_impurities || "").trim(),
        conversion_yield: String(card.conversion_yield || "").trim(),
        typical_scale: String(card.typical_scale || "").trim(),
        storage: String(card.storage || "").trim(),
        carbon_footprint: String(card.carbon_footprint || "").trim(),
        producers: String(card.producers || "").trim(),
        applications: String(card.applications || "").trim(),
        price: String(card.price || "").trim(),
      };
    }

    return res.json({
      success: true,
      product: productName || null,
      card_kind: nodeType, // ✅ UI поймёт что это за карточка
      productCard,
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

    if (!process.env.GPT_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "GPT_API_KEY is not set in env",
      });
    }

    const systemPrompt = buildFillCardSystemPrompt(productName);
    const userPrompt = buildFillCardUserPrompt(inputText);

    const openaiResp = await callOpenAIFillCard({
      apiKey: process.env.GPT_API_KEY,
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
