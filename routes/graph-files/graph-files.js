const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const {
  GRAPH_DIR,
  safeId,
  readGraphFile,
  graphMeta,
  removeSidecars,
} = require("./utils");

const router = express.Router();

router.post("/save", async (req, res) => {
  try {
    const {
      name,
      prompt,
      description,
      nodes,
      edges,
      leaf_nodes,
      has_more,
      sources,
    } = req.body;

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

    // Создание — тоже изменение: проставляем updatedAt сразу, чтобы сортировка
    // «Сначала изменённые» не спотыкалась о пустое поле у свежих графов.
    const now = new Date().toISOString();

    const fileData = {
      meta: {
        name: name || prompt,
        prompt,
        // Описание «О графе» — отдельный от промта пользовательский текст.
        description: typeof description === "string" ? description : null,
        createdAt: now,
        updatedAt: now,
      },
      graph: {
        nodes,
        edges,
      },
      state: {
        leaf_nodes: leaf_nodes || [],
        has_more: !!has_more,
        // Пул источников + счётчики номеров бейджа (если переданы).
        sources: sources || null,
      },
    };

    await fs.writeFile(filePath, JSON.stringify(fileData, null, 2), "utf-8");

    res.json({
      success: true,
      file: fileName,
      data: graphMeta(fileName, fileData),
    });
  } catch (e) {
    console.error("Save graph error:", e);
    res.status(500).json({ error: "Failed to save graph" });
  }
});

router.get("/", async (req, res) => {
  try {
    await fs.mkdir(GRAPH_DIR, { recursive: true });

    const files = await fs.readdir(GRAPH_DIR);

    // Отдаём только мету, без узлов: библиотека грузит граф целиком лишь для
    // выбранной строки. Один нечитаемый файл не должен ронять весь список —
    // пропускаем его с записью в лог.
    const result = [];

    for (const file of files) {
      if (!file.toLowerCase().endsWith(".json")) continue;

      try {
        const content = JSON.parse(
          await fs.readFile(path.join(GRAPH_DIR, file), "utf-8"),
        );
        result.push(graphMeta(file, content));
      } catch (e) {
        console.warn(`List graphs: пропускаю ${file} — ${e.message}`);
      }
    }

    res.json({ success: true, data: result });
  } catch (e) {
    console.error("List graphs error:", e);
    res.status(500).json({ error: "Failed to read graphs" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const existing = await readGraphFile(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Graph not found" });
    }
    res.json(existing.content);
  } catch (e) {
    console.error("Read graph error:", e);
    res.status(500).json({ error: "Failed to read graph" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const fileName = safeId(req.params.id);
    if (!fileName) return res.status(400).json({ error: "Bad graph id" });

    await fs.unlink(path.join(GRAPH_DIR, fileName));
    // Закладки и история графа без него бессмысленны — уносим вместе с ним.
    await removeSidecars(fileName);

    res.status(204).end();
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return res.status(404).json({ error: "Graph not found" });
    }
    console.error("Delete graph error:", e);
    res.status(500).json({ error: "Failed to delete graph" });
  }
});

// Обновить (перезаписать содержимое) существующий сохранённый граф.
// Имя файла/id НЕ меняется — перезаписываем содержимое того же файла.
router.put("/:id", async (req, res) => {
  try {
    const { name, prompt, description, nodes, edges, leaf_nodes, has_more, sources } =
      req.body;

    if (!nodes || !edges) {
      return res.status(400).json({ error: "nodes and edges required" });
    }

    const existing = await readGraphFile(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Graph not found" });
    }

    const { fileName, filePath, content } = existing;
    const prevMeta = content.meta ?? {};
    const prevState = content.state ?? {};

    const updated = {
      meta: {
        name: name != null ? name : prevMeta.name,
        prompt: prompt != null ? prompt : prevMeta.prompt,
        // Описание и источники не приходят в обычном «Сохранить» — сохраняем
        // прежние значения, иначе перезапись графа их стирает.
        description:
          typeof description === "string"
            ? description
            : (prevMeta.description ?? null),
        createdAt: prevMeta.createdAt,
        updatedAt: new Date().toISOString(),
      },
      graph: { nodes, edges },
      state: {
        leaf_nodes: leaf_nodes || [],
        has_more: !!has_more,
        sources: sources ?? prevState.sources ?? null,
      },
    };

    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");

    res.json({ success: true, data: graphMeta(fileName, updated) });
  } catch (e) {
    console.error("Update graph error:", e);
    res.status(500).json({ error: "Failed to update graph" });
  }
});

// Правка меты сохранённого графа: имя и/или описание. Обновляем только те поля,
// что пришли в теле, — клиент шлёт их по отдельности из разных мест библиотеки.
router.patch("/:id", async (req, res) => {
  try {
    const { name, description } = req.body ?? {};

    const hasName = name !== undefined;
    const hasDescription = description !== undefined;

    if (!hasName && !hasDescription) {
      return res.status(400).json({ error: "name or description required" });
    }
    if (hasName && (typeof name !== "string" || !name.trim())) {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
    // Описание можно очистить — пустая строка здесь допустима.
    if (hasDescription && typeof description !== "string") {
      return res.status(400).json({ error: "description must be a string" });
    }

    const existing = await readGraphFile(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Graph not found" });
    }

    const { fileName, filePath, content } = existing;
    content.meta = content.meta ?? {};

    if (hasName) content.meta.name = name.trim();
    if (hasDescription) content.meta.description = description;
    content.meta.updatedAt = new Date().toISOString();

    await fs.writeFile(filePath, JSON.stringify(content, null, 2), "utf-8");

    res.json({ success: true, data: graphMeta(fileName, content) });
  } catch (e) {
    console.error("Patch graph error:", e);
    res.status(500).json({ error: "Failed to update graph meta" });
  }
});

module.exports = router;
