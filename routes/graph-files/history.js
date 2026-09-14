// routes/graph-files/history.js
//
// История действий над графом: построенные шаги, правки узлов и связей,
// объединения, сохранения.
//
// Как и закладки, лежит сайдкаром рядом с графом. Клиент накапливает записи и
// шлёт их пачкой — писать каждое действие отдельным запросом слишком дорого,
// поэтому POST принимает и одну запись, и массив.
//
//   GET    /graph-files/:id/history?limit=  — последние записи, свежие первыми
//   POST   /graph-files/:id/history         — добавить запись или пачку
//   DELETE /graph-files/:id/history         — очистить

const express = require("express");

const {
  HISTORY_DIR,
  sidecarPath,
  readJson,
  writeJson,
  removeFile,
  resolveGraph,
} = require("./utils");

const router = express.Router();

/**
 * Сколько записей храним. Совпадает с лимитом панели на клиенте: дальше история
 * только мешает искать нужное, а файл растёт без пользы.
 */
const LIMIT = 300;

/** Смысловые группы записи — от них зависят иконка и цвет строки в панели. */
const KINDS = new Set([
  "create",
  "open",
  "merge",
  "add",
  "remove",
  "edit",
  "step",
  "link",
  "save",
  "clear",
]);

let seq = 0;

async function readHistory(fileName) {
  const stored = await readJson(sidecarPath(HISTORY_DIR, fileName));
  return Array.isArray(stored?.entries) ? stored.entries : [];
}

async function writeHistory(fileName, entries) {
  await writeJson(sidecarPath(HISTORY_DIR, fileName), {
    graphId: fileName,
    updatedAt: new Date().toISOString(),
    entries,
  });
}

/**
 * Привести пришедшую запись к хранимому виду. Возвращает строку с ошибкой
 * вместо записи, если запись негодная, — вызывающий отвечает 400.
 */
function normalizeEntry(raw, graphId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "entry must be an object";
  }
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    return "entry.title must be a non-empty string";
  }
  if (!KINDS.has(raw.kind)) {
    return `entry.kind must be one of: ${[...KINDS].join(", ")}`;
  }
  if (raw.details !== undefined && typeof raw.details !== "string") {
    return "entry.details must be a string";
  }
  if (raw.nodeIds !== undefined && !Array.isArray(raw.nodeIds)) {
    return "entry.nodeIds must be an array";
  }

  seq += 1;

  return {
    // id клиента сохраняем как есть: по нему он сверяет, что запись уже ушла.
    id: typeof raw.id === "string" && raw.id ? raw.id : `h-${Date.now().toString(36)}-${seq}`,
    graphId,
    at: typeof raw.at === "string" && raw.at ? raw.at : new Date().toISOString(),
    kind: raw.kind,
    title: raw.title.trim(),
    ...(raw.details !== undefined ? { details: raw.details } : {}),
    ...(raw.nodeIds !== undefined
      ? { nodeIds: raw.nodeIds.map((id) => String(id)) }
      : {}),
  };
}

router.get("/:id/history", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    const entries = await readHistory(fileName);

    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, LIMIT)
        : LIMIT;

    res.json({ success: true, data: entries.slice(0, limit) });
  } catch (e) {
    console.error("Read history error:", e);
    res.status(500).json({ error: "Failed to read history" });
  }
});

router.post("/:id/history", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    const body = req.body ?? {};
    // Пачкой ({ entries: [...] } или голым массивом) и по одной записи — клиент
    // копит события и отправляет как получится.
    const incoming = Array.isArray(body)
      ? body
      : Array.isArray(body.entries)
        ? body.entries
        : [body];

    if (incoming.length === 0) {
      return res.status(400).json({ error: "entries required" });
    }

    const normalized = [];
    for (const raw of incoming) {
      const entry = normalizeEntry(raw, fileName);
      if (typeof entry === "string") {
        return res.status(400).json({ error: entry });
      }
      normalized.push(entry);
    }

    // Пачка приходит в порядке событий, а храним свежими вперёд.
    const entries = [...normalized.reverse(), ...(await readHistory(fileName))];
    if (entries.length > LIMIT) entries.length = LIMIT;

    await writeHistory(fileName, entries);

    res.status(201).json({ success: true, added: normalized.length, data: entries });
  } catch (e) {
    console.error("Append history error:", e);
    res.status(500).json({ error: "Failed to append history" });
  }
});

router.delete("/:id/history", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    await removeFile(sidecarPath(HISTORY_DIR, fileName));
    res.status(204).end();
  } catch (e) {
    console.error("Clear history error:", e);
    res.status(500).json({ error: "Failed to clear history" });
  }
});

module.exports = router;
