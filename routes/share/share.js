const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();
const SHARE_DIR = path.resolve(__dirname, "../../data/shared-graphs");

// Короткий URL-безопасный токен (base62). 8 символов ≈ 47.6 бит — без коллизий
// на нашем объёме; уникальность дополнительно проверяется по файловой системе.
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateUniqueToken() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const token = generateToken();
    if (!(await fileExists(path.join(SHARE_DIR, `${token}.json`)))) {
      return token;
    }
  }
  throw new Error("Failed to generate a unique share token");
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

    await fs.mkdir(SHARE_DIR, { recursive: true });

    const token = await generateUniqueToken();
    const filePath = path.join(SHARE_DIR, `${token}.json`);

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

    await fs.writeFile(filePath, JSON.stringify(fileData, null, 2), "utf-8");

    res.json({ success: true, id: token });
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

    const filePath = path.join(SHARE_DIR, `${id}.json`);
    const data = await fs.readFile(filePath, "utf-8");
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: "Graph not found" });
  }
});

module.exports = router;
