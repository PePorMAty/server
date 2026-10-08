// routes/material-balance/utils/sources.js
//
// Серверная проверка источников ответа — как в примечании заказчика к
// промпту: сервер загружает каждый документ по указанному URL, проверяет,
// что получен полный материал и в нём есть нужные данные, и сохраняет
// оригинал и извлечённый текст. saved назначает только сервер и только
// после сохранения; не получилось — failed с причиной, и модель во втором
// запросе заменяет такой источник.
//
// «Нужные данные» — числа из таблицы источника «Данные для материального
// баланса» (исходные значения до пересчёта). Хотя бы одно нашлось в тексте
// — источник подтверждён; ни одного — failed: модель взяла цифры не отсюда
// или страница не та. Таблицы нет — проверяем только, что текст читается.
//
// Документы базы источников (local://) не загружаются: они уже на сервере.

const { fetchSource, SourceError } = require("./fetch-source");
const { parseLocalUrl } = require("./local");
const store = require("./store");

const CONCURRENCY = 4;
/** Сколько дней сохранённая копия годится без повторной загрузки. */
const REUSE_DAYS = 30;

/** Строки таблицы «Данные для материального баланса» блока источника. */
function dataValues(block) {
  const lines = String(block || "").split(/\r?\n/);
  const at = lines.findIndex((l) => /данные для материального баланса/i.test(l));
  if (at < 0) return [];
  const rows = [];
  let header = null;
  for (const line of lines.slice(at + 1)) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      if (rows.length || header) break;
      continue;
    }
    const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => c.replace(/\*\*/g, "").trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || !c)) continue;
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    rows.push(cells);
  }
  if (!header) return [];
  const col = header.findIndex((h) => h.includes("значен"));
  return rows.map((r) => r[col >= 0 ? col : 1] || "").filter((v) => /\d/.test(v));
}

/** Текст для поиска чисел: «1 000» → «1000», «0,82» → «0.82». */
function numericText(text) {
  return String(text || "")
    .replace(/(\d)[\s  ](?=\d{3}(?!\d))/g, "$1")
    .replace(/(\d),(\d)/g, "$1.$2");
}

/** Числа ячейки: «0,82», «450–600», «≈82 %» → ["0.82"], ["450", "600"], ["82"]. */
function numbersOf(cell) {
  return [...numericText(cell).matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

/** Есть ли число в тексте отдельным числом (не частью другого). */
function hasNumber(haystack, num) {
  const esc = num.replace(".", "\\.");
  const variants = [esc];
  // «0.820» в тексте и «0,82» в таблице — одно число.
  if (num.includes(".")) variants.push(`${esc}0+`);
  // Не часть другого числа: рядом ни цифры, ни дробной части («1868,5»).
  return new RegExp(`(?<![\\d.])(?:${variants.join("|")})(?![\\d]|\\.\\d)`).test(haystack);
}

/** Какие значения таблицы нашлись в тексте. */
function valueCheck(text, values) {
  const hay = numericText(text);
  const found = [];
  const missing = [];
  for (const v of values) {
    const nums = numbersOf(v).filter((n) => Number(n) !== 0);
    if (!nums.length) continue;
    (nums.some((n) => hasNumber(hay, n)) ? found : missing).push(v);
  }
  return { found, missing };
}

/** Проверить один веб-источник: копия из базы или загрузка, числа, сохранение. */
async function checkWeb(src, { signal }) {
  const values = dataValues(src.block);
  let doc = store.recentWebDocument(src.url, REUSE_DAYS);
  if (!doc) {
    let got;
    try {
      got = await fetchSource(src.url, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      return { status: "failed", reason: e instanceof SourceError ? e.message : `ошибка загрузки: ${e.message}` };
    }
    doc = store.saveWebDocument({ url: src.url, ...got });
  }
  const text = store.webDocumentText(doc.id);
  const { found, missing } = valueCheck(text, values);
  const base = { documentId: `web-${doc.id}`, webDocumentId: doc.id, kind: doc.kind, finalUrl: doc.final_url };
  if (values.length && !found.length) {
    return {
      ...base,
      status: "failed",
      reason: `документ загружен, но в его тексте нет значений из таблицы источника (${missing.slice(0, 4).join("; ")})`,
    };
  }
  return {
    ...base,
    status: "saved",
    note: values.length
      ? `в тексте найдено значений таблицы: ${found.length} из ${found.length + missing.length}`
      : "таблицы значений нет — проверено только, что текст читается",
  };
}

/**
 * Проверить источники ответа. sources — parsed.sources; previous — прошлые
 * результаты по адресу (второй круг не грузит то же самое заново).
 * onProgress(done, total) — для хода расчёта.
 *
 * Возвращает [{ ref, url, status: "saved" | "failed" | "local", reason?,
 * note?, documentId?, webDocumentId?, local? }] в порядке источников.
 */
async function checkSources(sources, { signal, onProgress, previous = new Map() } = {}) {
  const out = sources.map((s) => {
    const local = parseLocalUrl(s.url);
    if (local) return { ref: s.id, url: s.url, status: "local", documentId: `local-${local.sectionId}`, local };
    if (!/^https?:\/\//i.test(s.url || "")) {
      return { ref: s.id, url: s.url || "", status: "failed", reason: "нет адреса документа" };
    }
    return null;
  });
  const todo = sources.map((s, i) => ({ s, i })).filter(({ i }) => !out[i]);
  let done = 0;
  onProgress?.(0, todo.length);
  const queue = [...todo];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { s, i } = item;
      const prev = previous.get(s.url);
      const res = prev && prev.status === "saved" ? prev : await checkWeb(s, { signal });
      out[i] = { ref: s.id, url: s.url, ...res };
      onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  return out;
}

/** Строки SERVER_SOURCE_CHECKS по результатам проверки. */
function checkLines(checks) {
  return checks
    .filter((c) => c.status !== "local")
    .map((c) =>
      c.status === "saved"
        ? `- source_id: ${c.ref}; URL: ${c.finalUrl || c.url}; status: saved; server_document_id: ${c.documentId}`
        : `- source_id: ${c.ref}; URL: ${c.url}; status: failed; причина: ${c.reason}`,
    );
}

/** Положить итоги проверки в источники разобранного ответа. */
function applyChecks(parsed, checks, rounds) {
  parsed.sources = parsed.sources.map((s, i) => {
    const c = checks[i];
    if (!c) return s;
    return {
      ...s,
      server: {
        status: c.status,
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.note ? { note: c.note } : {}),
        ...(c.documentId ? { documentId: c.documentId } : {}),
        ...(c.webDocumentId ? { webDocumentId: c.webDocumentId } : {}),
        ...(c.kind ? { kind: c.kind } : {}),
      },
      ...(c.local ? { local: c.local, url: `local-sources/documents/${c.local.docId}/file?section=${c.local.sectionId}#page=${c.local.page ?? 1}` } : {}),
    };
  });
  const count = (st) => checks.filter((c) => c?.status === st).length;
  parsed.sourceChecks = { rounds, saved: count("saved"), failed: count("failed"), local: count("local") };
  return parsed;
}

module.exports = { checkSources, checkLines, applyChecks, dataValues, valueCheck };
