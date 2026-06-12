// routes/step/build.js
//
// POST /gpt/step/build — преобразовать Markdown описания одного шага
// (techText = aggregated_markdown от /gpt/step/aggregate) в StepChainApiStep.
//
// После основного вызова делается быстрый второй вызов для оценки
// достаточности источников для новых продуктов шага.

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

// ---------- json_schema для проверки достаточности источников ----------
function buildSufficiencySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["insufficient"],
    properties: {
      insufficient: {
        type: "array",
        items: { type: "string" },
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

КРИТИЧЕСКИ ВАЖНОЕ ПРАВИЛО ИМЕНОВАНИЯ:
- Перед тем как назвать продукт, ОБЯЗАТЕЛЬНО проверь список existingProducts.
- Если продукт семантически совпадает с одним из existingProducts (тот же материал/вещество, возможно с уточнением в скобках или чуть иной формулировкой), ИСПОЛЬЗУЙ ТОЧНО ТО ИМЯ, которое указано в existingProducts. Не придумывай вариации.
- Примеры совпадений: «Природный газ» = «Природный газ (метан)» = «Природный газ (метановая фракция)» — используй то, что в existingProducts.
- Если точного или семантического совпадения нет — дай короткое рыночно-понятное название.
`;

function buildStepBuildUserPrompt({ productName, techText, existingProducts }) {
  const existingList =
    existingProducts.length > 0 ? existingProducts.join(", ") : "(нет)";

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

ОБЯЗАТЕЛЬНО: для каждого продукта проверь список «Существующие продукты в графе». Если продукт по смыслу совпадает с любым из них (даже если формулировка чуть отличается, или в скобках указано уточнение, или регистр другой), используй ТОЧНО ТО ИМЯ из списка. Не создавай новое имя, если существующее подходит.

Верни СТРОГО JSON по прикреплённому json_schema. Никакого свободного текста вне JSON.`;
}

const SUFFICIENCY_CHECK_SYSTEM = `Ты — строгий аналитик достаточности источников для ПОШАГОВОГО построения производственной цепочки.

Только что построен один шаг. Для КАЖДОГО нового продукта этого шага надо решить: можно ли из ИМЕЮЩИХСЯ источников построить СЛЕДУЮЩИЙ шаг цепочки именно для него — или для него нужен отдельный (новый) поиск источников.

Тебе дают: направление построения, список новых продуктов и тексты источников (technology_description).

«Источников ДОСТАТОЧНО» для продукта P — только если СТРОГО (хотя бы один источник):
- направление DOWN: есть конкретное описание следующего передела, где P является СЫРЬЁМ/входом и из него получают ДРУГОЙ продукт (есть процесс/стадии) — т.е. «X производят из P»;
- направление UP: есть конкретное описание, ИЗ ЧЕГО производят P (feedstock + процесс), позволяющее раскрыть P дальше вверх.

НЕдостаточно (продукт в "insufficient"), если источники:
- лишь упоминают P, его свойства или применение;
- описывают только ТЕКУЩИЙ шаг (которым P только что получен), но не его следующий передел;
- описывают другой продукт (например, родителя P), а не сам P.

Если по продукту нет такого forward-описания — он НЕдостаточен. Если сомневаешься — считай НЕдостаточным (лучше добрать источники, чем замкнуть цепочку в цикл).

Верни СТРОГО JSON по схеме: { "insufficient": ["продукт", ...] }. Если для ВСЕХ продуктов есть forward-описание — { "insufficient": [] }.`;

function buildSufficiencyPrompt({ newProducts, sourcesDescriptions, direction }) {
  const dirText =
    direction === "up"
      ? "UP — для каждого продукта нужно описание, ИЗ ЧЕГО его производят (следующий шаг вверх)."
      : "DOWN — для каждого продукта нужно описание, что производят ИЗ него (следующий шаг вниз).";
  return `Направление построения: ${dirText}

Новые продукты для проверки:
${newProducts.map((p) => `- ${p}`).join("\n")}

Имеющиеся источники (technology_description):
${sourcesDescriptions.map((d, i) => `--- Источник ${i + 1} ---\n${d}`).join("\n\n")}

Для КАЖДОГО продукта реши строго: есть ли в источниках КОНКРЕТНОЕ описание его следующего передела в указанном направлении (а не просто упоминание или описание текущего шага)? Если нет — продукт в "insufficient". Сомнения — тоже в "insufficient".

Верни СТРОГО JSON по прикреплённому json_schema.`;
}

router.post("/gpt/step/build", async (req, res) => {
  const t0 = Date.now();

  // ---------- валидация ----------
  const productName = String(req.body?.productName || "").trim();
  const direction = req.body?.direction === "up" ? "up" : "down";
  const techText = String(req.body?.techText || "").trim();
  const existingProducts = Array.isArray(req.body?.existingProducts)
    ? req.body.existingProducts
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    : [];
  const existingSources = Array.isArray(req.body?.existingSources)
    ? req.body.existingSources
    : [];
  const customSystemPrompt = req.body?.customSystemPrompt
    ? String(req.body.customSystemPrompt).trim()
    : null;
  const provider = req.body?.provider
    ? String(req.body.provider).trim()
    : undefined;
  const model = req.body?.model ? String(req.body.model).trim() : undefined;

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

  const stream = startAntiIdle(res, req, { heartbeatMs: 15000 });
  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;
    return res.end(
      JSON.stringify({ ...obj, http_status: status, took_ms: Date.now() - t0 }),
    );
  };

  try {
    const instructions = customSystemPrompt || STEP_BUILD_SYSTEM;
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

    const normalize = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/ё/g, "е")
        .trim()
        .replace(/\s+/g, " ");

    const baseName = (s) =>
      normalize(s)
        .replace(/\s*\([^)]*\)\s*/g, "")
        .trim();

    const findExistingMatch = (name) => {
      const norm = normalize(name);
      const base = baseName(name);
      for (const ep of existingProducts) {
        if (normalize(ep) === norm) return ep;
      }
      for (const ep of existingProducts) {
        if (baseName(ep) === base && base.length >= 3) return ep;
      }
      return null;
    };

    const markProduct = (p) => {
      const rawName = String(p?.name || "").trim();
      const match = findExistingMatch(rawName);
      const name = match || rawName;
      return {
        name,
        description: String(p?.description || "").trim() || undefined,
        isExisting: !!match,
        existingNodeLabel: match || undefined,
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

    // ---------- проверка достаточности источников ----------
    const newProducts = [...step.inputProducts, ...step.outputProducts]
      .filter((p) => !p.isExisting)
      .map((p) => p.name);

    const sourcesDescriptions = existingSources
      .map((s) => String(s?.technology_description || "").trim())
      .filter(Boolean);

    let sourcesStatus = "sufficient";
    let insufficientProducts = [];

    if (newProducts.length === 0) {
      // Шаг не дал ни одного НОВОГО продукта — только воспроизвёл уже
      // существующие в графе (цикл/тупик). Источники не ведут к новому шагу:
      // надёжно сигналим, что для раскрываемого продукта нужен свежий поиск.
      sourcesStatus = "insufficient";
      insufficientProducts = [productName];
    } else if (newProducts.length > 0 && sourcesDescriptions.length > 0) {
      try {
        const suffResp = await callOpenAIResponsesRaw({
          provider,
          model,
          payload: {
            instructions: SUFFICIENCY_CHECK_SYSTEM,
            input: buildSufficiencyPrompt({
              newProducts,
              sourcesDescriptions,
              direction,
            }),
            truncation: "auto",
            max_output_tokens: 500,
            text: {
              format: {
                type: "json_schema",
                name: "sufficiency_check",
                strict: true,
                schema: buildSufficiencySchema(),
              },
            },
          },
          timeoutMs: 2 * 60 * 1000,
        });

        if (suffResp?.status === "completed") {
          const suffText = extractOutputText(suffResp);
          const suffParsed = safeJsonParse(suffText);
          if (
            suffParsed &&
            Array.isArray(suffParsed.insufficient) &&
            suffParsed.insufficient.length > 0
          ) {
            sourcesStatus = "insufficient";
            insufficientProducts = suffParsed.insufficient;
          }
        }
      } catch (suffErr) {
        console.error("Sufficiency check failed:", suffErr?.message);
      }
    } else if (newProducts.length > 0 && sourcesDescriptions.length === 0) {
      sourcesStatus = "insufficient";
      insufficientProducts = newProducts;
    }

    return reply(200, {
      success: true,
      product: productName,
      direction,
      step,
      sourcesStatus,
      insufficientProducts,
    });
  } catch (err) {
    return reply(500, {
      success: false,
      error: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

module.exports = router;
