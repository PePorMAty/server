// routes/chat/mentions.js
//
// Какие узлы открытого графа упомянуты в сообщении человека — с учётом
// падежей: «тримеров пропилена» — это узел «Тримеры пропилена», «для
// фенола» — «Фенол».
//
// Зачем. Быстрая модель (qwen3.8-flash, 20.11) часто не вызывает инструменты
// и отвечает по памяти: «окисление кумола… (кучерянский процесс)», «Готового
// расчёта для «Алкилирование фенола олигомерами этилена» нет» при таком узле
// на графе. Сервер находит упомянутые узлы сам и кладёт их соседей в
// справку до ответа (context.js) — так ответ опирается на граф, даже если
// модель никуда не посмотрела.
//
// Основа слова — без окончания: первые len−2 буквы, не короче 4 («фенола» →
// «фено», «олигомерами» → «олигомера»). Узел упомянут, если в сообщении есть
// основы всех его значимых слов (длиной от 4 букв). Грубо, но без словарей и
// без запроса к модели.

const lower = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const words = (s) => lower(s).split(/[^a-zа-я0-9]+/).filter(Boolean);
const stem = (w) => w.slice(0, Math.max(4, w.length - 2));

/** Основы значимых слов названия; [] — назвать нечем (короткое, «А», «6,6»). */
function stemsOf(label) {
  return [...new Set(words(label).filter((w) => w.length >= 4 && /[а-яa-z]/.test(w)).map(stem))];
}

/**
 * Названия узла: само и синоним в скобках — «Изопропилбензол (кумол)»
 * упомянут и словом «кумол».
 */
function variantsOf(label) {
  const s = String(label ?? "");
  const inner = [...s.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]);
  return [s.replace(/\([^()]*\)/g, " "), ...inner].filter((v) => stemsOf(v).length);
}

/** Упомянуто ли название в тексте: есть основы всех значимых слов одного из его вариантов. */
function mentions(text, label) {
  const t = words(text);
  return variantsOf(label).some((v) => stemsOf(v).every((s) => t.some((w) => w.startsWith(s))));
}

/**
 * Узлы среза, упомянутые в сообщении: продукты, преобразования,
 * альтернативы. Сначала длинные названия — они точнее («Алкилирование
 * фенола олигомерами этилена» важнее «Фенола» в том же сообщении).
 */
function mentionedNodes(slice, text, { max = 6 } = {}) {
  const byLength = (a, b) => stemsOf(b.label).length - stemsOf(a.label).length;
  const pick = (list) => list.filter((n) => mentions(text, n.label)).sort(byLength);
  const products = pick(slice.products);
  const transformations = pick(slice.transformations);
  const alternatives = pick(slice.alternatives ?? []);
  return {
    products: products.slice(0, max),
    transformations: transformations.slice(0, Math.ceil(max / 2)),
    alternatives: alternatives.slice(0, Math.ceil(max / 2)),
  };
}

module.exports = { mentions, mentionedNodes, stemsOf };
