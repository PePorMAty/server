// routes/step/build.js
//
// POST /gpt/step/build — преобразовать Markdown описания одного шага
// (techText = aggregated_markdown от /gpt/step/aggregate) в StepChainApiStep.
//
// Реализация самодостаточная: вызываем OpenAI со строгим json_schema,
// напрямую описывающим StepChainApiStep. Зависимостей от routes/chain/* НЕТ.
//
// Совместимость: существующий /gpt/chain и /gpt/chain/step НЕ трогаем.

const express = require("express");
const router = express.Router();

const {
  callOpenAIResponsesRaw,
  extractOutputText,
  safeJsonParse,
} = require("../sources/utils");

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

// ---------- json_schema для StepChainApiStep ----------
function buildStepSchema() {
  const productSchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "description"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
    },
  };

  return {
    type: "object",
    additionalProperties: false,
    required: ["transformation", "inputProducts", "outputProducts"],
    properties: {
      transformation: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
      },
      inputProducts: {
        type: "array",
        minItems: 1,
        items: productSchema,
      },
      outputProducts: {
        type: "array",
        minItems: 1,
        items: productSchema,
      },
    },
  };
}

const STEP_BUILD_SYSTEM = `Ты — парсер производственных шагов. На вход тебе дают Markdown-описание ОДНОГО производственного шага (раскрываемый продукт, что из чего производят, краткая формула, описание шага) и список уже существующих продуктов в графе.

Твоя задача — вернуть СТРОГО JSON по прикреплённому json_schema, который описывает один шаг цепочки в формате:
{
  transformation: { name, description },
  inputProducts: [{ name, description }, ...],
  outputProducts: [{ name, description }, ...],
}

Правила размещения input/output (безусловные):
- outputProducts — это то, ЧТО производят на этом шаге. Всегда берётся из секции «Что производят» Markdown (это раскрываемый целевой продукт).
- inputProducts — это то, ИЗ ЧЕГО производят (feedstock/сырьё). Всегда берётся из секции «Из чего производят» Markdown.
- Агрегат всегда возвращает шаг в формате «целевой продукт ← сырьё», поэтому направление построения цепочки на размещение input/output не влияет.

Остальные правила:
- transformation.name — короткое название технологического перехода (например: «Синтез аммиака», «Паровая конверсия метана», «Крекинг»). Бери его из Markdown: из «Краткой формулы шага» или «Описания», нормализуй до короткого имени.
- transformation.description — 1–3 предложения о процессе; можно взять сжатое «Описание».
- Имена продуктов — короткие, рыночно-понятные, на русском (латиница только для химических формул).
- description каждого продукта — 1 короткое предложение (если в Markdown нет прямого описания, напиши максимально общее нейтральное).
- Не добавляй полей, которых нет в схеме.
- Не используй внешние знания — только данные из Markdown и списка existingProducts.
- Если в Markdown вместо шага написано только "needs-sources" — всё равно верни ОСМЫСЛЕННЫЙ JSON по схеме, используя только целевой продукт (в этом случае другое поле оставь максимально бедным, но непустым).
- outputProducts и inputProducts не должны быть пустыми массивами.
`;

function buildStepBuildUserPrompt({
  productName,
  techText,
  existingProducts,
}) {
  const existingList =
    existingProducts.length > 0
      ? existingProducts.join(", ")
      : "(нет)";

  return `Целевой (раскрываемый) продукт: ${productName}
Существующие продукты в графе: ${existingList}

Markdown одного шага:
---
${techText}
---

Напоминание о размещении:
- outputProducts = «Что производят» (целевой продукт).
- inputProducts  = «Из чего производят» (сырьё).
Оба массива должны быть непустыми.

Верни СТРОГО JSON по прикреплённому json_schema. Никакого свободного текста вне JSON.`;
}

router.post("/gpt/step/build", async (req, res) => {
  const t0 = Date.now();

  // ---------- валидация ----------
  const productName = String(req.body?.productName || "").trim();
  const direction = req.body?.direction === "up" ? "up" : "down";
  const techText = String(req.body?.techText || "").trim();
  const existingProducts = Array.isArray(req.body?.existingProducts)
    ? req.body.existingProducts.map((s) => String(s || "").trim()).filter(Boolean)
    : [];

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

  const stream = startAntiIdle(res, req, { heartbeatMs: 15000 });
  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;
    return res.end(
      JSON.stringify({ ...obj, http_status: status, took_ms: Date.now() - t0 }),
    );
  };

  try {
    const instructions = STEP_BUILD_SYSTEM;
    const input = buildStepBuildUserPrompt({
      productName,
      techText,
      existingProducts,
    });

    const payload = {
      model: "gpt-5-mini",
      instructions,
      input,
      truncation: "auto",
      max_output_tokens: 4000,
      text: {
        format: {
          type: "json_schema",
          name: "step_chain_step",
          strict: true,
          schema: buildStepSchema(),
        },
      },
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

    const text = extractOutputText(resp);
    const parsed = safeJsonParse(text);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.transformation ||
      !Array.isArray(parsed.inputProducts) ||
      !Array.isArray(parsed.outputProducts)
    ) {
      return reply(502, {
        success: false,
        error: "OpenAI did not return valid StepChainApiStep JSON",
        debug: { output_text_preview: (text || "").slice(0, 1200) },
      });
    }

    // ---------- финальная сборка StepChainApiStep ----------
    const now = Date.now();
    const slug = (s, fallback) =>
      String(s || fallback || "")
        .toLowerCase()
        .replace(/[^a-zа-я0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || fallback;

    const trName = String(parsed.transformation.name || "").trim();
    const trDesc = String(parsed.transformation.description || "").trim();

    const markProduct = (p) => {
      const name = String(p?.name || "").trim();
      const isExisting = existingProducts.includes(name);
      return {
        name,
        description: String(p?.description || "").trim() || undefined,
        isExisting,
        existingNodeLabel: isExisting ? name : undefined,
      };
    };

    const step = {
      transformation: {
        id: `tr-${slug(trName, "step")}-${now}`,
        name: trName,
        description: trDesc || undefined,
      },
      inputProducts: parsed.inputProducts
        .map(markProduct)
        .filter((p) => p.name),
      outputProducts: parsed.outputProducts
        .map(markProduct)
        .filter((p) => p.name),
    };

    if (step.inputProducts.length === 0 || step.outputProducts.length === 0) {
      return reply(422, {
        success: false,
        error: "parsed step has empty inputProducts or outputProducts",
        debug: { step },
      });
    }

    return reply(200, {
      success: true,
      product: productName,
      direction,
      step,
      sourcesStatus: "sufficient",
    });
  } catch (err) {
    return reply(500, {
      success: false,
      error: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

module.exports = router;