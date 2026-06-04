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

module.exports = router;
