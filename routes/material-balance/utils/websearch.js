// routes/material-balance/utils/websearch.js
//
// Поиск недостающих данных баланса в интернете — отдельным коротким
// запросом сервера.
//
// Зачем отдельно. В запросе баланса — шаблон заказчика и фрагменты ИТС на
// десятки тысяч знаков; веб-поиск у модели в нём включён, но flash-модели
// находят раздел ИТС и дальше не ищут: в ответе нет ни одного веб-источника,
// у попутных продуктов — «Нет данных», и просьба «найди в интернете» во
// втором запросе не помогает. Короткий запрос «найди выход синильной
// кислоты при окислительном аммонолизе пропилена, верни ссылки и цитаты»
// те же модели выполняют хорошо — так работает и поиск источников графа.
//
// Найденное сервер загружает и проверяет, как любой источник (числа из
// цитат — в тексте страницы), и подтверждённое отдаёт модели во втором
// запросе готовыми веб-источниками.

const { callOpenAIResponsesRaw, extractOutputText, safeJsonParse } = require("../../sources/utils/openai");

/** Сколько источников просить. */
const MAX_SOURCES = 6;

const VALUE = {
  type: "object",
  additionalProperties: false,
  required: ["substance", "indicator", "value", "unit", "conditions", "quote"],
  properties: {
    substance: { type: "string" },
    indicator: { type: "string" },
    value: { type: "string" },
    unit: { type: "string" },
    conditions: { type: "string" },
    quote: { type: "string" },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sources"],
  properties: {
    sources: {
      type: "array",
      maxItems: MAX_SOURCES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "title", "org_year", "type", "values"],
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          org_year: { type: "string" },
          type: { type: "string" },
          values: { type: "array", items: VALUE },
        },
      },
    },
  },
};

const what = (r) =>
  r.role === "input"
    ? `«${r.name}» — расход: кг на 1 т основного продукта или на 1 т основного сырья, мольное соотношение к основному сырью`
    : `«${r.name}» — выход: кг на 1 т основного сырья или на 1 т основного продукта, % от теоретического, селективность`;

/** Текст поискового запроса. */
function searchPrompt({ transformation, inputs, outputs, missing }) {
  return [
    `Найди в интернете численные данные для материального баланса технологии «${transformation}».`,
    `Сырьё: ${inputs.join(", ")}. Продукты: ${outputs.join(", ")}.`,
    "",
    "Нужно найти:",
    ...missing.map((r) => `- ${what(r)};`),
    "",
    "Ищи в справочниках, ИТС НДТ, отраслевых обзорах, учебниках, научных статьях и патентах, на русском и английском. " +
      `Верни до ${MAX_SOURCES} источников. Для каждого — прямую ссылку на страницу или PDF, название, организацию или авторов и год, тип и найденные значения: ` +
      "вещество, показатель, число как в документе, единица и знаменатель, условия и дословная цитата с этим числом.",
    "Не придумывай и не пересчитывай: только то, что написано в документе. Ссылки — только на открытые страницы, которые ты нашёл поиском.",
  ].join("\n");
}

const cell = (s) => String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/**
 * Найденный источник — в виде блока источника шаблона заказчика: с таблицей
 * «Данные для материального баланса», по которой проверка источников
 * (sources.js) ищет числа в тексте страницы.
 */
function sourceBlock(src) {
  return [
    `URL: ${src.url}`,
    `Название: ${cell(src.title) || "Не указано"}`,
    `Организация и год: ${cell(src.org_year) || "Не указано"}`,
    `Тип: ${cell(src.type) || "Не указано"}`,
    "",
    "Данные для материального баланса:",
    "| Показатель | Исходное значение | Единица и знаменатель | Условия | Цитата |",
    "|---|---|---|---|---|",
    ...src.values.map(
      (v) =>
        `| ${cell(v.indicator)} ${cell(v.substance)} | ${cell(v.value)} | ${cell(v.unit)} | ${cell(v.conditions) || "—"} | ${cell(v.quote)} |`,
    ),
  ].join("\n");
}

/** Источники из ответа модели: с адресом и хотя бы одним числом. */
function pickSources(parsed) {
  const list = Array.isArray(parsed?.sources) ? parsed.sources : [];
  const seen = new Set();
  return list
    .map((s) => ({
      url: String(s?.url || "").trim(),
      title: String(s?.title || "").trim(),
      org_year: String(s?.org_year || "").trim(),
      type: String(s?.type || "").trim(),
      values: (Array.isArray(s?.values) ? s.values : []).filter((v) => /\d/.test(String(v?.value || ""))),
    }))
    .filter((s) => /^https?:\/\//i.test(s.url) && s.values.length && !seen.has(s.url) && seen.add(s.url))
    .slice(0, MAX_SOURCES);
}

/**
 * Найти недостающее. missing — refs без массы. Возвращает
 * { sources: [{ id: "W1", url, title, block, ... }], fixes } — источники
 * ещё не проверены; ошибку модели бросает.
 */
async function searchMissing({ input, missing, signal }) {
  const prompt = searchPrompt({
    transformation: input.transformation.name,
    inputs: input.inputs.map((n) => n.name),
    outputs: input.outputs.map((n) => n.name),
    missing,
  });
  const resp = await callOpenAIResponsesRaw({
    payload: {
      model: "gpt-5-mini",
      input: prompt,
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: "auto",
      reasoning: { effort: "low" },
      truncation: "auto",
      max_output_tokens: 8000,
      text: { format: { type: "json_schema", name: "balance_web_data", schema: SCHEMA, strict: true } },
    },
    timeoutMs: 6 * 60 * 1000,
    provider: input.provider,
    model: input.model,
    signal,
    searchRequired: true,
  });
  const sources = pickSources(safeJsonParse(extractOutputText(resp))).map((s, i) => ({
    ...s,
    id: `W${i + 1}`,
    block: sourceBlock(s),
  }));
  return { sources, prompt };
}

/**
 * Подтверждённые сервером найденные источники — во второй запрос модели.
 * found — [{ source, check }] только со status: saved.
 */
function foundText(found) {
  if (!found.length) return "";
  return [
    "# Данные, найденные сервером в интернете",
    "Сервер выполнил веб-поиск недостающих данных, загрузил найденные документы и нашёл в их тексте приведённые числа (server_status: saved). Используй эти данные для недостающих масс. Каждый использованный документ опиши в разделе «Источники» блоком «## Источник [S…]» по шаблону — с тем же URL, server_status: saved и его server_document_id.",
    "",
    ...found.flatMap(({ source, check }) => [
      `## Найденный источник [${source.id}]`,
      `server_document_id: ${check.documentId}`,
      source.block,
      "",
    ]),
  ].join("\n");
}

module.exports = { searchMissing, searchPrompt, foundText, pickSources, SCHEMA };
