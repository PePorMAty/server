// routes/graph-files/bookmarks.js
//
// Закладки графа — узлы, к которым пользователь хочет быстро возвращаться.
//
// Лежат сайдкаром рядом с графом, а не внутри его файла: закладку ставят на
// лету, и она должна пережить перезагрузку вкладки, даже если сам граф с
// момента правки ещё не сохраняли.
//
//   GET    /graph-files/:id/bookmarks           — закладки графа
//   PUT    /graph-files/:id/bookmarks/:nodeId   — создать или обновить
//   DELETE /graph-files/:id/bookmarks/:nodeId   — удалить

const express = require("express");

const {
  BOOKMARKS_DIR,
  sidecarPath,
  readJson,
  writeJson,
  resolveGraph,
} = require("./utils");

const router = express.Router();

/** Тип узла, на который указывает закладка: от него зависит иконка в панели. */
const KINDS = new Set(["product", "transformation"]);

async function readBookmarks(fileName) {
  const stored = await readJson(sidecarPath(BOOKMARKS_DIR, fileName));
  return Array.isArray(stored?.items) ? stored.items : [];
}

async function writeBookmarks(fileName, items) {
  await writeJson(sidecarPath(BOOKMARKS_DIR, fileName), {
    graphId: fileName,
    updatedAt: new Date().toISOString(),
    items,
  });
}

router.get("/:id/bookmarks", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    res.json({ success: true, data: await readBookmarks(fileName) });
  } catch (e) {
    console.error("List bookmarks error:", e);
    res.status(500).json({ error: "Failed to read bookmarks" });
  }
});

router.put("/:id/bookmarks/:nodeId", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    const nodeId = String(req.params.nodeId || "").trim();
    if (!nodeId) return res.status(400).json({ error: "Bad node id" });

    const { label, kind, note } = req.body ?? {};

    if (label !== undefined && typeof label !== "string") {
      return res.status(400).json({ error: "label must be a string" });
    }
    if (note !== undefined && typeof note !== "string") {
      return res.status(400).json({ error: "note must be a string" });
    }
    if (kind !== undefined && !KINDS.has(kind)) {
      return res
        .status(400)
        .json({ error: `kind must be one of: ${[...KINDS].join(", ")}` });
    }

    const items = await readBookmarks(fileName);
    const existing = items.find((b) => b.nodeId === nodeId);

    if (existing) {
      // Правка существующей закладки: пришедшие поля меняем, остальные (и, что
      // важно, createdAt) оставляем — иначе список перетасовывается на каждой
      // правке заметки.
      if (label !== undefined) existing.label = label;
      if (note !== undefined) existing.note = note;
      if (kind !== undefined) existing.kind = kind;

      await writeBookmarks(fileName, items);
      return res.json({ success: true, data: existing });
    }

    const created = {
      graphId: fileName,
      nodeId,
      label: label ?? "",
      kind: kind ?? "product",
      note: note ?? "",
      createdAt: new Date().toISOString(),
    };

    // Свежие — первыми, как в панели закладок на клиенте.
    items.unshift(created);
    await writeBookmarks(fileName, items);

    res.status(201).json({ success: true, data: created });
  } catch (e) {
    console.error("Save bookmark error:", e);
    res.status(500).json({ error: "Failed to save bookmark" });
  }
});

router.delete("/:id/bookmarks/:nodeId", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    const nodeId = String(req.params.nodeId || "").trim();
    const items = await readBookmarks(fileName);
    const rest = items.filter((b) => b.nodeId !== nodeId);

    if (rest.length === items.length) {
      return res.status(404).json({ error: "Bookmark not found" });
    }

    await writeBookmarks(fileName, rest);
    res.status(204).end();
  } catch (e) {
    console.error("Delete bookmark error:", e);
    res.status(500).json({ error: "Failed to delete bookmark" });
  }
});

module.exports = router;
