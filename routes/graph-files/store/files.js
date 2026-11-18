// routes/graph-files/store/files.js
//
// Хранилище библиотеки графов на файлах — как было до PostgreSQL
// (GRAPH_STORE=files, по умолчанию; откат с pg — тоже сюда).
//
// Граф — data/saved-graphs/<id>.json, где <id> — имя файла: он же служит
// идентификатором в API. Закладки, история, расчёты баланса и
// идентификаторы продуктов — сайдкарами под тем же именем в соседних
// каталогах: закладку ставят на лету, и она переживает перезагрузку, даже
// если граф не сохраняли. Снимки «Поделиться» — data/shared-graphs/<токен>.json,
// шаблон промпта — data/prompt-layout.json.
//
// «Прочитать, поправить, записать» идёт очередью на каждый файл: две правки
// подряд иначе затирали бы друг друга.

const fs = require("fs/promises");
const path = require("path");

const { ConflictError, metaOf, versionOf, nodeCount } = require("./common");

const HISTORY_LIMIT = 300;

function createFileStore({ dataDir }) {
  const dirs = {
    graphs: path.join(dataDir, "saved-graphs"),
    bookmarks: path.join(dataDir, "bookmarks"),
    history: path.join(dataDir, "history"),
    balances: path.join(dataDir, "material-balances"),
    productIds: path.join(dataDir, "product-ids"),
    shares: path.join(dataDir, "shared-graphs"),
    settings: path.join(dataDir, "settings"),
  };
  // Шаблон промпта лежал отдельным файлом ещё до хранилища — там и остаётся.
  const settingFile = (key) =>
    key === "prompt-layout" ? path.join(dataDir, "prompt-layout.json") : path.join(dirs.settings, `${key}.json`);

  const graphFile = (id) => path.join(dirs.graphs, id);
  const sidecar = (kind, id) => path.join(dirs[kind], `${id.replace(/\.json$/i, "")}.json`);

  async function readJson(filePath) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf-8"));
    } catch (e) {
      if (e && e.code === "ENOENT") return null;
      throw e;
    }
  }
  async function writeJson(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
  async function removeFile(filePath) {
    try {
      await fs.unlink(filePath);
      return true;
    } catch (e) {
      if (e && e.code === "ENOENT") return false;
      throw e;
    }
  }

  const queues = new Map();
  function serialized(key, task) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    queues.set(key, next);
    next
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      })
      .catch(() => {});
    return next;
  }

  // ---------- сайдкары: { graphId, updatedAt, items|entries } ----------
  async function readItems(kind, id) {
    const stored = await readJson(sidecar(kind, id));
    const items = stored?.items;
    return items && typeof items === "object" && !Array.isArray(items) ? items : {};
  }
  const writeItems = (kind, id, items) =>
    writeJson(sidecar(kind, id), { graphId: id, updatedAt: new Date().toISOString(), items });

  async function readBookmarks(id) {
    const stored = await readJson(sidecar("bookmarks", id));
    return Array.isArray(stored?.items) ? stored.items : [];
  }
  const writeBookmarks = (id, items) =>
    writeJson(sidecar("bookmarks", id), { graphId: id, updatedAt: new Date().toISOString(), items });

  async function readHistory(id) {
    const stored = await readJson(sidecar("history", id));
    return Array.isArray(stored?.entries) ? stored.entries : [];
  }

  return {
    kind: "files",

    // ---------- графы ----------
    async listGraphs() {
      await fs.mkdir(dirs.graphs, { recursive: true });
      const files = await fs.readdir(dirs.graphs);
      // Один нечитаемый файл не должен ронять весь список — пропускаем его.
      const result = [];
      for (const file of files.sort()) {
        if (!file.toLowerCase().endsWith(".json")) continue;
        try {
          result.push(metaOf(file, await readJson(graphFile(file))));
        } catch (e) {
          console.warn(`List graphs: пропускаю ${file} — ${e.message}`);
        }
      }
      return result;
    },

    async getGraph(id) {
      const content = await readJson(graphFile(id));
      return content ? { id, content, version: versionOf(content) } : null;
    },

    async graphExists(id) {
      return (await readJson(graphFile(id))) !== null;
    },

    async createGraph(id, content) {
      const next = { ...content, meta: { ...(content.meta ?? {}), version: 1 } };
      await writeJson(graphFile(id), next);
      return { id, content: next, version: 1 };
    },

    /**
     * Обновить граф: update(прежнее содержимое) → новое. expectedVersion —
     * версия, с которой граф открыли: другая — ConflictError. bump: false —
     * правка без новой версии (имя и описание в библиотеке).
     */
    async updateGraph(id, update, { expectedVersion, bump = true } = {}) {
      return serialized(`graph:${id}`, async () => {
        const current = await readJson(graphFile(id));
        if (!current) return null;
        const version = versionOf(current);
        if (expectedVersion != null && Number(expectedVersion) !== version) {
          throw new ConflictError({ id, version, meta: metaOf(id, current) });
        }
        const updated = await update(current);
        const nextVersion = bump ? version + 1 : version;
        const next = { ...updated, meta: { ...(updated.meta ?? {}), version: nextVersion } };
        await writeJson(graphFile(id), next);
        return { id, content: next, version: nextVersion };
      });
    },

    async deleteGraph(id) {
      const removed = await removeFile(graphFile(id));
      if (!removed) return false;
      // Закладки и история графа без него бессмысленны — уносим вместе с ним.
      await Promise.all(["bookmarks", "history", "balances", "productIds"].map((k) => removeFile(sidecar(k, id))));
      return true;
    },

    // ---------- закладки ----------
    listBookmarks: (id) => readBookmarks(id),

    async upsertBookmark(id, nodeId, { label, kind, note }) {
      return serialized(`bookmarks:${id}`, async () => {
        const items = await readBookmarks(id);
        const existing = items.find((b) => b.nodeId === nodeId);
        if (existing) {
          // Пришедшие поля меняем, остальные (и createdAt) оставляем — иначе
          // список перетасовывается на каждой правке заметки.
          if (label !== undefined) existing.label = label;
          if (note !== undefined) existing.note = note;
          if (kind !== undefined) existing.kind = kind;
          await writeBookmarks(id, items);
          return { item: existing, created: false };
        }
        const item = {
          graphId: id,
          nodeId,
          label: label ?? "",
          kind: kind ?? "product",
          note: note ?? "",
          createdAt: new Date().toISOString(),
        };
        items.unshift(item); // свежие — первыми, как в панели закладок
        await writeBookmarks(id, items);
        return { item, created: true };
      });
    },

    async deleteBookmark(id, nodeId) {
      return serialized(`bookmarks:${id}`, async () => {
        const items = await readBookmarks(id);
        const rest = items.filter((b) => b.nodeId !== nodeId);
        if (rest.length === items.length) return false;
        await writeBookmarks(id, rest);
        return true;
      });
    },

    // ---------- история: свежие первыми, не больше HISTORY_LIMIT ----------
    async listHistory(id, limit = HISTORY_LIMIT) {
      return (await readHistory(id)).slice(0, limit);
    },

    /** Добавить записи (в порядке событий); вернуть всю историю, свежие первыми. */
    async appendHistory(id, entries) {
      return serialized(`history:${id}`, async () => {
        const all = [...[...entries].reverse(), ...(await readHistory(id))];
        if (all.length > HISTORY_LIMIT) all.length = HISTORY_LIMIT;
        await writeJson(sidecar("history", id), { graphId: id, updatedAt: new Date().toISOString(), entries: all });
        return all;
      });
    },

    async clearHistory(id) {
      await removeFile(sidecar("history", id));
    },

    // ---------- расчёты баланса узлов ----------
    async getBalances(id) {
      const items = await readItems("balances", id);
      return Object.fromEntries(
        Object.entries(items).map(([nodeId, e]) => [nodeId, Array.isArray(e?.calcs) ? e.calcs : []]),
      );
    },

    async putBalance(id, nodeId, calcs) {
      return serialized(`balances:${id}`, async () => {
        const items = await readItems("balances", id);
        items[nodeId] = { calcs, updatedAt: new Date().toISOString() };
        await writeItems("balances", id, items);
      });
    },

    async clearBalances(id) {
      await removeFile(sidecar("balances", id));
    },

    // ---------- идентификаторы продуктов узлов ----------
    getProductIds: (id) => readItems("productIds", id),

    /** changes — [[nodeId, запись | null]]: null — убрать. */
    async putProductIds(id, changes) {
      return serialized(`productIds:${id}`, async () => {
        const items = await readItems("productIds", id);
        for (const [nodeId, entry] of changes) {
          if (entry === null) delete items[nodeId];
          else items[nodeId] = entry;
        }
        await writeItems("productIds", id, items);
      });
    },

    async clearProductIds(id) {
      await removeFile(sidecar("productIds", id));
    },

    // ---------- снимки «Поделиться» ----------
    async shareExists(token) {
      return (await readJson(path.join(dirs.shares, `${token}.json`))) !== null;
    },
    getShare: (token) => readJson(path.join(dirs.shares, `${token}.json`)),
    async createShare(token, data) {
      const file = path.join(dirs.shares, `${token}.json`);
      if ((await readJson(file)) !== null) return false;
      await writeJson(file, data);
      return true;
    },

    // ---------- настройки ----------
    getSetting: (key) => readJson(settingFile(key)),
    putSetting: (key, value) => writeJson(settingFile(key), value),

    // Для переноса в pg и обратно: что лежит в каталогах.
    _dirs: dirs,
    _readJson: readJson,
    _nodeCount: nodeCount,
  };
}

module.exports = { createFileStore, HISTORY_LIMIT };
