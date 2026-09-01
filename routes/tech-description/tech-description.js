// routes/tech-description/tech-description.js
//
// POST /gpt/tech-description — краткое технологическое описание ОДНОГО
// продуктового шага: добавление дополнительного продукта к существующему
// в направлении ВНИЗ (существующий продукт — сырьё) или ВВЕРХ (дополнительный
// продукт — сырьё).
//
// Ответ — готовый текст из 2–4 предложений (не JSON-структура): он кладётся в
// карточку преобразования на клиенте (вкладка «Технологическое описание»).

const express = require("express");
const router = express.Router();

const {
  TECH_DESCRIPTION_PROMPT_TEMPLATE,
  fillTechDescriptionPrompt,
  splitTechDescriptionPrompt,
  callOpenAIResponsesRaw,
  extractOutputText,
} = require("./utils");

// ---------- heartbeat ----------
// Запрос к модели идёт десятками секунд (а на reasoning-моделях — минутами):
// держим соединение живым пробелами, как в /gpt/step/*.
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

// Модель иногда оформляет ответ как цитату/код-блок или добавляет заголовок,
// хотя промпт просит только текст. Снимаем обёртку, не трогая сам текст.
function cleanDescription(raw) {
  let text = String(raw || "").trim();
  const fenced = text.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^#{1,6}\s.*\n+/, "").trim();
  return text;
}

// POST /api/graphs/gpt/tech-description
// body: {
//   direction: "down" | "up",
//   currentProduct: string,        // существующий продукт цепочки
//   additionalProduct: string,     // добавляемый продукт
//   existingChain?: string|object, // текст/JSON существующей цепочки
//   processDescription?: string,   // текстовые сведения о технологии
//   customPrompt?: string,         // отредактированный шаблон (с плейсхолдерами)
//   provider?: string, model?: string
// }
router.post("/gpt/tech-description", async (req, res) => {
  const t0 = Date.now();

  // ---------- валидация ДО стрима ----------
  const direction = req.body?.direction === "up" ? "up" : "down";
  const currentProduct = String(req.body?.currentProduct || "").trim();
  const additionalProduct = String(req.body?.additionalProduct || "").trim();
  const existingChain = req.body?.existingChain ?? "";
  const processDescription = String(req.body?.processDescription || "").trim();
  const customPrompt = req.body?.customPrompt
    ? String(req.body.customPrompt).trim()
    : null;
  const provider = req.body?.provider
    ? String(req.body.provider).trim()
    : undefined;
  const model = req.body?.model ? String(req.body.model).trim() : undefined;

  if (!currentProduct) {
    return res
      .status(400)
      .json({ success: false, error: "currentProduct is required" });
  }
  if (!additionalProduct) {
    return res
      .status(400)
      .json({ success: false, error: "additionalProduct is required" });
  }

  const stream = startAntiIdle(res, req, { heartbeatMs: 15000 });
  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;
    return res.end(
      JSON.stringify({ ...obj, http_status: status, took_ms: Date.now() - t0 }),
    );
  };

  try {
    const filled = fillTechDescriptionPrompt(
      customPrompt || TECH_DESCRIPTION_PROMPT_TEMPLATE,
      {
        direction,
        currentProduct,
        additionalProduct,
        existingChain,
        processDescription,
      },
    );

    const { system, user } = splitTechDescriptionPrompt(filled);

    const payload = {
      model: "gpt-5-mini",
      ...(system ? { instructions: system } : {}),
      input: user,
      truncation: "auto",
      // Ответ короткий (2–4 предложения), но у reasoning-моделей лимит делится
      // между рассуждением и текстом — иначе ответ приходит пустым.
      reasoning: { effort: "low" },
      max_output_tokens: 4000,
    };

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
      });
    }

    const techDescription = cleanDescription(extractOutputText(resp));

    if (!techDescription) {
      return reply(502, {
        success: false,
        error: "OpenAI returned empty output",
      });
    }

    return reply(200, {
      success: true,
      direction,
      currentProduct,
      additionalProduct,
      techDescription,
    });
  } catch (err) {
    return reply(500, {
      success: false,
      error: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

module.exports = router;
