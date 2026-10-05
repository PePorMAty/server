// routes/fill-card/utils/openai.js

// Разбор ответа — общий: он понимает JSON в ```json```, с пояснениями вокруг
// и с лишним текстом после. Своя копия здесь брала жадным выражением от первой
// «{» до последней «}» и ломалась, если модель что-то дописывала.
const {
  callOpenAIResponsesRaw,
  extractOutputText,
  safeJsonParse,
} = require("../../sources/utils");
const { labelsFor } = require("./card");

function buildFillCardSchema(nodeType, selectedFields) {
  // все поля для данного типа — по тому же списку, что подписи (card.js):
  // поле, добавленное туда, без этого строгая схема бы не пропустила
  const allFields = Object.fromEntries(
    Object.keys(labelsFor(nodeType)).map((key) => [key, { type: "string" }]),
  );

  // если selectedFields передан — оставляем только запрошенные поля
  // + добавляем кастомные (которых нет в allFields)
  let properties;
  let required;

  if (Array.isArray(selectedFields) && selectedFields.length > 0) {
    properties = {};
    for (const key of selectedFields) {
      properties[key] = allFields[key] || { type: "string" };
    }
    required = selectedFields;
  } else {
    properties = allFields;
    required = Object.keys(allFields);
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["productCard"],
    properties: {
      productCard: {
        type: "object",
        additionalProperties: false,
        required,
        properties,
      },
    },
  };
}

async function callOpenAIFillCard({
  systemPrompt,
  userPrompt,
  nodeType,
  selectedFields,
  useWebSearch,
  provider,
  model,
}) {
  const payload = {
    model: "gpt-5-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    reasoning: { effort: "low" },
    truncation: "auto",
    // Как в остальных маршрутах. Прежние 4000 — единственное место с таким
    // потолком: у моделей с размышлениями бюджет делится между рассуждением и
    // ответом, и на 4000 content приходил пустым (Qwen/DeepSeek Flash).
    max_output_tokens: 16000,
    text: {
      format: {
        type: "json_schema",
        name: "fill_card",
        strict: true,
        schema: buildFillCardSchema(nodeType, selectedFields),
      },
    },
  };
  if (useWebSearch) {
    payload.tools = [{ type: "web_search_preview" }];
  }

  // Транспорт общий: он знает про провайдеров, выбор модели и конвертацию
  // Responses -> Chat Completions для Qwen (включая web_search -> enable_search).
  return callOpenAIResponsesRaw({
    payload,
    timeoutMs: 10 * 60 * 1000,
    provider,
    model,
  });
}

module.exports = {
  callOpenAIFillCard,
  extractOutputText,
  safeJsonParse,
};
