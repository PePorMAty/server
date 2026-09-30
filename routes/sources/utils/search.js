// routes/sources/utils/search.js
//
// Поиск источников с одним повтором.
//
// Модели ищут в сети не каждый раз. В прогонах 30.09 одна и та же модель то
// находила пять источников, то за три секунды отвечала «Нет подходящего
// источника» или отдавала источники без ссылок — поиска в такой раз просто не
// было. Отказ случайный: следующий запрос той же модели обычно находит всё.
// Поэтому ответ без единого годного источника повторяем один раз и только
// потом говорим «ничего не нашлось».

const {
  callOpenAIResponses,
  extractOutputText,
  safeJsonParse,
  pickItems,
  normalizeAndFilterItems,
} = require("./openai");

/**
 * @param opts           параметры callOpenAIResponses
 * @param opts.filter    пост-фильтр источников (разрешённые домены)
 * @param opts.isAborted клиент ушёл — повторять незачем
 * @returns { resp, text, parsed, rawItems, items, attempts }
 *          rawItems — что вернула модель (null, если списка нет вовсе),
 *          items — годные источники после отбора
 */
async function searchSources({
  filter = (xs) => xs,
  isAborted = () => false,
  ...opts
}) {
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await callOpenAIResponses(opts);
    const text = extractOutputText(resp);
    const parsed = safeJsonParse(text);
    const rawItems = pickItems(parsed);
    const items = rawItems ? filter(normalizeAndFilterItems(rawItems)) : [];
    result = { resp, text, parsed, rawItems, items, attempts: attempt };

    // Годные есть — готово. Ответ оборвался на пределе длины — повтор упрётся
    // в тот же предел, это не случайность.
    if (items.length > 0 || isAborted() || resp?.status === "incomplete") break;
    if (attempt === 1) {
      console.warn(
        `[sources] model=${opts.model || "по умолчанию"}: ни одного годного источника — повторяю поиск`,
      );
    }
  }

  if (result.attempts > 1 && result.resp?.ai) {
    result.resp.ai.fixes = [
      ...(result.resp.ai.fixes || []),
      "первый поиск не дал источников — повторён",
    ];
  }
  return result;
}

module.exports = { searchSources };
