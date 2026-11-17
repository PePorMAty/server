// routes/step/utils/searchHints.js
//
// Строки поиска в блоках обобщения (промпты v4).
//
// Поиск v4 (v4SearchBrief) отдаёт у каждого источника, кроме описания, строки
// стадий — «Маршрут R1 | Стадия S1 | industrial_status=… | Входы: […] |
// Выходы: […] | input_completeness=… | output_completeness=…» — и цитаты
// (evidence_snippets). Обобщение v4 на них рассчитано («приоритет
// доказательств: описание и цитаты, затем строки»), а до 2026-11-17 в блок шло
// только описание: строки, ~70 % ответа поиска, модель писала зря.
//
// Адрес источника и продукт поиска модель в строках больше не пишет — это
// треть их текста, а сервер знает и то и другое. Здесь они дописываются
// обратно, в формате, который ждёт обобщение v4: «… | Стадия S1 |
// source_id=url:<URL> | search_product=<продукт> | …». Продукт поиска — из
// первой строки описания («search_product: …»): источники бывают взяты у
// предка, и раскрываемый продукт тут не годится.
//
// Только у найденных в интернете. У разделов базы строки — сводка всего
// раздела («… → Капролактам»): с ней модель перепрыгивала ступени (фенол →
// капролактам, 2026-10-29); у них есть строка промежуточных продуктов.
//
// Прежние промпты (STEP_PROMPTS=legacy) строк не ждут — им блок как раньше.

const MAX_LINES = 8;
const MAX_QUOTES = 3;
const MAX_CHARS = 1500;

const isLocal = (s) => s?.origin === "local" || String(s?.url || "").startsWith("local-sources/");

/** Продукт поиска из первой строки описания: «search_product: Нейлон 6,6». */
function searchProductOf(source) {
  const m = /^\s*search_product:\s*(.+)$/im.exec(String(source?.technology_description || ""));
  return m ? m[1].trim() : "";
}

/**
 * Строка стадии — с адресом и продуктом поиска после «Стадия …», если модель
 * их не написала (прежний ответ поиска их уже содержит — тогда как есть).
 */
function fullLine(line, url, product) {
  const parts = String(line).split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const extra = [];
  if (url && !parts.some((p) => /^source_id=/i.test(p))) extra.push(`source_id=url:${url}`);
  if (product && !parts.some((p) => /^search_product=/i.test(p))) extra.push(`search_product=${product}`);
  if (!extra.length) return parts.join(" | ");
  // \b в JS — граница только латинских слов: «Стадия\b» не находится.
  const at = parts.findIndex((p) => /^Стадия(?![а-яё])/i.test(p));
  parts.splice(at >= 0 ? at + 1 : 0, 0, ...extra);
  return parts.join(" | ");
}

/** Строки и цитаты источника текстом для блока; нечего добавить — "". */
function hintsText(source) {
  if (!source || isLocal(source)) return "";
  const url = String(source.url || "").trim();
  const product = searchProductOf(source);
  const lines = (Array.isArray(source.inputs_outputs_hint) ? source.inputs_outputs_hint : [])
    .map((l) => fullLine(l, url, product))
    .filter(Boolean)
    .slice(0, MAX_LINES);
  const quotes = (Array.isArray(source.evidence_snippets) ? source.evidence_snippets : [])
    .map((q) => String(q ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_QUOTES);
  const out = [
    lines.length ? `inputs_outputs_hint:\n${lines.map((l) => `- ${l}`).join("\n")}` : "",
    quotes.length ? `evidence_snippets:\n${quotes.map((q) => `- «${q}»`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS)}…` : out;
}

const PAGE_TEXT = "Текст страницы (загружен сервером):";

/**
 * Блоки обобщения со строками поиска: после описания, перед текстом
 * страницы. Блок к этому времени уже обрезан до своего предела — строки
 * идут сверх него, текст страницы ради них не урезается.
 */
function withSearchHints(picked, blocks) {
  return blocks.map((b, i) => {
    const hints = hintsText(picked[i]);
    if (!hints) return b;
    const at = b.indexOf(PAGE_TEXT);
    return at >= 0 ? `${b.slice(0, at)}${hints}\n\n${b.slice(at)}` : `${b}\n\n${hints}`;
  });
}

module.exports = { withSearchHints, hintsText, fullLine, searchProductOf };
