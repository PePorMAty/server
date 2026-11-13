// routes/step/utils/verifySources.js
//
// Источники шага, найденные моделью в интернете, — проверка сервером.
//
// Модель называет источники сама и порой выдумывает: в живом прогоне
// 2026-10-29 шаг «неонол → алкилфенолэфирсульфат» опирался на «Patent
// US4560176A — Process for preparing alkylphenol polyglycol ether sulfates»,
// а по этому адресу — «Inverted cone stuffing box» (сальник); ещё одна
// страница отдавала 404. А когда найти нечего, модель возвращает «источник»
// с адресом https://N/A и текстом «источников нет» — и обобщение строило по
// нему шаг «X → X». Поэтому:
//   • заглушки «источников нет» — не источники;
//   • поиск отдал список найденных страниц — адрес не из него выдуман;
//   • страницы нет (404, нет такого сайта) — источник выбрасывается;
//   • страница есть, но не о том (в ней нет ключевых слов названия
//     источника) — выбрасывается;
//   • сайт не пускает сервер (403, капча, таймаут): научную статью сверяем
//     с Crossref (utils/crossref.js) — по DOI или по названию; выдуманная
//     выбрасывается, а у настоящей с не тем адресом он исправляется. Прочее
//     остаётся с пометкой «не проверен»: закрытые сайты бывают и настоящими;
//   • источник не о продукте и вообще не о производстве — выбрасывается. Живой прогон 2026-11-03: на
//     поиск «что делают из алкилсалицилатных присадок» модель вернула
//     репозиторий GitHub, страницу NVIDIA и данные Всемирного банка — и сама
//     честно описала их как веб-технологии и машинное обучение. Страницы
//     настоящие и своим заголовкам соответствуют, так что проверка страницы
//     их пропускала, а обобщение потратило запрос впустую.

const { fetchSource } = require("../../material-balance/utils/fetch-source");
const { crossrefCheck } = require("./crossref");
const { nameKeys } = require("../../local-sources/utils/store");

/** Сколько страниц грузим одновременно и сколько всего ждём. */
const CONCURRENCY = 4;
const TOTAL_TIMEOUT_MS = 60 * 1000;

/** Заглушка вместо источника: «нет источников», адрес-пустышка. */
function isPlaceholder(item) {
  const url = String(item?.url || "").trim();
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (!host.includes(".") || /(^|\.)(n\/?a|none|null|example\.(com|org))$/i.test(host)) return true;
  const hint = String(item?.access_hint || "");
  const title = String(item?.title || "").trim();
  return (
    /no_?valid|not_?found|no_?source|нет\s+источник/i.test(hint) ||
    /^(отсутстви|нет\s|не\s+найден|источник(и|ов)?\s+не\s+найден|no\s+(valid\s+)?sources?)/i.test(title) ||
    // «Общий обзор отсутствия данных…», «Заключение о невозможности…»,
    // «Неприменимость предоставленных материалов к задаче» — тоже ответы
    // модели о том, что источников нет, а не источники.
    /отсутстви[а-яё]*\s+(данных|источник|информац|патент)|невозможност|неприменимост/i.test(title)
  );
}

// ---------- о продукте ли источник ----------

const RU = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "s", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "iu", я: "ia" };

/**
 * Название вещества по-русски и по-английски — к одной записи латиницей:
 * «фенол» и «phenol» → fenol, «ацетон» и «acetone» → aset…, «гексан» и
 * «hexane» → geksan…. Модель описывает источники то по-русски, то
 * по-английски («Alkylphenol Ethoxylates: Production…»), поэтому русские
 * основы названия в английском описании не нашлись бы.
 */
function skeleton(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[а-я]/g, (c) => RU[c] ?? c)
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/ch/g, "kh")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/x/g, "ks")
    .replace(/qu/g, "kv")
    .replace(/w/g, "v")
    .replace(/y/g, "i")
    .replace(/h/g, "g")
    .replace(/kg/g, "kh")
    .replace(/[^a-z0-9]+/g, "");
}

const consonants = (s) => s.replace(/[aeiou]/g, "");

/** Общие слова названия продукта: по ним «о том ли источник» не понять. */
const GENERIC = /^(продукт|веществ|смес|сырь|отход|материал|техническ|товарн|раствор)/;

/**
 * Назван ли продукт в том, что модель сама написала об источнике (название,
 * адрес, описание, подсказки, цитаты). Каждое слово названия и его
 * синонимов из справочника — началом записи латиницей. У длинных слов —
 * ещё и согласными: «хлорбензол» и «chlorobenzene», «этиленгликоль» и
 * «ethylene glycol» различаются только гласными на стыке. Короткое название
 * (короче четырёх букв) не проверяем — по нему ничего не понять.
 */
function productProbes(productName) {
  // [по согласным?, что искать]: начало слова в записи — и его согласные.
  const probes = [];
  for (const key of nameKeys(productName)) {
    for (const w of key.split(" ")) {
      if (GENERIC.test(w)) continue;
      const s = skeleton(w);
      if (s.length < 4 || /^\d+$/.test(s)) continue;
      probes.push([false, s.slice(0, s.length <= 6 ? Math.max(4, s.length - 2) : Math.max(6, s.length - 3))]);
      const c = consonants(s);
      if (c.length >= 5) probes.push([true, c.slice(0, c.length - 1)]);
    }
  }
  return probes;
}

/** Назван ли продукт в тексте; null — название слишком короткое, судить нельзя. */
function mentionsProduct(text, probes) {
  if (!probes.length) return null;
  const hay = skeleton(text);
  const hayC = consonants(hay);
  return probes.some(([byConsonants, what]) => (byConsonants ? hayC : hay).includes(what));
}

function aboutProduct(item, productName) {
  const text = [item?.title, item?.url, item?.technology_description, ...(item?.inputs_outputs_hint || []), ...(item?.evidence_snippets || [])].join(" ");
  return mentionsProduct(text, productProbes(productName)) !== false;
}

/**
 * Слова производства — любого, не только химического, по-русски и
 * по-английски. Продукт в источнике часто назван иначе, чем на графе:
 * сокращением («LDPE», «ПЭНП») или другим словом («Автомобиль» — «car»,
 * «vehicle»; «Самолёт» — «aircraft»), а такие пары по буквам не сравнить.
 * Поэтому источник без названия продукта выбрасываем, только если он и
 * вовсе не о производстве — как репозиторий GitHub или данные Всемирного
 * банка (2026-11-03). До 2026-11-13 здесь были только слова химии, и
 * источники о сборке машин и самолётов выпадали. («Технолог…» нет нарочно:
 * «веб-технологии»; «производ…» — только «производств…», не
 * «производительность».)
 */
const PRODUCTION =
  /производств|изготовл|сборк|собира|завод|фабрик|промышлен|отрасл|комплектующ|детал[еи]|узл[аыо]в?\b|агрегат|материал|сырь|литьё|литье|штамп|сварк|обработк|станк|конвейер|реакц|синтез|катализ|полимер|химич|пиролиз|крекинг|ректифик|кислот|углеводород|manufactur|production|produced|assembl|factory|plant\b|industr|component|supplier|supply chain|raw material|machin|fabricat|welding|casting|stamping|forging|reaction|synthes|catal|polymer|chemical|feedstock|refin|alloy|steel|aluminium|aluminum|composite/i;

function aboutProduction(item) {
  const text = [item?.title, item?.technology_description, ...(item?.inputs_outputs_hint || []), ...(item?.evidence_snippets || [])].join(" ");
  return PRODUCTION.test(text);
}

/**
 * Адрес страницы для сверки со списком найденного поиском: без схемы, www,
 * параметров и косой черты в конце — так модель и поиск пишут одну и ту же
 * страницу по-разному.
 */
function pageKey(url) {
  try {
    const u = new URL(String(url || "").trim());
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* битая кодировка — как есть */
    }
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${path.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/** Сколько знаков текста страницы добавляем к описанию источника. */
const EXCERPT_CHARS = 4000;

/**
 * Абзацы страницы о производстве продукта — в описание источника.
 *
 * Модель на поиске пишет о странице пару предложений: подробный текст она
 * добывала повторными поисками, и поиск шёл до 5 минут (27 поисков подряд у
 * qwen3.8-flash 2026-11-13). Страницу сервер и так открывает для проверки —
 * берём текст оттуда: обобщение шага читает настоящую страницу, а не
 * пересказ. Абзац ценнее, если в нём назван продукт и есть слова
 * производства; порядок — как на странице.
 */
function pageExcerpt(text, productName, max = EXCERPT_CHARS) {
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const paras = [];
  let cur = "";
  // Строка страницы — абзац; совсем короткие (заголовки, пункты списков)
  // приклеиваем к следующей, чтобы не терять их смысл.
  for (const line of lines) {
    cur = cur ? `${cur} ${line}` : line;
    if (cur.length >= 80) {
      paras.push(cur);
      cur = "";
    }
  }
  if (cur) paras.push(cur);
  const probes = productProbes(productName);
  const scored = paras.map((p, i) => {
    // Меню и шапки сайта («Сварочные материалы Виды сварки История…»)
    // — без знаков препинания; в связном тексте они есть.
    if (!/[.!?;:](\s|$)/.test(p)) return { i, p, score: 0 };
    const production = (p.match(new RegExp(PRODUCTION.source, "gi")) || []).length;
    const named = mentionsProduct(p, probes) ? 3 : 0;
    return { i, p, score: production + named };
  });
  const picked = [];
  let used = 0;
  for (const s of [...scored].filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (used + s.p.length > max) continue;
    picked.push(s);
    used += s.p.length + 2;
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map((s) => s.p)
    .join("\n\n");
}

/** Общие слова названий источников: по ним «о том ли страница» не понять. */
const STOP = new Set(
  (
    "process processes production producing preparation preparing method methods industrial industry " +
    "applications application properties property review overview introduction chemistry chemical " +
    "technology technologies using based their which about other patent handbook chapter journal " +
    "производство получение способ процесс технология применение свойства обзор метод"
  ).split(" "),
);

/** Ключевые слова названия: от 5 букв, без общих, основой (без окончаний). */
function keyTerms(title) {
  const words = String(title || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d+$/.test(w) && !/^[a-z]{1,3}\d/.test(w));
  return [...new Set(words.map((w) => w.slice(0, Math.max(5, w.length - 2))))];
}

/**
 * О том ли страница: доля ключевых слов названия, нашедшихся в заголовке и
 * тексте. Меньше двух ключевых слов — судить не по чему, считаем «о том».
 */
function relevant(item, page) {
  const terms = keyTerms(item?.title);
  if (terms.length < 2) return true;
  const hay = `${page.title || ""}\n${page.text || ""}`.toLowerCase().replace(/ё/g, "е");
  const found = terms.filter((t) => hay.includes(t)).length;
  return found / terms.length >= 0.34;
}

/** Причина отказа загрузчика → нет страницы (выбросить) или не проверить. */
const GONE = /страницы нет|неверный адрес|адрес не http|адрес сайта не найден|сайт недоступен \((ENOTFOUND|EAI_AGAIN)/;

async function checkOne(item, { signal, fetchPage, crossref }) {
  let unchecked;
  try {
    const page = await fetchPage(item.url, { signal });
    return relevant(item, page)
      ? { status: "ok", page }
      : { status: "unrelated", reason: `по адресу — другая страница${page.title ? `: «${String(page.title).slice(0, 120)}»` : ""}` };
  } catch (e) {
    const reason = String(e?.message || e);
    if (GONE.test(reason)) return { status: "missing", reason };
    unchecked = { status: "unchecked", reason };
  }
  // Сайт не пустил сервер. Научную статью проверит Crossref (utils/crossref.js):
  // выдуманные модели статьи сидят как раз на закрытых сайтах издательств.
  try {
    return (await crossref(item, { signal })) ?? unchecked;
  } catch (e) {
    console.warn(`[step/sources] Crossref недоступен: ${e.message}`);
    return unchecked;
  }
}

/**
 * Проверить источники. Возвращает { kept, dropped }: kept — с полем
 * server_check { status: "ok" | "unchecked", reason? }; dropped — заглушки,
 * источники не о продукте (если назван productName), несуществующие и чужие
 * страницы, с причиной. Источники из базы документов (origin: local) не
 * трогаем: их загрузил человек.
 */
async function verifyStepSources(
  items,
  { productName, searched, signal, fetchPage = fetchSource, crossref = crossrefCheck } = {},
) {
  const list = Array.isArray(items) ? items : [];
  const dropped = [];
  const todo = [];
  // Поиск отдал список найденных страниц (Responses API, 2026-11-13) — адрес
  // не из него модель составила сама.
  const found = new Set((Array.isArray(searched) ? searched : []).map(pageKey).filter(Boolean));
  for (const it of list) {
    if (it?.origin === "local") continue;
    if (isPlaceholder(it)) {
      dropped.push({ title: it?.title || "", url: it?.url || "", reason: "заглушка «источников нет», а не источник" });
    } else if (found.size && !found.has(pageKey(it.url))) {
      dropped.push({ title: it?.title || "", url: it?.url || "", reason: "адреса нет среди страниц, найденных поиском, — модель его составила" });
    } else if (productName && !aboutProduct(it, productName) && !aboutProduction(it)) {
      dropped.push({
        title: it?.title || "",
        url: it?.url || "",
        reason: `не о «${productName}» и вообще не о производстве: ни продукта, ни производства в названии и описании источника`,
      });
    } else {
      todo.push(it);
    }
  }
  const results = new Map();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TOTAL_TIMEOUT_MS);
  const stop = () => deadline.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const it = todo[next++];
        results.set(it, await checkOne(it, { signal: deadline.signal, fetchPage, crossref }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
  const kept = [];
  for (const it of list) {
    if (it?.origin === "local") {
      kept.push(it);
      continue;
    }
    const r = results.get(it);
    if (!r) continue; // заглушка или не о продукте
    if (r.status === "missing" || r.status === "unrelated") {
      dropped.push({ title: it.title || "", url: it.url || "", reason: r.reason });
    } else {
      // Статью нашёл Crossref по названию, а адрес модель дала не тот — ставим
      // настоящий (doi.org), прежний — рядом.
      const fixed = r.url && r.url !== it.url ? { url: r.url, model_url: it.url } : {};
      const excerpt = r.page ? pageExcerpt(r.page.text, productName || it.title) : "";
      kept.push({
        ...it,
        ...fixed,
        ...(excerpt
          ? { technology_description: `${it.technology_description}\n\nТекст страницы (загружен сервером):\n${excerpt}` }
          : {}),
        server_check: r.status === "ok" ? { status: "ok", ...(r.reason ? { reason: r.reason } : {}) } : { status: "unchecked", reason: r.reason },
      });
    }
  }
  return { kept, dropped };
}

module.exports = { verifyStepSources, isPlaceholder, keyTerms, relevant, aboutProduct, aboutProduction, skeleton, pageKey, pageExcerpt };
