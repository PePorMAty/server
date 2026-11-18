// routes/graph-files/graph-files.js
//
// Библиотека графов: список, открыть, сохранить новый, перезаписать,
// переименовать, удалить. Где лежат графы — файлы или PostgreSQL — решает
// хранилище (store/index.js, GRAPH_STORE); адреса и ответы те же.
//
// Версия графа (meta.version, растёт с каждым сохранением): клиент присылает
// в PUT ту, с которой открыл граф, — если граф тем временем сохранил кто-то
// другой, ответ 409 с метой свежей версии, и клиент предлагает открыть её или
// сохранить свою копией. Без версии (старый клиент) — сохраняет как раньше.

const express = require("express");

const { safeId } = require("./utils");
const { getStore, metaOf, ConflictError } = require("./store");

const router = express.Router();

/** Кто делает: появится с пользователями (этап 5 PG-MIGRATION.md). */
const actorOf = (req) => req.actor ?? null;

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

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    const safeName = (name || prompt || "graph")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 50);

    const fileName = `${safeName}_${timestamp}.json`;

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

    const created = await getStore().createGraph(fileName, fileData, { actor: actorOf(req) });

    res.json({
      success: true,
      file: fileName,
      data: metaOf(fileName, created.content),
    });
  } catch (e) {
    console.error("Save graph error:", e);
    res.status(500).json({ error: "Failed to save graph" });
  }
});

router.get("/", async (req, res) => {
  try {
    // Отдаём только мету, без узлов: библиотека грузит граф целиком лишь для
    // выбранной строки.
    res.json({ success: true, data: await getStore().listGraphs() });
  } catch (e) {
    console.error("List graphs error:", e);
    res.status(500).json({ error: "Failed to read graphs" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = safeId(req.params.id);
    const existing = id ? await getStore().getGraph(id) : null;
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

    // Закладки и история графа без него бессмысленны — хранилище уносит их
    // вместе с ним (в базе — мягко, восстановимо).
    const removed = await getStore().deleteGraph(fileName, { actor: actorOf(req) });
    if (!removed) return res.status(404).json({ error: "Graph not found" });

    res.status(204).end();
  } catch (e) {
    console.error("Delete graph error:", e);
    res.status(500).json({ error: "Failed to delete graph" });
  }
});

// Обновить (перезаписать содержимое) существующий сохранённый граф.
// Имя файла/id НЕ меняется — перезаписываем содержимое того же графа.
router.put("/:id", async (req, res) => {
  try {
    const { name, prompt, description, nodes, edges, leaf_nodes, has_more, sources, version } =
      req.body;

    if (!nodes || !edges) {
      return res.status(400).json({ error: "nodes and edges required" });
    }
    const id = safeId(req.params.id);
    if (!id) return res.status(404).json({ error: "Graph not found" });

    const store = getStore();
    const saved = await store.updateGraph(
      id,
      (content) => {
        const prevMeta = content.meta ?? {};
        const prevState = content.state ?? {};
        return {
          meta: {
            name: name != null ? name : prevMeta.name,
            prompt: prompt != null ? prompt : prevMeta.prompt,
            // Описание и источники не приходят в обычном «Сохранить» —
            // сохраняем прежние значения, иначе перезапись графа их стирает.
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
      },
      { expectedVersion: version, actor: actorOf(req) },
    );
    if (!saved) {
      return res.status(404).json({ error: "Graph not found" });
    }

    // Расчёты баланса и идентификаторы продуктов теперь в самом графе, в
    // данных узлов: сайдкары с ними (material-balances.js, product-ids.js)
    // больше не нужны — и не должны перекрыть сохранённое при следующем
    // открытии.
    await store.clearBalances(id);
    await store.clearProductIds(id);

    res.json({ success: true, data: metaOf(id, saved.content) });
  } catch (e) {
    if (e instanceof ConflictError) {
      // Граф сохранили, пока его правили: клиент предложит открыть свежую
      // версию или сохранить свою копией.
      return res.status(409).json({ success: false, error: "conflict", current: e.current.meta });
    }
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

    const id = safeId(req.params.id);
    const saved = id
      ? await getStore().updateGraph(
          id,
          (content) => {
            const meta = { ...(content.meta ?? {}) };
            if (hasName) meta.name = name.trim();
            if (hasDescription) meta.description = description;
            meta.updatedAt = new Date().toISOString();
            return { ...content, meta };
          },
          // Имя и описание — не правка графа: версию не трогаем, чтобы
          // переименование в библиотеке не давало конфликт тому, кто граф
          // сейчас правит.
          { bump: false, actor: actorOf(req) },
        )
      : null;
    if (!saved) {
      return res.status(404).json({ error: "Graph not found" });
    }

    res.json({ success: true, data: metaOf(id, saved.content) });
  } catch (e) {
    console.error("Patch graph error:", e);
    res.status(500).json({ error: "Failed to update graph meta" });
  }
});

module.exports = router;
