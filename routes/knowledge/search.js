// routes/knowledge/search.js
//
// Поиск по тексту разделов ИТС (этап 3а PG-MIGRATION.md): слова запроса — по
// основам («фенола» найдёт «фенол»), по кускам разделов (chunks.js). От
// раздела — лучший кусок с выдержкой, где слова запроса выделены **так**.
//
// Запрос — как в поисковике (websearch_to_tsquery): «"оксид этилена"» —
// фразой, «or» — или, «-слово» — без него. Только PostgreSQL.
//
// Сначала ищутся куски со всеми словами. Вопрос обычным языком («расходные
// нормы сырья на тонну этилена») целиком в одном куске почти не встречается,
// поэтому, если таких мало, добираем куски с частью слов — чем больше слов,
// тем выше (match: "some" у таких результатов).
//
// Фильтр по продукту — разделы, связанные с ним (те же ключи названий, что
// у источников продукта), направление — «вверх» (где его получают) или
// «вниз» (где он сырьё). Заменённые издания не ищутся, как и в источниках.

const localStore = require("../local-sources/utils/store");
const { marks } = require("../../db/sql");

const HEADLINE =
  "StartSel=**, StopSel=**, MaxWords=35, MinWords=12, MaxFragments=2, FragmentDelimiter=\" … \"";

/**
 * @param conn  адаптер PostgreSQL (db/sql.js)
 * @param q     запрос
 * @returns [{ sectionId, docId, docTitle, title, pages, page, url, excerpt,
 *             summary, rank, matches, chunk, match: "all" | "some" }]
 */
async function searchSections(conn, q, { limit = 10, product = "", direction = null } = {}) {
  const all = await searchPass(conn, q, { limit, product, direction });
  // «-слово» в запросе: с «или» оно значило бы «или без слова» — не добираем.
  if (all.length >= limit || /(^|\s)-\S/.test(q)) return all;
  // Основы слов запроса (без служебных): одно слово — добирать нечего.
  const terms = (
    await conn.all("SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('russian'::regconfig, ?))) AS l", q)
  ).map((r) => r.l);
  if (terms.length < 2) return all;
  const seen = new Set(all.map((r) => r.sectionId));
  const some = (await searchPass(conn, q, { limit: limit + all.length, product, direction, terms }))
    .filter((r) => !seen.has(r.sectionId))
    .slice(0, limit - all.length)
    .map((r) => ({ ...r, match: "some" }));
  return [...all, ...some];
}

/**
 * Один проход поиска. terms — проход «с частью слов»: связки «и» запроса
 * заменены на «или» (фразы в кавычках остаются фразами), и выше тот кусок,
 * где больше разных слов запроса, а не тот, где одно повторено много раз.
 */
async function searchPass(conn, q, { limit, product, direction, terms = null }) {
  const loose = Boolean(terms);
  const old = [...(await localStore.supersededDocs(conn)).keys()];
  const notOld = old.length ? `AND s.doc_id NOT IN (${marks(old)})` : "";
  let byProduct = "";
  let productParams = [];
  if (product) {
    const keys = localStore.productKeys(product);
    if (!keys.length) return [];
    byProduct = `AND c.section_id IN (SELECT section_id FROM section_products
                   WHERE key IN (${marks(keys)})${direction ? " AND direction = ?" : ""})`;
    productParams = direction ? [...keys, direction] : keys;
  }
  // Сначала ранжирование по всем совпавшим кускам, выдержка (ts_headline —
  // дорогая) — только у лучших.
  const rows = await conn.all(
    `WITH q AS (SELECT ${
      loose
        ? "CAST(replace(CAST(websearch_to_tsquery('russian'::regconfig, ?) AS text), ' & ', ' | ') AS tsquery)"
        : "websearch_to_tsquery('russian'::regconfig, ?)"
    } AS query),
     best AS (
       SELECT DISTINCT ON (c.section_id) c.section_id, c.ord,
              ${
                loose
                  ? `(SELECT COUNT(*) FROM unnest(CAST(? AS text[])) AS l
                      WHERE c.tsv @@ plainto_tsquery('simple'::regconfig, l)) + ts_rank_cd(c.tsv, q.query)`
                  : "ts_rank_cd(c.tsv, q.query)"
              } AS rank,
              CAST(COUNT(*) OVER (PARTITION BY c.section_id) AS INTEGER) AS matches
       FROM section_chunks c CROSS JOIN q
       JOIN sections s ON s.id = c.section_id
       WHERE c.tsv @@ q.query ${notOld} ${byProduct}
       ORDER BY c.section_id, rank DESC, c.ord
     ),
     top AS (SELECT * FROM best ORDER BY rank DESC, section_id LIMIT ?)
     SELECT top.section_id, top.ord, top.rank, top.matches,
            ts_headline('russian'::regconfig, c.text, q.query, '${HEADLINE}') AS excerpt,
            s.doc_id, s.title, s.full_title, s.page_from, s.page_to, s.summary,
            d.short_title, d.title AS doc_title, d.page_offset
     FROM top
     JOIN section_chunks c ON c.section_id = top.section_id AND c.ord = top.ord
     JOIN sections s ON s.id = top.section_id
     JOIN documents d ON d.id = s.doc_id
     CROSS JOIN q
     ORDER BY top.rank DESC, top.section_id`,
    q,
    ...(loose ? [terms] : []),
    ...old,
    ...productParams,
    limit,
  );
  return rows.map((r) => ({
    sectionId: r.section_id,
    docId: r.doc_id,
    docTitle: r.short_title || r.doc_title,
    title: r.full_title || r.title,
    pages: localStore.pageLabel(r.page_from, r.page_to, r.page_offset),
    page: r.page_from,
    url: `local-sources/documents/${r.doc_id}/file?section=${r.section_id}#page=${r.page_from}`,
    excerpt: r.excerpt,
    summary: r.summary || null,
    rank: Number(r.rank),
    matches: r.matches,
    chunk: r.ord,
    match: "all",
  }));
}

module.exports = { searchSections };
