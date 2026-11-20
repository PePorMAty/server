// routes/step/check.js
//
// POST /gpt/step/check — проверка шага моделью (utils/stepCheck.js): реально
// ли из этого сырья этим преобразованием получают эти продукты. Один запрос
// без поиска. Клиент зовёт её на превью построенного шага и из отказа расчёта
// материального баланса — тогда с его примечаниями в remark.
//
// Тело: { transformation: { name, description? }, inputs, outputs,
//   byproducts?: [{ name, description? } | string], direction?: up | down,
//   anchor? — продукт, от которого строили шаг, fixed? — названия, которые
//   менять нельзя (стоят на графе в других шагах), remark? — замечание,
//   provider?, model? }.
// Ответ: { success, verdict: ok | fix | wrong, summary, renames: [{ from, to,
//   description? }], transformation: { name, description? } | null, ai }.

const express = require("express");
const router = express.Router();

const { callOpenAIResponsesRaw, extractOutputText, safeJsonParse } = require("../sources/utils");
const { SCHEMA, STEP_CHECK_SYSTEM, readCheckBody, stepCheckInput, parseStepCheck } = require("./utils/stepCheck");
const { startAntiIdle } = require("./utils/antiIdle");

/**
 * Один запрос к модели: шаг c (readCheckBody) → { result, ai }; result —
 * parseStepCheck или null, если модель ответила не по схеме. Общая для
 * маршрута и чата (routes/chat/tools.js, check_steps).
 */
async function checkStep(c, { provider, model, signal } = {}) {
  const resp = await callOpenAIResponsesRaw({
    payload: {
      model: "gpt-5-mini",
      instructions: STEP_CHECK_SYSTEM,
      input: stepCheckInput(c),
      truncation: "auto",
      // Задача короткая; лимит с запасом — у моделей с размышлениями он
      // делится с ними (как у проверки достаточности в build.js).
      reasoning: { effort: "low" },
      max_output_tokens: 4000,
      text: { format: { type: "json_schema", name: "step_check", schema: SCHEMA, strict: true } },
    },
    timeoutMs: 3 * 60 * 1000,
    provider,
    model,
    ...(signal ? { signal } : {}),
  });
  return { result: parseStepCheck(safeJsonParse(extractOutputText(resp)), c), ai: resp?.ai };
}

router.post("/gpt/step/check", async (req, res) => {
  const t0 = Date.now();
  const c = readCheckBody(req.body);
  if (c.error) return res.status(400).json({ success: false, error: c.error });
  const provider = req.body?.provider ? String(req.body.provider).trim() : undefined;
  const model = req.body?.model ? String(req.body.model).trim() : undefined;

  const stream = startAntiIdle(res, req);
  const reply = (status, obj) => {
    stream.stop();
    if (stream.aborted) return;
    res.end(JSON.stringify({ ...obj, http_status: status, took_ms: Date.now() - t0 }));
  };

  try {
    const { result, ai } = await checkStep(c, { provider, model });
    if (!result) {
      return reply(502, {
        success: false,
        error: `Модель «${model || ai?.model || "по умолчанию"}» ответила не по схеме — шаг не проверен.`,
        ai,
      });
    }
    console.log(
      `[step/check] «${c.transformation.name}»: ${result.verdict}${result.renames.length ? `; ${result.renames.map((r) => `${r.from} → ${r.to}`).join(", ")}` : ""}${c.remark ? " (с замечанием)" : ""}`,
    );
    return reply(200, { success: true, ...result, ai });
  } catch (err) {
    return reply(500, { success: false, error: err?.message || "Unknown error" });
  }
});

module.exports = router;
module.exports.checkStep = checkStep;
