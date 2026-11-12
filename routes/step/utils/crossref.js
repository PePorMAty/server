// routes/step/utils/crossref.js
//
// Научная ссылка из поиска источников — сверка с Crossref, открытым реестром
// DOI.
//
// Почему. В живых прогонах 2026-10-29 … 11-03 почти все статьи, которые
// модель приводила источниками, выдуманы. Их DOI существуют, но ведут на
// чужие статьи: «Surfactants in Pesticide Formulations: Role of Alkylphenol
// Ethoxylates» по её DOI — «Semiochemicals in Pest and Weed Control», «LDPE
// → углеродные нанотрубки» — исследование депрессии у людей с инвалидностью.
// Номера статей ScienceDirect и MDPI кончаются на …1234, названия статей
// ScienceDirect — по-русски. Сайты издательств не пускают сервер (403),
// поэтому проверка страницы ставила таким ссылкам «не проверен», и выдумки
// доходили до обобщения. Crossref отвечает всем и по DOI знает название
// каждой статьи, а по названию находит настоящую статью и её DOI.

const API = "https://api.crossref.org/works";
// Crossref просит представляться; почту не шлём — только адрес сайта.
const UA = "GraphProduction/1.0 (+https://sorangptgraph.xyz)";

/** Научные сайты: статью без DOI в адресе ищем в Crossref по названию. */
const ACADEMIC =
  /(^|\.)(sciencedirect\.com|elsevier\.com|mdpi\.com|researchgate\.net|semanticscholar\.org|academia\.edu|tandfonline\.com|wiley\.com|acs\.org|rsc\.org|springer\.com|nature\.com|jstor\.org|ieee\.org|iop\.org|frontiersin\.org|hindawi\.com|plos\.org|sagepub\.com|cambridge\.org|oup\.com|degruyter\.com|scielo\.\w+)$/i;

/** DOI из адреса: /doi/10.…, doi.org/10.…, ?id=10.…, Nature /articles/s…. */
function doiFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let where = `${u.pathname}${u.search}`;
  try {
    where = decodeURIComponent(where);
  } catch {
    /* битая кодировка — ищем как есть */
  }
  const m = /(10\.\d{4,9}\/[^\s?#&]+)/.exec(where);
  if (m) return m[1].replace(/\/(full|abstract|pdf|epdf|html|meta)$/i, "");
  if (/(^|\.)nature\.com$/i.test(u.hostname)) {
    const n = /\/articles\/([a-z0-9][a-z0-9.-]+)/i.exec(u.pathname);
    if (n) return `10.1038/${n[1]}`;
  }
  return null;
}

const isAcademic = (url) => {
  try {
    return ACADEMIC.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Служебные слова названий статей — по ним «та же статья» не понять. */
const STOP = new Set(["into", "with", "from", "using", "upon", "toward", "towards", "through", "their", "over", "under", "between", "within", "about", "para", "этот", "через", "основе"]);

/**
 * Значимые слова названия — по первым 8 буквам и без окончания
 * множественного числа: «ethoxylates» = «ethoxylate», но «hydrocracking» ≠
 * «hydrocarbon» (по 6 буквам совпадали, и «Hydrocracking of LDPE…» сошлось
 * со стандартом ASTM на базовые масла).
 */
function titleWords(s) {
  return [
    ...new Set(
      String(s || "")
        .replace(/<[^>]+>/g, " ")
        .toLowerCase()
        .replace(/ё/g, "е")
        .split(/[^a-zа-я0-9]+/)
        .map((w) => (w.length > 4 ? w.replace(/(es|s)$/, "") : w))
        .filter((w) => w.length >= 4 && !STOP.has(w))
        .map((w) => w.slice(0, 8)),
    ),
  ];
}

/** Доля слов названия a, которые есть в названии b. */
function overlap(a, b) {
  const wa = titleWords(a);
  const wb = new Set(titleWords(b));
  if (wa.length < 2 || !wb.size) return 0;
  return wa.filter((w) => wb.has(w)).length / wa.length;
}

/** Та же статья: почти все слова названия от модели — в настоящем названии. */
const sameTitle = (claimed, real) => overlap(claimed, real) >= 0.6;

const cleanTitle = (t) => String(t || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

async function getJson(url, { signal, fetchImpl = fetch }) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal });
    if (r.status === 404) return null;
    // «Слишком часто» — у Crossref это бывает на пачке ссылок подряд.
    if (r.status === 429 && attempt === 1) {
      await new Promise((ok) => setTimeout(ok, 1500));
      continue;
    }
    if (!r.ok) throw new Error(`Crossref: HTTP ${r.status}`);
    return r.json();
  }
}

/**
 * Сверка научной ссылки. Возвращает null — ссылка не научная, судить не нам;
 * { status: "ok", url? } — статья настоящая (url — её настоящий адрес, если
 * модель дала не тот); { status: "unchecked", reason } — нашлась лишь
 * похожая; { status: "missing" | "unrelated", reason } — выдумана. Crossref недоступен — бросает ошибку: тогда остаётся «не
 * проверен».
 */
async function crossrefCheck(item, opts = {}) {
  const doi = doiFromUrl(item?.url);
  if (doi) {
    const json = await getJson(`${API}/${encodeURIComponent(doi)}`, opts);
    if (json) {
      const real = cleanTitle(json.message?.title?.[0]);
      return sameTitle(item.title, real)
        ? { status: "ok" }
        : { status: "unrelated", reason: `по этому DOI — другая статья: «${real.slice(0, 120)}»` };
    }
    // DOI нет вовсе. Название при этом бывает настоящим (2026-11-12:
    // «Handbook of Polyethylene» с выдуманным DOI) — ищем по названию.
    const byTitle = await findByTitle(item, opts);
    return byTitle.status === "ok" ? byTitle : { status: "missing", reason: `DOI ${doi} нет в Crossref — статья выдумана` };
  }
  // Не статья: подборки ScienceDirect (/topics/…) и прочие страницы-обзоры
  // настоящие, но в Crossref их нет — по названию их не найти.
  if (!isAcademic(item?.url) || /\/topics?\//i.test(new URL(item.url).pathname)) return null;
  return findByTitle(item, opts);
}

/** Поиск статьи в Crossref по названию от модели. */
async function findByTitle(item, opts) {
  const q = new URLSearchParams({ "query.bibliographic": String(item.title || "").slice(0, 300), rows: "3", select: "DOI,title" });
  const json = await getJson(`${API}?${q}`, opts);
  const items = (json?.message?.items || []).map((w) => ({ doi: w.DOI, title: cleanTitle(w.title?.[0]) }));
  // Та же статья — совпадение в обе стороны; общее название модели («LDPE
  // Recycling and Chemical Conversion Technologies») находит лишь похожую
  // («Recycling of waste plastics into fuels. LDPE conversion in FCC»).
  const same = items.find((w) => overlap(item.title, w.title) >= 0.6 && overlap(w.title, item.title) >= 0.6);
  if (same) return { status: "ok", url: `https://doi.org/${same.doi}`, reason: "адрес исправлен по Crossref" };
  if (items.some((w) => sameTitle(item.title, w.title))) {
    return { status: "unchecked", reason: "сайт не пустил сервер; в Crossref есть похожая статья, но не та же" };
  }
  return { status: "unrelated", reason: "статьи с таким названием нет в Crossref — похоже, модель её выдумала" };
}

module.exports = { crossrefCheck, doiFromUrl, sameTitle, isAcademic };
