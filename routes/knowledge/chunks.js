// routes/knowledge/chunks.js
//
// Куски разделов ИТС — для поиска по тексту (этап 3а PG-MIGRATION.md), а
// дальше и по смыслу (3в: вектор у куска).
//
// Раздел ИТС — до 70 тыс. знаков: целиком он не годится ни поиску (найдёт
// раздел, но не место), ни модели (не влезет в запрос). Режем на куски около
// CHUNK_SIZE знаков. Текст раздела — строки PDF по ~40 знаков без абзацев,
// поэтому кусок набирается из строк и рвётся на конце предложения; соседние
// куски перекрываются хвостом, чтобы фраза на стыке нашлась целиком.
//
// Первый кусок раздела (ord 0) — его краткое содержание от модели разбора,
// если оно есть: в нём главное о разделе своими словами.
//
// Только PostgreSQL (app.section_chunks, миграция 003_knowledge.sql). Куски
// производные: пересобираются, когда раздел записан или разобран заново, а
// при запуске сервера достраиваются у разделов, где их нет.

const crypto = require("crypto");

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
/**
 * Версия нарезки: поменяли правила — куски всех разделов пересобираются при
 * запуске сервера (отметка в app.sources_meta).
 */
const CHUNK_VERSION = 1;

/** Строка кончается предложением (или это пустая строка) — здесь можно рвать. */
const SENTENCE_END = /[.!?:;»)]\s*$|^\s*$/;

/** Слишком длинная строка (таблица, склеенный абзац) — по предложениям, потом по словам. */
function splitLong(line, size) {
  if (line.length <= size) return [line];
  const out = [];
  let rest = line;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(". ", size);
    if (cut < size / 2) cut = rest.lastIndexOf(" ", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/**
 * Текст → куски около size знаков: [строки кусков]. Пустой текст — [].
 */
function chunkText(text, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((l) => splitLong(l, size));
  const chunks = [];
  let cur = [];
  let len = 0;
  // Есть ли в cur строки, которых ещё нет ни в одном куске (не только хвост).
  let fresh = false;
  const flush = () => {
    const body = cur.join("\n").trim();
    if (body) chunks.push(body);
    // Хвост — в начало следующего: последние строки до overlap знаков.
    const tail = [];
    let tl = 0;
    for (let i = cur.length - 1; i >= 0 && tl + cur[i].length <= overlap; i--) {
      tail.unshift(cur[i]);
      tl += cur[i].length + 1;
    }
    cur = tail;
    len = tl;
    fresh = false;
  };
  for (const line of lines) {
    // С этой строкой кусок вышел бы больше полутора размеров — сначала
    // закрыть его.
    if (fresh && len + line.length + 1 > size * 1.5) flush();
    cur.push(line);
    len += line.length + 1;
    fresh = true;
    // Рвём на конце предложения, когда кусок набрал своё; без конца
    // предложения — не дальше чем в полтора раза.
    if ((len >= size * 0.8 && SENTENCE_END.test(line)) || len >= size * 1.5) flush();
  }
  // Остаток без новых строк — это хвост, он уже в предыдущем куске.
  const body = cur.join("\n").trim();
  if (body && fresh) chunks.push(body);
  return chunks;
}

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

/** Есть ли таблица кусков (миграция 003 применена) — один раз на пул. */
const ready = new Map();
async function chunksReady(conn) {
  if (conn.dialect !== "pg") return false;
  const key = conn.pool;
  if (!ready.has(key)) {
    ready.set(
      key,
      conn
        .get("SELECT to_regclass('app.section_chunks') AS t")
        .then((r) => Boolean(r?.t))
        .catch(() => false),
    );
  }
  return ready.get(key);
}

/** Забыть, что таблица есть или нет (тесты после миграции). */
function resetChunksReady() {
  ready.clear();
}

/**
 * Пересобрать куски разделов. conn — адаптер db/sql.js (можно транзакция).
 * В SQLite и без миграции 003 — ничего не делает. Возвращает число кусков.
 */
async function rebuildSectionChunks(conn, sectionIds) {
  const ids = [...new Set((sectionIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length || !(await chunksReady(conn))) return 0;
  let n = 0;
  for (const id of ids) {
    const s = await conn.get(
      `SELECT s.id, s.title, s.full_title, s.text, s.summary, d.short_title, d.title AS doc_title
       FROM sections s JOIN documents d ON d.id = s.doc_id WHERE s.id = ?`,
      id,
    );
    await conn.run("DELETE FROM section_chunks WHERE section_id = ?", id);
    if (!s) continue;
    const heading = `${s.short_title || s.doc_title} · ${s.full_title || s.title}`;
    const parts = [];
    if (s.summary) parts.push(`Краткое содержание раздела: ${s.summary}`);
    parts.push(...chunkText(s.text));
    for (let ord = 0; ord < parts.length; ord++) {
      await conn.run(
        "INSERT INTO section_chunks (section_id, ord, heading, text, hash) VALUES (?, ?, ?, ?, ?)",
        id,
        ord,
        heading,
        parts[ord],
        sha1(parts[ord]),
      );
    }
    n += parts.length;
  }
  return n;
}

/**
 * При запуске сервера: куски у разделов, где их нет (раздел записан до
 * миграции 003 или прежним кодом), и у всех — если сменились правила
 * нарезки. Возвращает { sections, chunks } — сколько пересобрано.
 */
async function ensureSectionChunks(conn) {
  if (!(await chunksReady(conn))) return null;
  const version = (await conn.get("SELECT value FROM sources_meta WHERE name = 'chunks_version'"))?.value;
  const all = Number(version) !== CHUNK_VERSION;
  const rows = await conn.all(
    all
      ? "SELECT id FROM sections ORDER BY id"
      : `SELECT s.id FROM sections s
         WHERE NOT EXISTS (SELECT 1 FROM section_chunks c WHERE c.section_id = s.id) ORDER BY s.id`,
  );
  let chunks = 0;
  // По разделу в транзакции: долгая пересборка не держит блокировки разом.
  for (const r of rows) chunks += await conn.tx((t) => rebuildSectionChunks(t, [r.id]));
  await conn.run(
    `INSERT INTO sources_meta (name, value) VALUES ('chunks_version', ?)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
    String(CHUNK_VERSION),
  );
  return { sections: rows.length, chunks };
}

module.exports = {
  chunkText,
  rebuildSectionChunks,
  ensureSectionChunks,
  chunksReady,
  resetChunksReady,
  CHUNK_SIZE,
  CHUNK_VERSION,
};
