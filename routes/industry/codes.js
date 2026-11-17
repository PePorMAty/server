// routes/industry/codes.js
//
// Коды ОКПД2 и ТН ВЭД продукта — моделью по файлам классификаторов
// (utils/determineCode.js) — и сохранение найденного (utils/modelCodes.js).
//
// POST /graphs/gpt/product-codes — один продукт за запрос: клиент идёт по
//   выбранным продуктам сам и показывает ход по каждому. Путь под
//   /graphs/gpt — как у остальных вызовов модели.
//   Тело: { name, description?, kinds?: ["okpd2", "tnved"], usedFor?: [] —
//     во что продукт идёт по графу, madeFrom?: [] — из чего его делают,
//     context?: {} — контекст из графа (описание, процессы, путь до изделия;
//     routes/shared/productContext.js),
//     current?: { okpd2?, tnved? } — коды, что уже стоят в карточке,
//     prompts?: { okpd2?, tnved? } — свой текст промпта, provider?, model? }.
//   Ответ: { success, name, okpd2?, tnved? — { status: found | none, code,
//     name, subgroup, subgroupName, display?, path?, reason?, missing? },
//     saved: { okpd2?, tnved? } — что записано, shared — записано ли по
//     названию (у общих названий «Двигатель» — нет: код зависит от изделия),
//     cleared: [] — виды, у которых прежний код стёрт («не определён» при
//     повторе), requests — запросов к модели }.
// GET /industry/codes/prompts — промпты по умолчанию для окна «Определить
//   коды» (чтение, поэтому не под /graphs/gpt).

const express = require("express");
const router = express.Router();

const { callOpenAIResponsesRaw, extractOutputText } = require("../sources/utils");
const { determineCode } = require("./utils/determineCode");
const { DEFAULT_PROMPTS } = require("./utils/codePrompts");
const { storeCodes, clearCodes } = require("./utils/modelCodes");
const { isUnqualifiedGeneric } = require("../shared/genericParts");
const { readProductContext, neighboursOf } = require("../shared/productContext");

/** Список названий из тела: строки, без пустых, не длиннее 120 знаков, до 6. */
const names = (raw) =>
  (Array.isArray(raw) ? raw : [])
    .map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 6);
const { startAntiIdle } = require("../step/utils/antiIdle");

const KINDS = ["okpd2", "tnved"];

/** Соседи по контексту, без самого продукта. */
function neighboursExcept(context, name) {
  const { usedFor, madeFrom } = neighboursOf(context);
  const own = name.trim().toLowerCase();
  const other = (list) => list.filter((x) => x.trim().toLowerCase() !== own);
  return { usedFor: other(usedFor), madeFrom: other(madeFrom) };
}

router.get("/industry/codes/prompts", (req, res) => {
  res.json({ success: true, prompts: DEFAULT_PROMPTS });
});

router.post("/graphs/gpt/product-codes", async (req, res) => {
  const t0 = Date.now();
  const name = String(req.body?.name ?? "").trim().slice(0, 300);
  if (!name) return res.status(400).json({ success: false, error: "name is required" });
  const kinds = (Array.isArray(req.body?.kinds) ? req.body.kinds : KINDS).filter((k) => KINDS.includes(k));
  if (!kinds.length) return res.status(400).json({ success: false, error: "kinds: okpd2 and/or tnved" });
  const description = String(req.body?.description ?? "").trim();
  const provider = req.body?.provider ? String(req.body.provider).trim() : undefined;
  const model = req.body?.model ? String(req.body.model).trim() : undefined;
  const prompts = req.body?.prompts ?? {};
  // Контекст из графа (новый клиент); соседей из него берёт и поиск по
  // классификатору, если клиент не прислал usedFor/madeFrom отдельно.
  const context = readProductContext(req.body?.context);
  const near = neighboursExcept(context, name);
  const usedFor = names(req.body?.usedFor).length ? names(req.body?.usedFor) : near.usedFor;
  const madeFrom = names(req.body?.madeFrom).length ? names(req.body?.madeFrom) : near.madeFrom;

  const stream = startAntiIdle(res, req);
  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;
    res.end(JSON.stringify({ ...obj, http_status: status, took_ms: Date.now() - t0 }));
  };

  let usedModel = model ?? null;
  const ask = async (messages) => {
    const resp = await callOpenAIResponsesRaw({
      payload: {
        model: "gpt-5-mini",
        input: messages,
        truncation: "auto",
        // Ответ — один код; лимит с запасом для моделей с размышлениями.
        reasoning: { effort: "low" },
        max_output_tokens: 2000,
      },
      timeoutMs: 3 * 60 * 1000,
      provider,
      model,
    });
    usedModel = resp?.ai?.model ?? usedModel;
    return extractOutputText(resp);
  };

  try {
    const results = await Promise.all(
      kinds.map((kind) =>
        determineCode(
          kind,
          {
            name,
            description,
            usedFor,
            madeFrom,
            ...(context ? { context } : {}),
            current: req.body?.current?.[kind] ? String(req.body.current[kind]) : undefined,
            prompt: typeof prompts[kind] === "string" && prompts[kind].trim() ? prompts[kind] : undefined,
          },
          ask,
        ),
      ),
    );
    if (stream.aborted) return;
    const at = new Date().toISOString();
    const out = {};
    const saved = {};
    kinds.forEach((kind, i) => {
      const { steps, requests, ...r } = results[i];
      out[kind] = r;
      if (r.status === "found") {
        const { status, reason, ...code } = r;
        saved[kind] = { ...code, model: usedModel, at, ...(prompts[kind] ? { customPrompt: true } : {}) };
      }
      console.log(
        `[product-codes] «${name}» ${kind}: ${r.status === "found" ? r.code : `не определён (${r.reason})`}; запросов ${requests}; ${steps.map((s) => s.stage + (s.problem ? `!(${s.problem})` : "")).join(" → ")}`,
      );
    });
    // Общее название («Двигатель») по имени не храним: код зависит от
    // изделия, и он ушёл бы на двигатели других графов. Клиент держит его на
    // самом узле. Повторное определение без кода стирает прежний: его
    // переспросили — значит, он под сомнением.
    const shared = !isUnqualifiedGeneric(name);
    const cleared = shared ? kinds.filter((k) => out[k].status !== "found") : [];
    if (shared && Object.keys(saved).length) storeCodes(name, saved);
    if (cleared.length) clearCodes(name, cleared);
    return reply(200, {
      success: true,
      name,
      ...out,
      saved,
      shared,
      cleared,
      requests: results.reduce((n, r) => n + r.requests, 0),
      ai: { model: usedModel },
    });
  } catch (err) {
    return reply(500, { success: false, error: err?.message || "Unknown error" });
  }
});

module.exports = router;
