// routes/step/utils/endUse.js
//
// «Что делают из продукта» — проверка, когда шаг «вниз» не нашёл
// продолжения.
//
// Тупик в построении значит только «в базе и в найденном моделью нет
// переработки», а не «из продукта ничего не делают». Алкилфенолэфирсульфат
// (живой прогон 2026-10-29) — готовое ПАВ: его смешивают в моющие средства,
// но химически дальше не перерабатывают; а у другого продукта переработка
// может просто не попасться поиску. Поэтому отдельный короткий запрос с
// веб-поиском разделяет: химическое превращение в другое вещество (шаг
// графа), применение как есть (рецептуры, смеси, конечный товар) — и
// честное «ничего не нашлось». Найденные ссылки проверяет сервер
// (verifySources.js), как источники шага.

const CONVERSION = {
  type: "object",
  additionalProperties: false,
  required: ["product", "process", "co_reactants", "title", "url", "quote"],
  properties: {
    product: { type: "string" },
    process: { type: "string" },
    co_reactants: { type: "array", items: { type: "string" } },
    title: { type: "string" },
    url: { type: "string" },
    quote: { type: "string" },
  },
};
const USE = {
  type: "object",
  additionalProperties: false,
  required: ["use", "how", "title", "url", "quote"],
  properties: {
    use: { type: "string" },
    how: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    quote: { type: "string" },
  },
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["chemical_conversions", "uses_as_is", "summary"],
  properties: {
    chemical_conversions: { type: "array", items: CONVERSION },
    uses_as_is: { type: "array", items: USE },
    summary: { type: "string" },
  },
};

function endUsePrompt(productName) {
  return `Определи по открытым источникам (выполни веб-поиск), что в промышленности делают из продукта «${productName}». Раздели найденное на две группы.

1) chemical_conversions — «${productName}» служит сырьём ХИМИЧЕСКОГО ПРЕВРАЩЕНИЯ в другое вещество: реакция (сульфатирование, нейтрализация до соли, этерификация, полимеризация, гидрирование и т. п.), после которой получается новый продукт. Для каждого: product — что получают (по-русски, именительный падеж), process — как (одной фразой), co_reactants — второе сырьё и реагенты, переходящие в продукт, title и url — источник, quote — дословная короткая цитата из него.
2) uses_as_is — «${productName}» используют как есть, без химического превращения: компонент рецептур и смесей (моющие средства, эмульсии, присадки к маслам), растворитель, вспомогательное вещество, конечный товар. Для каждого: use — где, how — как (смешение, добавка, готовый товар), title, url, quote.

summary — 1–3 предложения по-русски: есть ли у продукта химическая переработка или это конечный продукт, и почему ты так решил.

Правила:
- Только то, что подтверждает найденный источник: url — настоящий адрес страницы, которую ты нашёл поиском, quote — из неё. Не придумывай источники, патенты и ссылки.
- Смешение, приготовление растворов и рецептур — это uses_as_is, а не chemical_conversions.
- Не нашёл — оставь списки пустыми и скажи это в summary.
Верни СТРОГО JSON по схеме.`;
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Ответ модели → { conversions, uses, summary }: только записи с адресом
 * http(s); у превращения — с продуктом, отличным от исходного.
 */
function parseEndUse(parsed, productName) {
  const self = clean(productName).toLowerCase();
  const withUrl = (x) => /^https?:\/\//i.test(clean(x?.url));
  const conversions = (Array.isArray(parsed?.chemical_conversions) ? parsed.chemical_conversions : [])
    .filter(withUrl)
    .map((x) => ({
      product: clean(x.product),
      process: clean(x.process),
      coReactants: (Array.isArray(x.co_reactants) ? x.co_reactants : []).map(clean).filter(Boolean),
      title: clean(x.title),
      url: clean(x.url),
      quote: clean(x.quote),
    }))
    .filter((x) => x.product && x.product.toLowerCase() !== self)
    .slice(0, 8);
  const uses = (Array.isArray(parsed?.uses_as_is) ? parsed.uses_as_is : [])
    .filter(withUrl)
    .map((x) => ({ use: clean(x.use), how: clean(x.how), title: clean(x.title), url: clean(x.url), quote: clean(x.quote) }))
    .filter((x) => x.use)
    .slice(0, 8);
  return { conversions, uses, summary: clean(parsed?.summary) };
}

/**
 * Превращение → источник шага (TechnologySource): им можно сразу обобщить
 * шаг «вниз» — блок описывает ровно «X + … → Y».
 */
function conversionSource(c, productName) {
  const inputs = [productName, ...c.coReactants];
  return {
    title: c.title || `${productName} → ${c.product}`,
    url: c.url,
    access_hint: "найдено проверкой «что из продукта делают»",
    technology_description: `${c.process ? `${c.process}. ` : ""}Из «${productName}»${c.coReactants.length ? ` и ${c.coReactants.join(", ")}` : ""} получают «${c.product}».${c.quote ? ` Цитата источника: «${c.quote}»` : ""}`,
    inputs_outputs_hint: [`${c.process || "Превращение"}: ${inputs.join(", ")} → ${c.product}`],
    evidence_snippets: c.quote ? [c.quote] : [],
    origin: "web",
  };
}

/**
 * Итог: processed — есть химическая переработка (шаг возможен), end_product —
 * только применение как есть, unknown — ничего подтверждённого.
 */
function verdictOf(conversions, uses) {
  if (conversions.length) return "processed";
  if (uses.length) return "end_product";
  return "unknown";
}

module.exports = { SCHEMA, endUsePrompt, parseEndUse, conversionSource, verdictOf };
