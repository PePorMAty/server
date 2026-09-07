// routes/fill-card/utils/openai.js
//
// Запрос карточки узла к LLM.
//
// Провайдер и модель приходят из тела запроса (клиент шлёт их из селектора
// «Модель для запросов»). Раньше здесь был жёстко зашит OpenAI gpt-5-mini, и
// выбор модели на карточку не влиял вовсе — DashScope-модели (Qwen, DeepSeek)
// не вызывались никогда.
//
// Общий клиент из sources/utils/openai умеет оба провайдера: у DashScope нет
// /v1/responses, и он сам переводит payload в /v1/chat/completions (включая
// json_schema и enable_search вместо web_search).

const {
  callOpenAIResponsesRaw,
  extractOutputText,
  safeJsonParse,
} = require("../../sources/utils/openai");

/**
 * Потолок ответа. Держим как в остальных маршрутах (16000): у моделей с
 * размышлениями (Qwen/DeepSeek Flash и Pro) бюджет делится между рассуждением
 * и ответом, и при прежних 4000 карточка приходила пустой — рассуждение
 * съедало весь лимит.
 */
const MAX_OUTPUT_TOKENS = 16000;

function buildFillCardSchema(nodeType, selectedFields) {
  // все поля для данного типа
  const allFields =
    nodeType === "transformation"
      ? {
          technology_name: { type: "string" },
          technology_short_description: { type: "string" },
          equipment: { type: "string" },
          conditions: { type: "string" },
          constraints_or_key_property: { type: "string" },
          additional_materials_or_catalysts: { type: "string" },
          energy: { type: "string" },
          enterprise_and_plant: { type: "string" },
        }
      : {
          product_name: { type: "string" },
          product_type: { type: "string" },
          purity: { type: "string" },
          main_impurities: { type: "string" },
          allowed_impurities: { type: "string" },
          conversion_yield: { type: "string" },
          typical_scale: { type: "string" },
          storage: { type: "string" },
          carbon_footprint: { type: "string" },
          producers: { type: "string" },
          applications: { type: "string" },
          price: { type: "string" },
        };

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
    // Модель по умолчанию для openai; provider/model из тела запроса её
    // перекрывают (см. callOpenAIResponsesRaw).
    model: "gpt-5-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    reasoning: { effort: "low" },
    truncation: "auto",
    max_output_tokens: MAX_OUTPUT_TOKENS,
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

  return callOpenAIResponsesRaw({
    payload,
    provider,
    model,
    timeoutMs: 10 * 60 * 1000,
  });
}

module.exports = {
  callOpenAIFillCard,
  extractOutputText,
  safeJsonParse,
};
