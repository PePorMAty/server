// routes/local-sources/utils/store.js
//
// База источников на сервере.
//
// Источник — не файл, а запись: раздел документа («ИТС 18 · 2.1 Производство
// этилена · стр. 14–42») или источник, найденный моделью в интернете. Файл —
// только способ пополнить базу: загруженный PDF делится на разделы, модель
// разбирает каждый — что производят, из какого сырья, что получается попутно,
// — и раздел становится источником для этих продуктов:
//   «вверх» (из чего производят X) — раздел, где X производят;
//   «вниз» (что производят из X)   — раздел, где X идёт сырьём.
//
// Лежит в data/local-sources/ (в git не попадает, как и реестр ГИСП):
//   sources.sqlite — документы, разделы, их связи с продуктами и
//                    сохранённые веб-источники;
//   files/<sha256>.pdf — сами документы, чтобы открыть раздел на странице.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { stemName } = require("../../industry/utils/normalize");
const { identify, spellingsOf } = require("../../industry/utils/synonyms");
const { extractPdf } = require("./pdf");
const { buildUnits, documentTitles } = require("./structure");
const { productKey } = require("./query");

const DEFAULT_DIR = path.resolve(__dirname, "../../../data/local-sources");

/** Где лежит база. Переопределяется переменной окружения (тесты, общий диск). */
function baseDir() {
  return process.env.LOCAL_SOURCES_DIR || DEFAULT_DIR;
}

/** Сколько разделов отдаём продукту в одну сторону. */
const MAX_SECTIONS_PER_PRODUCT = 6;
/** Текст источника, пока модель раздел не разобрала, — начало раздела. */
const EXCERPT_CHARS = 2500;
/** Раздел «в работе» дольше этого — разбор умер вместе с процессом. */
const STALE_WORK_MS = 30 * 60 * 1000;

/** Версия расчёта ключей продуктов: сменилась — связи пересчитываются. */
const KEYS_VERSION = 2;

/** Греческие буквы и цифры в названии не различают продукты для поиска. */
const GREEK = new Set(["альф", "бет", "гамм", "дельт", "омег"]);

let db = null;
let openedDir = null;

function columns(conn, table) {
  return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

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
    -- Раздел документа — запись-источник.
    CREATE TABLE IF NOT EXISTS sections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ord         INTEGER NOT NULL,
      number      TEXT,
      title       TEXT NOT NULL,
      full_title  TEXT,
      path        TEXT NOT NULL DEFAULT '',
      page_from   INTEGER NOT NULL,
      page_to     INTEGER NOT NULL,
      text        TEXT NOT NULL,
      -- pending → working → done | failed
      status      TEXT NOT NULL DEFAULT 'pending',
      summary     TEXT,
      io          TEXT NOT NULL DEFAULT '[]',
      extracted   TEXT,
      model       TEXT,
      error       TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      claimed_by  INTEGER,
      claimed_at  TEXT,
      decoded_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS sections_doc ON sections(doc_id, ord);
    CREATE INDEX IF NOT EXISTS sections_status ON sections(status);
    -- Связь раздела с продуктом. key — основы слов названия («оксид этилен»):
    -- по ним сходятся падежи и написания из справочника.
    CREATE TABLE IF NOT EXISTS section_products (
      section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      label       TEXT NOT NULL,
      direction   TEXT NOT NULL CHECK (direction IN ('up', 'down')),
      role        TEXT NOT NULL,
      origin      TEXT NOT NULL,
      PRIMARY KEY (section_id, key, direction)
    );
    CREATE INDEX IF NOT EXISTS section_products_key ON section_products(key, direction);
    -- Прежняя нарезка на фрагменты: её заменили разделы.
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS chunks;
  `);
  const have = columns(conn, "documents");
  const add = (name, type) => {
    if (!have.has(name)) conn.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
  };
  add("short_title", "TEXT");
  add("structure", "TEXT");
  add("page_offset", "INTEGER");
  add("provider", "TEXT");
  add("model", "TEXT");
  add("parsed_at", "TEXT");

  // Ключи продуктов считаются кодом (nameKeys). Поменялся расчёт — пересчитать
  // связи из сохранённых названий, иначе старые разделы перестали бы
  // находиться.
  conn.exec("CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT)");
  const version = conn.prepare("SELECT value FROM meta WHERE name = 'keys_version'").get()?.value;
  if (Number(version) !== KEYS_VERSION) {
    conn.transaction(() => {
      const links = conn
        .prepare("SELECT DISTINCT section_id, label, role, origin FROM section_products")
        .all();
      conn.exec("DELETE FROM section_products");
      for (const l of links) linkSection(conn, l.section_id, [l.label], l.role, l.origin);
      conn
        .prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('keys_version', ?)")
        .run(String(KEYS_VERSION));
    })();
  }
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
  conn.pragma("busy_timeout = 5000");
  conn.pragma("foreign_keys = ON");
  migrate(conn);
  db = conn;
  openedDir = dir;
  return db;
}

function filePath(sha256) {
  return path.join(baseDir(), "files", `${sha256}.pdf`);
}

// ---------------------------------------------------------------------------
// Продукты: ключи для сверки названий
// ---------------------------------------------------------------------------

/**
 * Окончание прилагательного, которое усечение оставило: «бутиловых спиртов»
 * усекается до «бутиловых спирт», а «бутиловый спирт» — до «бутилов спирт».
 */
const ADJ_TAIL = /(ыми|ими|ого|его|ому|ему|ых|их|ый|ий|ой|ая|яя|ое|ее|ые|ие|ым|им|ую|юю|ей)$/;

/**
 * Ключи названия: основы слов («оксида этилена» → «оксид этилен») и они же
 * без чисел и греческих букв («бутадиена-1,3» → «бутадиен») и без окончаний
 * прилагательных, плюс то же для главного имени из справочника.
 */
function nameKeys(name) {
  const keys = new Set();
  const add = (s) => {
    const k = stemName(String(s || "")).trim();
    if (!k) return;
    keys.add(k);
    const core = k
      .split(" ")
      .filter((w) => w && !/^\d+$/.test(w) && !GREEK.has(w))
      .map((w) => {
        const cut = w.replace(ADJ_TAIL, "");
        return cut.length >= 4 ? cut : w;
      })
      .join(" ");
    if (core && core !== k) keys.add(core);
  };
  add(name);
  const canon = identify(String(name || ""))?.canon;
  if (canon) add(canon);
  return [...keys];
}

/** Ключи продукта графа: по всем его написаниям из справочника. */
function productKeys(productName) {
  const keys = new Set();
  for (const sp of spellingsOf(productName)) {
    for (const k of nameKeys(sp)) keys.add(k);
  }
  return [...keys];
}

/**
 * Связать раздел с продуктами. Роль задаёт направление:
 *   product, byproduct — раздел о том, как их получают («вверх»);
 *   raw — они сырьё, раздел о том, что из них делают («вниз»);
 *   intermediate — промежуточный поток: получают и тут же перерабатывают.
 */
function linkSection(conn, sectionId, names, role, origin) {
  const dirs =
    role === "raw" ? ["down"] : role === "intermediate" ? ["up", "down"] : ["up"];
  // Связь из заголовка уступает связи от модели: у модели название в
  // именительном падеже («Этилен»), у заголовка — как в тексте («этилена»).
  // Между связями одного происхождения первая остаётся (целевой продукт
  // пишется раньше попутного).
  const stmt = conn.prepare(
    `INSERT INTO section_products (section_id, key, label, direction, role, origin)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (section_id, key, direction) DO UPDATE SET
       label = excluded.label, role = excluded.role, origin = excluded.origin
     WHERE section_products.origin = 'title' AND excluded.origin = 'model'`,
  );
  for (const name of names) {
    const label = String(name || "").trim();
    if (!label) continue;
    for (const key of nameKeys(label)) {
      for (const dir of dirs) stmt.run(sectionId, key, label, dir, role, origin);
    }
  }
}

// ---------------------------------------------------------------------------
// Документы
// ---------------------------------------------------------------------------

function docRow(d) {
  return {
    id: d.id,
    fileName: d.file_name,
    title: d.title,
    shortTitle: d.short_title || null,
    pages: d.pages,
    textlessPages: d.textless,
    chars: d.chars,
    bytes: d.bytes,
    addedAt: d.added_at,
    addedVia: d.added_via,
    structure: d.structure || null,
    model: d.model || null,
    sections: {
      total: d.s_total ?? 0,
      done: d.s_done ?? 0,
      failed: d.s_failed ?? 0,
      pending: (d.s_pending ?? 0) + (d.s_working ?? 0),
    },
  };
}

const DOC_SELECT = `
  SELECT d.*,
    (SELECT COUNT(*) FROM sections s WHERE s.doc_id = d.id) AS s_total,
    (SELECT COUNT(*) FROM sections s WHERE s.doc_id = d.id AND s.status = 'done') AS s_done,
    (SELECT COUNT(*) FROM sections s WHERE s.doc_id = d.id AND s.status = 'failed') AS s_failed,
    (SELECT COUNT(*) FROM sections s WHERE s.doc_id = d.id AND s.status = 'pending') AS s_pending,
    (SELECT COUNT(*) FROM sections s WHERE s.doc_id = d.id AND s.status = 'working') AS s_working
  FROM documents d`;

/** Разделы документа из текста: удалить прежние, записать новые (к разбору). */
function writeSections(conn, docId, units) {
  conn.prepare("DELETE FROM sections WHERE doc_id = ?").run(docId);
  const insert = conn.prepare(
    `INSERT INTO sections (doc_id, ord, number, title, full_title, path, page_from, page_to, text, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  );
  for (const u of units) {
    const id = insert.run(
      docId,
      u.ord,
      u.number,
      u.title,
      u.fullTitle,
      u.path || "",
      u.pageFrom,
      u.pageTo,
      u.text,
    ).lastInsertRowid;
    // Пока модель раздел не разобрала, продукт из заголовка «Производство
    // X» уже знаем: раздел — источник для X «вверх».
    linkSection(conn, Number(id), u.titleProducts || [], "product", "title");
  }
}

/** Прочитать PDF и разбить на разделы. */
async function parseDocument(buf, fileName) {
  const doc = await extractPdf(buf);
  const chars = doc.pages.reduce((sum, p) => sum + p.text.length, 0);
  if (chars < 50) {
    throw new Error(
      "В PDF нет текста — похоже, это скан. Сканы пока не распознаём: нужен PDF с текстом.",
    );
  }
  const { structure, offset, units } = buildUnits(doc);
  const titles = documentTitles({ ...doc, fileName });
  return { doc, chars, structure, offset, units, titles };
}

/**
 * Добавить документ в базу.
 *
 * Тот же файл второй раз не добавляется (сравниваем по содержимому, а не по
 * имени): возвращаем уже лежащий документ с duplicate: true.
 *
 * Разделы записываются сразу, разбор моделью идёт потом, в фоне (decode.js).
 *
 * @param buf     содержимое PDF
 * @param opts    { fileName, via: "ui" | "script", provider, model }
 * @returns { document, duplicate, warnings: string[] }
 */
async function addDocument(
  buf,
  { fileName = "document.pdf", via = "ui", provider = null, model = null } = {},
) {
  const conn = getDb();
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const existing = conn.prepare(`${DOC_SELECT} WHERE d.sha256 = ?`).get(sha256);
  if (existing) {
    return { document: docRow(existing), duplicate: true, warnings: [] };
  }

  const { doc, chars, structure, offset, units, titles } = await parseDocument(buf, fileName);

  const warnings = [];
  if (doc.textlessPages.length) {
    warnings.push(
      `Без текста ${doc.textlessPages.length} стр. из ${doc.pages.length} (${doc.textlessPages.slice(0, 10).join(", ")}${doc.textlessPages.length > 10 ? "…" : ""}) — вероятно, это сканы или рисунки; их содержимое в базу не попадёт.`,
    );
  }
  if (structure === "pages") {
    warnings.push(
      "Разметки не нашлось (ни закладок, ни содержания со ссылками, ни нумерованных заголовков) — документ разбит на куски по 10 страниц.",
    );
  }

  fs.writeFileSync(filePath(sha256), buf);
  const now = new Date().toISOString();
  const docId = conn.transaction(() => {
    const id = Number(
      conn
        .prepare(
          `INSERT INTO documents (sha256, file_name, title, short_title, pages, textless, chars, bytes,
             added_at, added_via, structure, page_offset, provider, model, parsed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sha256,
          fileName,
          titles.title,
          titles.short,
          doc.pages.length,
          doc.textlessPages.length,
          chars,
          buf.length,
          now,
          via,
          structure,
          offset,
          provider,
          model,
          now,
        ).lastInsertRowid,
    );
    writeSections(conn, id, units);
    return id;
  })();

  return {
    document: docRow(conn.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(docId)),
    duplicate: false,
    warnings,
  };
}

/**
 * Документы, загруженные до разделов (были только фрагменты), — разобрать
 * заново из сохранённого файла. Возвращает, сколько разобрано.
 */
async function reparseLegacyDocuments() {
  const conn = getDb();
  const legacy = conn.prepare("SELECT * FROM documents WHERE parsed_at IS NULL").all();
  let n = 0;
  for (const d of legacy) {
    try {
      const buf = fs.readFileSync(filePath(d.sha256));
      const { structure, offset, units, titles } = await parseDocument(buf, d.file_name);
      conn.transaction(() => {
        conn
          .prepare(
            `UPDATE documents SET title = ?, short_title = ?, structure = ?, page_offset = ?, parsed_at = ?
             WHERE id = ?`,
          )
          .run(titles.title, titles.short, structure, offset, new Date().toISOString(), d.id);
        writeSections(conn, d.id, units);
      })();
      n++;
    } catch (e) {
      console.error(`[local-sources] разбор «${d.file_name}» заново: ${e.message}`);
      conn
        .prepare("UPDATE documents SET parsed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), d.id);
    }
  }
  return n;
}

/** Все документы, новые сверху, со счётом разделов по состоянию разбора. */
function listDocuments() {
  return getDb().prepare(`${DOC_SELECT} ORDER BY d.id DESC`).all().map(docRow);
}

/** Документ по id с путём к файлу, или null. */
function getDocument(id) {
  const d = getDb().prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  return d ? { ...docRow(d), filePath: filePath(d.sha256) } : null;
}

/** Удалить документ, его разделы и файл. Возвращает true, если было что удалять. */
function deleteDocument(id) {
  const conn = getDb();
  const d = conn.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  if (!d) return false;
  conn.transaction(() => {
    conn
      .prepare(
        "DELETE FROM section_products WHERE section_id IN (SELECT id FROM sections WHERE doc_id = ?)",
      )
      .run(id);
    conn.prepare("DELETE FROM sections WHERE doc_id = ?").run(id);
    conn.prepare("DELETE FROM documents WHERE id = ?").run(id);
  })();
  fs.rmSync(filePath(d.sha256), { force: true });
  return true;
}

function parseList(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** «стр. 14–42» — печатными номерами, если сдвиг известен. */
function pageLabel(from, to, offset) {
  const off = Number.isInteger(offset) ? offset : 0;
  const a = from - off >= 1 ? from - off : from;
  const b = to - off >= 1 ? to - off : to;
  return a === b ? `стр. ${a}` : `стр. ${a}–${b}`;
}

/** Разделы документа с их продуктами — для списка в интерфейсе. */
function listSections(docId) {
  const conn = getDb();
  const doc = conn.prepare("SELECT page_offset FROM documents WHERE id = ?").get(docId);
  if (!doc) return null;
  const links = conn
    .prepare(
      `SELECT sp.section_id, sp.label, sp.direction, sp.role, sp.origin
       FROM section_products sp JOIN sections s ON s.id = sp.section_id
       WHERE s.doc_id = ?
       ORDER BY CASE sp.role WHEN 'product' THEN 0 WHEN 'byproduct' THEN 1
                             WHEN 'intermediate' THEN 2 ELSE 3 END, sp.rowid`,
    )
    .all(docId);
  // Названия — от модели; пока модель раздел не разобрала — из заголовка
  // («этилена» в родительном падеже — ключ для поиска, а не подпись).
  const byId = new Map();
  for (const l of links) {
    if (!byId.has(l.section_id)) {
      byId.set(l.section_id, {
        model: { up: new Set(), down: new Set() },
        title: { up: new Set(), down: new Set() },
      });
    }
    byId.get(l.section_id)[l.origin === "model" ? "model" : "title"][l.direction].add(l.label);
  }
  const labels = (id, dir) => {
    const e = byId.get(id);
    if (!e) return [];
    return [...(e.model[dir].size ? e.model[dir] : e.title[dir])];
  };
  return conn
    .prepare(
      `SELECT id, ord, number, title, full_title, path, page_from, page_to, status, summary,
              model, error, decoded_at, length(text) AS chars
       FROM sections WHERE doc_id = ? ORDER BY ord`,
    )
    .all(docId)
    .map((s) => ({
      id: s.id,
      number: s.number,
      title: s.full_title || s.title,
      path: s.path,
      pageFrom: s.page_from,
      pageTo: s.page_to,
      pages: pageLabel(s.page_from, s.page_to, doc.page_offset),
      chars: s.chars,
      status: s.status,
      summary: s.summary,
      model: s.model,
      error: s.error,
      decodedAt: s.decoded_at,
      products: { up: labels(s.id, "up"), down: labels(s.id, "down") },
    }));
}

// ---------------------------------------------------------------------------
// Очередь разбора моделью
// ---------------------------------------------------------------------------

/**
 * Взять следующий раздел в разбор. Атомарно: скрипт загрузки и сервер
 * могут разбирать одновременно и не возьмут один раздел дважды.
 */
function claimSection(worker = process.pid) {
  const conn = getDb();
  const row = conn
    .prepare(
      `UPDATE sections
       SET status = 'working', claimed_by = ?, claimed_at = ?, attempts = attempts + 1
       WHERE id = (SELECT id FROM sections WHERE status = 'pending' ORDER BY doc_id, ord LIMIT 1)
       RETURNING *`,
    )
    .get(worker, new Date().toISOString());
  if (!row) return null;
  const doc = conn.prepare("SELECT * FROM documents WHERE id = ?").get(row.doc_id);
  return { section: row, document: doc };
}

/** Раздел разобран: описание, продукты и связи от модели. */
function finishSection(id, result, model) {
  const conn = getDb();
  conn.transaction(() => {
    conn
      .prepare(
        `UPDATE sections SET status = 'done', summary = ?, io = ?, extracted = ?, model = ?,
           error = NULL, decoded_at = ?, claimed_by = NULL
         WHERE id = ?`,
      )
      .run(
        result.summary,
        JSON.stringify(result.io || []),
        JSON.stringify(result.extracted || {}),
        model || null,
        new Date().toISOString(),
        id,
      );
    conn.prepare("DELETE FROM section_products WHERE section_id = ? AND origin = 'model'").run(id);
    linkSection(conn, id, result.products || [], "product", "model");
    linkSection(conn, id, result.byproducts || [], "byproduct", "model");
    linkSection(conn, id, result.intermediates || [], "intermediate", "model");
    linkSection(conn, id, result.raw || [], "raw", "model");
  })();
}

function failSection(id, message) {
  getDb()
    .prepare(
      "UPDATE sections SET status = 'failed', error = ?, claimed_by = NULL WHERE id = ?",
    )
    .run(String(message || "ошибка").slice(0, 1000), id);
}

/** Разобрать заново: упавшие или все разделы документа. */
function requeue(docId, { only = "failed", provider, model } = {}) {
  const conn = getDb();
  if (provider !== undefined || model !== undefined) {
    conn
      .prepare("UPDATE documents SET provider = COALESCE(?, provider), model = COALESCE(?, model) WHERE id = ?")
      .run(provider || null, model || null, docId);
  }
  const where = only === "all" ? "status IN ('done', 'failed')" : "status = 'failed'";
  return conn
    .prepare(
      `UPDATE sections SET status = 'pending', error = NULL, attempts = 0 WHERE doc_id = ? AND ${where}`,
    )
    .run(docId).changes;
}

/**
 * Разделы «в работе», чей разбор умер вместе с процессом (перезапуск
 * сервера, прерванный скрипт), — снова в очередь.
 */
function resetStale() {
  const conn = getDb();
  const rows = conn
    .prepare("SELECT id, claimed_by, claimed_at FROM sections WHERE status = 'working'")
    .all();
  const alive = (pid) => {
    if (!pid || pid === process.pid) return pid === process.pid;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const now = Date.now();
  const reset = conn.prepare("UPDATE sections SET status = 'pending', claimed_by = NULL WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    const old = now - Date.parse(r.claimed_at || 0) > STALE_WORK_MS;
    if (old || !alive(r.claimed_by)) {
      reset.run(r.id);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Источники продукта
// ---------------------------------------------------------------------------

/** Раздел — в виде источника, понятного остальному приложению (TechnologySource). */
function sectionSource(r) {
  const doc = r.short_title || r.doc_title;
  const pages = pageLabel(r.page_from, r.page_to, r.page_offset);
  const excerpt =
    r.text.length > EXCERPT_CHARS ? `${r.text.slice(0, EXCERPT_CHARS)}…` : r.text;
  return {
    origin: "local",
    docId: r.doc_id,
    sectionId: r.id,
    page: r.page_from,
    title: r.full_title || r.title,
    docTitle: doc,
    pages,
    // Номер раздела — в адресе: у разделов одного документа файл один, и
    // без него клиент (он сравнивает адреса без #page) склеил бы их в один.
    url: `local-sources/documents/${r.doc_id}/file?section=${r.id}#page=${r.page_from}`,
    access_hint: `${doc}, ${pages}${r.status === "done" ? "" : " — модель раздел ещё не разобрала"}`,
    technology_description: r.summary || excerpt,
    inputs_outputs_hint: parseList(r.io),
    evidence_snippets: [],
  };
}

/**
 * Разделы-источники продукта в направлении: «вверх» — где его производят
 * (целевой продукт первым, потом попутный), «вниз» — где он сырьё.
 */
function sourcesFor(productName, direction, { limit = MAX_SECTIONS_PER_PRODUCT } = {}) {
  const keys = productKeys(productName);
  if (!keys.length) return [];
  const dir = direction === "up" ? "up" : "down";
  const marks = keys.map(() => "?").join(",");
  // «Вниз» — только где продукт сырьё, а не там, где его самого производят.
  const notProduced =
    dir === "down"
      ? `AND s.id NOT IN (SELECT section_id FROM section_products
                          WHERE direction = 'up' AND role = 'product' AND key IN (${marks}))`
      : "";
  return getDb()
    .prepare(
      `SELECT s.*, d.title AS doc_title, d.short_title, d.page_offset,
              MIN(CASE sp.role WHEN 'product' THEN 0 WHEN 'byproduct' THEN 1
                               WHEN 'intermediate' THEN 2 ELSE 3 END) AS rank,
              MAX(sp.origin = 'model') AS by_model
       FROM section_products sp
       JOIN sections s ON s.id = sp.section_id
       JOIN documents d ON d.id = s.doc_id
       WHERE sp.direction = ? AND sp.key IN (${marks}) ${notProduced}
       GROUP BY s.id
       ORDER BY rank, by_model DESC, d.id, s.ord
       LIMIT ?`,
    )
    .all(dir, ...keys, ...(dir === "down" ? keys : []), limit)
    .map(sectionSource);
}

/**
 * Сколько источников у продукта: разделов документов (всего и по
 * направлениям) и сохранённых веб-источников. Для всего графа разом — как
 * опознание продуктов.
 */
function countsFor(productName) {
  const conn = getDb();
  const keys = productKeys(productName);
  const localDir = { up: 0, down: 0 };
  let local = 0;
  if (keys.length) {
    const marks = keys.map(() => "?").join(",");
    for (const r of conn
      .prepare(
        `SELECT direction, COUNT(DISTINCT section_id) AS n FROM section_products
         WHERE key IN (${marks}) GROUP BY direction`,
      )
      .all(...keys)) {
      localDir[r.direction] = r.n;
    }
    local = conn
      .prepare(
        `SELECT COUNT(DISTINCT section_id) AS n FROM section_products WHERE key IN (${marks})`,
      )
      .get(...keys).n;
  }
  const web = { up: 0, down: 0 };
  for (const r of conn
    .prepare(
      "SELECT direction, COUNT(*) AS n FROM web_sources WHERE product_key = ? GROUP BY direction",
    )
    .all(productKey(productName))) {
    web[r.direction] = r.n;
  }
  return { local, localDir, web };
}

// ---------------------------------------------------------------------------
// Веб-источники, найденные моделью
// ---------------------------------------------------------------------------

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

/**
 * Сохранённые веб-источники продукта в направлении: свежие поиски первыми,
 * внутри одного поиска — в том порядке, в каком их дала модель.
 */
function webSourcesFor(productName, direction) {
  return getDb()
    .prepare(
      `SELECT * FROM web_sources WHERE product_key = ? AND direction = ?
       ORDER BY found_at DESC, id ASC`,
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

/** Сводка базы — для страницы состояния и скрипта. */
function stats() {
  const conn = getDb();
  const byStatus = {};
  for (const r of conn.prepare("SELECT status, COUNT(*) AS n FROM sections GROUP BY status").all()) {
    byStatus[r.status] = r.n;
  }
  return {
    documents: conn.prepare("SELECT COUNT(*) AS n FROM documents").get().n,
    sections: byStatus,
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
  reparseLegacyDocuments,
  listDocuments,
  getDocument,
  deleteDocument,
  listSections,
  claimSection,
  finishSection,
  failSection,
  requeue,
  resetStale,
  sourcesFor,
  countsFor,
  saveWebSources,
  webSourcesFor,
  productKeys,
  nameKeys,
  stats,
  close,
};
