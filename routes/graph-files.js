const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const router = express.Router();
const GRAPH_DIR = path.resolve(__dirname, "../data/saved-graphs");

router.post("/save", async (req, res) => {
  try {
    const { name, prompt, nodes, edges, leaf_nodes, has_more } = req.body;

    if (!nodes || !edges) {
      return res.status(400).json({ error: "nodes and edges required" });
    }

    await fs.mkdir(GRAPH_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    const safeName = (name || prompt || "graph")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 50);

    const fileName = `${safeName}_${timestamp}.json`;
    const filePath = path.join(GRAPH_DIR, fileName);

    const fileData = {
      meta: {
        name: name || prompt,
        prompt,
        createdAt: new Date().toISOString(),
      },
      graph: {
        nodes,
        edges,
      },
      state: {
        leaf_nodes: leaf_nodes || [],
        has_more: !!has_more,
      },
    };

    await fs.writeFile(filePath, JSON.stringify(fileData, null, 2), "utf-8");

    res.json({ success: true, file: fileName });
  } catch (e) {
    console.error("Save graph error:", e);
    res.status(500).json({ error: "Failed to save graph" });
  }
});

router.get("/", async (req, res) => {
  try {
    await fs.mkdir(GRAPH_DIR, { recursive: true });

    const files = await fs.readdir(GRAPH_DIR);

    const result = await Promise.all(
      files.map(async (file) => {
        const content = JSON.parse(
          await fs.readFile(path.join(GRAPH_DIR, file), "utf-8"),
        );

        return {
          id: file,
          name: content.meta.name,
          createdAt: content.meta.createdAt,
          updatedAt: content.meta.updatedAt || null,
          leafCount: content.state.leaf_nodes.length,
        };
      }),
    );

    res.json({ success: true, data: result });
  } catch (e) {
    console.error("List graphs error:", e);
    res.status(500).json({ error: "Failed to read graphs" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const fileName = path.basename(req.params.id);
    const filePath = path.join(GRAPH_DIR, fileName);

    const data = await fs.readFile(filePath, "utf-8");
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: "Graph not found" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const fileName = path.basename(req.params.id);
    const filePath = path.join(GRAPH_DIR, fileName);

    await fs.unlink(filePath);
    res.status(204).end();
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return res.status(404).json({ error: "Graph not found" });
    }
    console.error("Delete graph error:", e);
    res.status(500).json({ error: "Failed to delete graph" });
  }
});

// Вспомогательное: прочитать существующий файл графа (или null, если нет).
async function readGraphFile(id) {
  const fileName = path.basename(id);
  const filePath = path.join(GRAPH_DIR, fileName);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return { fileName, filePath, content: JSON.parse(raw) };
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

function metaResponse(fileName, content) {
  return {
    id: fileName,
    name: content.meta.name,
    createdAt: content.meta.createdAt,
    updatedAt: content.meta.updatedAt || null,
    leafCount: (content.state.leaf_nodes || []).length,
  };
}

// Обновить (перезаписать содержимое) существующий сохранённый граф.
// Имя файла/id НЕ меняется — перезаписываем содержимое того же файла.
router.put("/:id", async (req, res) => {
  try {
    const { name, prompt, nodes, edges, leaf_nodes, has_more, sources } =
      req.body;

    if (!nodes || !edges) {
      return res.status(400).json({ error: "nodes and edges required" });
    }

    const existing = await readGraphFile(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Graph not found" });
    }

    const { fileName, filePath, content } = existing;

    const updated = {
      meta: {
        name: name != null ? name : content.meta.name,
        prompt: prompt != null ? prompt : content.meta.prompt,
        createdAt: content.meta.createdAt,
        updatedAt: new Date().toISOString(),
      },
      graph: { nodes, edges },
      state: {
        leaf_nodes: leaf_nodes || [],
        has_more: !!has_more,
        ...(sources ? { sources } : {}),
      },
    };

    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");

    res.json({ success: true, data: metaResponse(fileName, updated) });
  } catch (e) {
    console.error("Update graph error:", e);
    res.status(500).json({ error: "Failed to update graph" });
  }
});

// Переименовать сохранённый граф (меняем только meta.name; файл/id прежние).
router.patch("/:id", async (req, res) => {
  try {
    const { name } = req.body;
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }

    const existing = await readGraphFile(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Graph not found" });
    }

    const { fileName, filePath, content } = existing;
    content.meta.name = name.trim();
    content.meta.updatedAt = new Date().toISOString();

    await fs.writeFile(filePath, JSON.stringify(content, null, 2), "utf-8");

    res.json({ success: true, data: metaResponse(fileName, content) });
  } catch (e) {
    console.error("Rename graph error:", e);
    res.status(500).json({ error: "Failed to rename graph" });
  }
});

module.exports = router;
