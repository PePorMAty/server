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

const { resolveGraph } = require("./utils");
const { getStore } = require("./store");

const router = express.Router();

/** Тип узла, на который указывает закладка: от него зависит иконка в панели. */
const KINDS = new Set(["product", "transformation"]);

router.get("/:id/bookmarks", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    res.json({ success: true, data: await getStore().listBookmarks(fileName) });
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

    // Правка существующей закладки меняет только пришедшие поля (и не
    // createdAt) — иначе список перетасовывается на каждой правке заметки.
    const { item, created } = await getStore().upsertBookmark(
      fileName,
      nodeId,
      { label, kind, note },
      { actor: req.actor ?? null },
    );
    if (!created) return res.json({ success: true, data: item });

    res.status(201).json({ success: true, data: item });
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
    if (!(await getStore().deleteBookmark(fileName, nodeId))) {
      return res.status(404).json({ error: "Bookmark not found" });
    }
    res.status(204).end();
  } catch (e) {
    console.error("Delete bookmark error:", e);
    res.status(500).json({ error: "Failed to delete bookmark" });
  }
});

module.exports = router;
