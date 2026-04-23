// routes/fill-card/utils/openai.js

const axios = require("axios");
const https = require("https");

const OPENAI_URL = "https://api.openai.com/v1/responses";
const httpsAgent = new https.Agent({ keepAlive: true });

function extractOutputText(resp) {
  if (!resp) return "";

  if (typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }

  const out = Array.isArray(resp.output) ? resp.output : [];
  const parts = [];

  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }

  return parts.join("\n").trim();
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

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
  apiKey,
  systemPrompt,
  userPrompt,
  nodeType,
  selectedFields,
  useWebSearch,
}) {
  const payload = {
    model: "gpt-5-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    reasoning: { effort: "low" },
    truncation: "auto",
    max_output_tokens: 4000,
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
  const { data } = await axios.post(OPENAI_URL, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    httpsAgent,
    timeout: 10 * 60 * 1000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return data;
}

module.exports = {
  callOpenAIFillCard,
  extractOutputText,
  safeJsonParse,
};
