// routes/local-sources/utils/store.js
//
// Локальная база источников: PDF заказчика и источники, найденные моделью.
//
// Лежит в data/local-sources/ (в git не попадает, как и реестр ГИСП):
//   sources.sqlite — документы, фрагменты с индексом по основам слов и
//                    сохранённые веб-источники;
//   files/<sha256>.pdf — сами PDF, чтобы из карточки открыть страницу.
//
// PDF — «фиксированный» список: его загружает человек. Веб-источники копятся
// сами: каждый успешный поиск через модель дописывает найденное, и продукт в
// любом другом графе получает их без нового запроса.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { stemName } = require("../../industry/utils/normalize");
const { extractPdf } = require("./pdf");
const { chunkPages, guessTitle } = require("./chunks");
const { productMatch, productKey } = require("./query");

const DEFAULT_DIR = path.resolve(__dirname, "../../../data/local-sources");

/** Где лежит база. Переопределяется переменной окружения (тесты, общий диск). */
function baseDir() {
  return process.env.LOCAL_SOURCES_DIR || DEFAULT_DIR;
}

/** Сколько документов отдаём продукту. Больше в обобщение шага не влезет. */
const MAX_DOCS_PER_PRODUCT = 5;
/** Сколько фрагментов документа склеиваем в текст источника. */
const CHUNKS_PER_DOC = 2;
/** Предел текста одного источника, знаков (обобщение режет до 2500). */
const SOURCE_TEXT_CHARS = 3000;

let db = null;
let openedDir = null;

function migrate(conn) {
  conn.exec(`
    -- AUTOINCREMENT: номер удалённого документа не достаётся новому. Ссылка
    -- на PDF в сохранённом графе иначе молча открыла бы чужой документ.
    CREATE TABLE IF NOT EXISTS documents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256      TEXT NOT NULL UNIQUE,
      file_name   TEXT NOT NULL,
      title       TEXT NOT NULL,
      pages       INTEGER NOT NULL,
      textless    INTEGER NOT NULL DEFAULT 0,
      chars       INTEGER NOT NULL,
      bytes       INTEGER NOT NULL,
      added_at    TEXT NOT NULL,
      added_via   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id      INTEGER PRIMARY KEY,
      doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page    INTEGER NOT NULL,
      text    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(stems);
    CREATE TABLE IF NOT EXISTS web_sources (
      id                      INTEGER PRIMARY KEY,
      product_key             TEXT NOT NULL,
      product_label           TEXT NOT NULL,
      direction               TEXT NOT NULL CHECK (direction IN ('up', 'down')),
      url                     TEXT NOT NULL,
      title                   TEXT NOT NULL DEFAULT '',
      access_hint             TEXT NOT NULL DEFAULT '',
      technology_description  TEXT NOT NULL DEFAULT '',
      inputs_outputs_hint     TEXT NOT NULL DEFAULT '[]',
      evidence_snippets       TEXT NOT NULL DEFAULT '[]',
      model                   TEXT,
      found_at                TEXT NOT NULL,
      UNIQUE (product_key, direction, url)
    );
  `);
}

/** Открыть базу (создать при первом обращении). */
function getDb() {
  const dir = baseDir();
  if (db && openedDir === dir) return db;
  if (db) {
    db.close();
    db = null;
  }
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  // Модуль требуем лениво: без базы источников сервер обязан подниматься.
  const Database = require("better-sqlite3");
  const conn = new Database(path.join(dir, "sources.sqlite"));
  // WAL: скрипт загрузки и сервер пишут в одну базу, не мешая друг другу.
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  migrate(conn);
  db = conn;
  openedDir = dir;
  return db;
}

function filePath(sha256) {
  return path.join(baseDir(), "files", `${sha256}.pdf`);
}

function docRow(d) {
  return {
    id: d.id,
    fileName: d.file_name,
    title: d.title,
    pages: d.pages,
    textlessPages: d.textless,
    chars: d.chars,
    bytes: d.bytes,
    chunks: d.chunks ?? undefined,
    addedAt: d.added_at,
    addedVia: d.added_via,
  };
}

/**
 * Добавить PDF в базу.
 *
 * Тот же файл второй раз не добавляется (сравниваем по содержимому, а не по
 * имени): возвращаем уже лежащий документ с duplicate: true.
 *
 * @param buf     содержимое PDF
 * @param opts    { fileName, via: "ui" | "script" }
 * @returns { document, duplicate, warnings: string[] }
 */
async function addDocument(buf, { fileName = "document.pdf", via = "ui" } = {}) {
  const conn = getDb();
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const existing = conn
    .prepare(
      "SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks FROM documents d WHERE sha256 = ?",
    )
    .get(sha256);
  if (existing) {
    return { document: docRow(existing), duplicate: true, warnings: [] };
  }

  const { metaTitle, pages, textlessPages } = await extractPdf(buf);
  const chunks = chunkPages(pages);
  const chars = pages.reduce((sum, p) => sum + p.text.length, 0);

  const warnings = [];
  if (!chunks.length) {
    throw new Error(
      "В PDF нет текста — похоже, это скан. Сканы пока не распознаём: нужен PDF с текстом.",
    );
  }
  if (textlessPages.length) {
    warnings.push(
      `Без текста ${textlessPages.length} стр. из ${pages.length} (${textlessPages.slice(0, 10).join(", ")}${textlessPages.length > 10 ? "…" : ""}) — вероятно, это сканы или рисунки; их содержимое в поиск не попадёт.`,
    );
  }

  const title = metaTitle || guessTitle(pages, fileName);
  fs.writeFileSync(filePath(sha256), buf);

  const insertDoc = conn.prepare(
    `INSERT INTO documents (sha256, file_name, title, pages, textless, chars, bytes, added_at, added_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertChunk = conn.prepare(
    "INSERT INTO chunks (doc_id, page, text) VALUES (?, ?, ?)",
  );
  const insertFts = conn.prepare(
    "INSERT INTO chunks_fts (rowid, stems) VALUES (?, ?)",
  );

  const docId = conn.transaction(() => {
    const id = insertDoc.run(
      sha256,
      fileName,
      title,
      pages.length,
      textlessPages.length,
      chars,
      buf.length,
      new Date().toISOString(),
      via,
    ).lastInsertRowid;
    for (const c of chunks) {
      const chunkId = insertChunk.run(id, c.page, c.text).lastInsertRowid;
      insertFts.run(chunkId, stemName(c.text));
    }
    return Number(id);
  })();

  return {
    document: docRow({
      id: docId,
      file_name: fileName,
      title,
      pages: pages.length,
      textless: textlessPages.length,
      chars,
      bytes: buf.length,
      chunks: chunks.length,
      added_at: new Date().toISOString(),
      added_via: via,
    }),
    duplicate: false,
    warnings,
  };
}

/** Все документы, новые сверху. */
function listDocuments() {
  return getDb()
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks
       FROM documents d ORDER BY d.id DESC`,
    )
    .all()
    .map(docRow);
}

/** Документ по id с путём к файлу, или null. */
function getDocument(id) {
  const d = getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id);
  return d ? { ...docRow(d), filePath: filePath(d.sha256) } : null;
}

/** Удалить документ, его фрагменты и файл. Возвращает true, если было что удалять. */
function deleteDocument(id) {
  const conn = getDb();
  const d = conn.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  if (!d) return false;
  conn.transaction(() => {
    conn
      .prepare(
        "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)",
      )
      .run(id);
    conn.prepare("DELETE FROM chunks WHERE doc_id = ?").run(id);
    conn.prepare("DELETE FROM documents WHERE id = ?").run(id);
  })();
  fs.rmSync(filePath(d.sha256), { force: true });
  return true;
}

/** Фрагменты, где встречается продукт, — лучшие по BM25 первыми. */
function matchingChunks(productName) {
  const match = productMatch(productName);
  if (!match) return [];
  try {
    return getDb()
      .prepare(
        `SELECT c.id, c.doc_id, c.page, c.text, bm25(chunks_fts) AS score
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score
         LIMIT 400`,
      )
      .all(match);
  } catch (e) {
    // Кривое выражение не должно ронять карточку продукта: без источников
    // из базы она работает как раньше.
    console.error(`[local-sources] поиск «${productName}»: ${e.message}`);
    return [];
  }
}

/**
 * PDF-источники продукта в виде, понятном остальному приложению
 * (TechnologySource): документ — источник, текст — лучшие его фрагменты.
 *
 * url — путь к файлу относительно API (клиент дописывает свой адрес сервера):
 * по нему человек открывает PDF на нужной странице.
 */
function localSourcesFor(productName, { limit = MAX_DOCS_PER_PRODUCT } = {}) {
  const rows = matchingChunks(productName);
  if (!rows.length) return [];

  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, []);
    byDoc.get(r.doc_id).push(r);
  }
  const conn = getDb();
  const docStmt = conn.prepare("SELECT * FROM documents WHERE id = ?");

  // Документ, где продукт встречается чаще, — вероятнее про него. При равенстве
  // решает лучший фрагмент.
  const ranked = [...byDoc.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[1][0].score - b[1][0].score,
  );

  return ranked.slice(0, limit).map(([docId, hits]) => {
    const doc = docStmt.get(docId);
    const best = hits
      .slice(0, CHUNKS_PER_DOC)
      .sort((a, b) => a.page - b.page || a.id - b.id);
    const pages = [...new Set(best.map((c) => c.page))];
    const text = best.map((c) => c.text).join("\n\n");
    return {
      origin: "local",
      docId,
      page: pages[0],
      title: doc.title,
      url: `local-sources/documents/${docId}/file#page=${pages[0]}`,
      access_hint: `PDF из локальной базы · стр. ${pages.join(", ")} · фрагментов с продуктом: ${hits.length}`,
      technology_description:
        text.length > SOURCE_TEXT_CHARS ? `${text.slice(0, SOURCE_TEXT_CHARS)}…` : text,
      inputs_outputs_hint: [],
      evidence_snippets: best.map((c) =>
        c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text,
      ),
      mentions: hits.length,
    };
  });
}

function parseList(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Сохранить источники, найденные моделью для продукта и направления.
 *
 * Повторно найденный URL обновляется (текст, модель, дата), новые
 * дописываются. Ошибку базы не пробрасываем: поиск уже удался, и
 * пользователь должен получить свои источники.
 */
function saveWebSources(productName, direction, items, model) {
  if (!Array.isArray(items) || !items.length) return 0;
  try {
    const conn = getDb();
    const key = productKey(productName);
    const stmt = conn.prepare(
      `INSERT INTO web_sources (product_key, product_label, direction, url, title, access_hint,
         technology_description, inputs_outputs_hint, evidence_snippets, model, found_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (product_key, direction, url) DO UPDATE SET
         product_label = excluded.product_label,
         title = excluded.title,
         access_hint = excluded.access_hint,
         technology_description = excluded.technology_description,
         inputs_outputs_hint = excluded.inputs_outputs_hint,
         evidence_snippets = excluded.evidence_snippets,
         model = excluded.model,
         found_at = excluded.found_at`,
    );
    const now = new Date().toISOString();
    let saved = 0;
    conn.transaction(() => {
      for (const it of items) {
        const url = String(it?.url || "").trim();
        if (!/^https?:\/\//i.test(url)) continue;
        stmt.run(
          key,
          String(productName),
          direction === "up" ? "up" : "down",
          url,
          String(it.title || ""),
          String(it.access_hint || ""),
          String(it.technology_description || ""),
          JSON.stringify(Array.isArray(it.inputs_outputs_hint) ? it.inputs_outputs_hint : []),
          JSON.stringify(Array.isArray(it.evidence_snippets) ? it.evidence_snippets : []),
          model || null,
          now,
        );
        saved++;
      }
    })();
    return saved;
  } catch (e) {
    console.error(`[local-sources] сохранение веб-источников «${productName}»: ${e.message}`);
    return 0;
  }
}

/** Сохранённые веб-источники продукта в направлении, свежие первыми. */
function webSourcesFor(productName, direction) {
  return getDb()
    .prepare(
      `SELECT * FROM web_sources WHERE product_key = ? AND direction = ?
       ORDER BY found_at DESC, id DESC`,
    )
    .all(productKey(productName), direction === "up" ? "up" : "down")
    .map((r) => ({
      origin: "web",
      title: r.title,
      url: r.url,
      access_hint: r.access_hint,
      technology_description: r.technology_description,
      inputs_outputs_hint: parseList(r.inputs_outputs_hint),
      evidence_snippets: parseList(r.evidence_snippets),
      savedAt: r.found_at,
      model: r.model || undefined,
    }));
}

/**
 * Сколько источников есть у продукта: PDF-документов (без направления) и
 * сохранённых веб-источников по направлениям. Для всего графа разом — как
 * опознание продуктов.
 */
function countsFor(productName) {
  const docs = new Set(matchingChunks(productName).map((r) => r.doc_id));
  const web = { up: 0, down: 0 };
  for (const r of getDb()
    .prepare(
      "SELECT direction, COUNT(*) AS n FROM web_sources WHERE product_key = ? GROUP BY direction",
    )
    .all(productKey(productName))) {
    web[r.direction] = r.n;
  }
  return { local: docs.size, web };
}

/** Сводка базы — для страницы состояния и скрипта. */
function stats() {
  const conn = getDb();
  return {
    documents: conn.prepare("SELECT COUNT(*) AS n FROM documents").get().n,
    chunks: conn.prepare("SELECT COUNT(*) AS n FROM chunks").get().n,
    webSources: conn.prepare("SELECT COUNT(*) AS n FROM web_sources").get().n,
    dir: baseDir(),
  };
}

/** Закрыть базу (скрипты и тесты). */
function close() {
  if (db) db.close();
  db = null;
  openedDir = null;
}

module.exports = {
  addDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  localSourcesFor,
  saveWebSources,
  webSourcesFor,
  countsFor,
  stats,
  close,
};
