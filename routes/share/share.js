// routes/share/share.js
//
// Ссылки «Поделиться»: снимок графа только для чтения по короткому токену.
// Где лежат снимки — файлы data/shared-graphs/ или таблица app.shares —
// решает хранилище библиотеки (graph-files/store, GRAPH_STORE).

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const { getStore } = require("../graph-files/store");

const router = express.Router();

// Короткий URL-безопасный токен (base62). 8 символов ≈ 47.6 бит — без коллизий
// на нашем объёме; уникальность дополнительно проверяется в хранилище.
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 8;
const TOKEN_REGEX = /^[A-Za-z0-9]{6,12}$/;

function generateToken(len = TOKEN_LENGTH) {
  const bytes = crypto.randomBytes(len);
  let token = "";
  for (let i = 0; i < len; i++) {
    token += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return token;
}


// Создать шарный снапшот текущего графа и вернуть короткий id для ссылки.
router.post("/share", async (req, res) => {
  try {
    const { name, prompt, nodes, edges, leaf_nodes, has_more } = req.body;

    if (!nodes || !edges) {
      return res.status(400).json({ error: "nodes and edges required" });
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return res.status(400).json({ error: "nodes must be a non-empty array" });
    }

    // Та же форма, что и у graph-files (meta/graph/state) — клиент переиспользует
    // парсинг SavedGraphFile.
    const fileData = {
      meta: {
        name: name || prompt || "graph",
        prompt: prompt || name || "",
        createdAt: new Date().toISOString(),
      },
      graph: { nodes, edges },
      state: {
        leaf_nodes: leaf_nodes || [],
        has_more: !!has_more,
      },
    };

    // Токен занят — пробуем другой: хранилище не перезаписывает чужой снимок.
    const store = getStore();
    for (let attempt = 0; attempt < 10; attempt++) {
      const token = generateToken();
      if (await store.createShare(token, fileData, { actor: req.actor ?? null })) {
        return res.json({ success: true, id: token });
      }
    }
    throw new Error("Failed to generate a unique share token");
  } catch (e) {
    console.error("Share graph error:", e);
    res.status(500).json({ error: "Failed to share graph" });
  }
});

// Получить шарный граф по короткому id.
router.get("/share/:id", async (req, res) => {
  try {
    const id = path.basename(req.params.id);

    if (!TOKEN_REGEX.test(id)) {
      return res.status(404).json({ error: "Graph not found" });
    }

    const data = await getStore().getShare(id);
    if (!data) return res.status(404).json({ error: "Graph not found" });
    res.json(data);
  } catch {
    res.status(404).json({ error: "Graph not found" });
  }
});

module.exports = router;
