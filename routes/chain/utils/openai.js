// routes/chain/utils/openai.js

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

async function callOpenAIResponsesRaw({ apiKey, payload, timeoutMs = 10 * 60 * 1000 }) {
  const { data } = await axios.post(OPENAI_URL, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    httpsAgent,
    timeout: timeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return data;
}

module.exports = { extractOutputText, safeJsonParse, callOpenAIResponsesRaw };