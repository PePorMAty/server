// scripts/lib/wikidata.js
//
// Общее для сборщиков синонимов из Wikidata: вежливые запросы к Wikimedia,
// коды элементов по статьям Википедии, сведения об элементах и отсев
// написаний, негодных в ключ равенства.
//
// Сборщиков два — по нашим названиям (fetch-wikidata-synonyms.js) и по
// отрасли целиком (fetch-wikidata-domain.js). Правила отсева у них обязаны
// быть одни: иначе одно и то же написание у одного проходило бы, а у другого
// нет, и справочник зависел бы от того, каким путём в него попала строка.

const fs = require("fs");
const path = require("path");

const {
  foldLookalikes,
  normalizeName,
} = require("../../routes/industry/utils/normalize");

// Адреса можно подменить: так сборщики целиком прогоняются на заглушке, не
// трогая живую Wikimedia.
const API = process.env.WIKIDATA_API || "https://www.wikidata.org/w/api.php";
const WIKI_API = process.env.RUWIKI_API || "https://ru.wikipedia.org/w/api.php";

/**
 * Пауза между запросами.
 *
 * Четыре запроса в секунду Wikimedia не терпит — отвечает 429 и просит
 * помедленнее. Начинаем с секунды и подстраиваемся по ответам.
 */
const DELAY_START_MS = Number(process.env.WIKIDATA_DELAY_MS) || 1100; // меньше — только для заглушки
const DELAY_MAX_MS = 6000;
let delayMs = DELAY_START_MS;

/** Сколько ждём один ответ. */
const TIMEOUT_MS = 30_000;
/** Сколько раз повторяем запрос, упёршийся в ограничение частоты. */
const RETRIES = 5;
/** По скольку названий спрашиваем у Википедии (предел API — 50). */
const TITLE_BATCH = 50;
/**
 * Сколько знаков может занять список заголовков в адресе запроса.
 *
 * Полсотни — предел API по счёту, но не по длине. Русская буква в адресе
 * занимает шесть знаков («%D0%B1»), и полсотни длинных названий выходят за
 * восемь тысяч — Википедия отвечает на такое «414 URI Too Long». Так в прогоне
 * 2026-09-29 пропали две пачки из восьми. Поэтому пачку набираем и по длине.
 */
const TITLE_URL_BUDGET = 6000;

/** Ключ сравнения — тот же, что у справочника. */
const key = (s) => foldLookalikes(normalizeName(s));

const STOP_FILE = path.resolve(__dirname, "../../reference/synonyms-stop.txt");

/**
 * Слова, которые нельзя брать ключом равенства.
 *
 * Wikidata держит в синонимах и классы, к которым вещество относится: у
 * этанола — «спирт» и «алкоголь», у метана — «природный газ». Как справка это
 * верно, а как ключ равенства сливает разные продукты в один узел. Список
 * лежит отдельным файлом, видимым и правимым: см. reference/synonyms-stop.txt.
 */
function loadStopList() {
  const stop = new Set();
  let text;
  try {
    text = fs.readFileSync(STOP_FILE, "utf8").replace(/^﻿/, "");
  } catch {
    return stop; // нет файла — отсеиваем только правилами ниже
  }
  for (const line of text.split(/\r?\n/)) {
    const term = line.trim();
    if (!term || term.startsWith("#")) continue;
    const k = key(term);
    if (k) stop.add(k);
  }
  return stop;
}

const STOP = loadStopList();

/** Коды пищевых добавок: «Е240», «E 355», «Е262i», «E-404» — не названия вещества. */
const FOOD_CODE = /^[ЕE][\s-]?\d{2,4}[a-zа-яё]?$/i;

/**
 * Похоже ли написание на химическую формулу, а не на английское слово.
 *
 * Различать приходится: формула — законный ключ, на графах сплошь «Диоксид
 * серы (SO2)», «Хлорид лития (LiCl)», «Оксиды азота (NOx)», и опознаются они
 * как раз по скобке. А английское слово ключом брать опасно: «oil» или
 * «water» стянут к себе что угодно.
 *
 * Формула складывается из символов элементов: заглавная буква, иногда строчная
 * следом, иногда индекс. «SiCl4» — это Si + Cl4, «NOx» — N + Ox. Английское
 * слово так не раскладывается: в «Formaldehyde» после «Fo» идёт вторая строчная
 * подряд, а «AdBlue» спотыкается на «ue».
 */
function looksLikeFormula(name) {
  const bare = String(name ?? "").replace(/\s+/g, "");
  if (!bare) return false;
  // Символ элемента: заглавная, иногда строчная следом, иногда индекс. Плюс
  // группа в скобках со своим индексом — «Ca(OH)2», «Al2(SO4)3».
  const ATOM = "[A-Z][a-z]?\\d*";
  if (new RegExp(`^(?:${ATOM}|\\((?:${ATOM})+\\)\\d*)+$`).test(bare)) return true;
  // Сокращения и обозначения без строчных букв: «PET», «2,4-D», «L-SBR».
  return /^[A-Z0-9,.()\-]+$/.test(bare);
}

/**
 * Годится ли написание ключом равенства.
 *
 * Возвращает причину отказа — её показываем, чтобы отсев был виден, а не
 * происходил молча.
 */
function rejectReason(name) {
  if (!name || name.length < 3) return "слишком короткое";
  if (/^\d+$/.test(name)) return "одни цифры";
  if (FOOD_CODE.test(name)) return "код пищевой добавки";
  // Латиницей пишут и формулы, и английские названия. Формула — законный
  // ключ: на графах сплошь «Диоксид серы (SO2)», «Хлорид лития (LiCl)», и
  // опознаются они как раз по скобке. А английское слово ключом брать
  // опасно: «oil» или «water» стянут к себе что угодно. Отличаем по виду —
  // в формуле есть цифра либо она набрана прописными.
  if (!/[а-яё]/i.test(name) && !looksLikeFormula(name)) {
    return "английское слово, не формула";
  }
  // По длине короткое НЕ отсеиваем. Соблазн был: «фен» у бензола — это и
  // причёска, и вещество. Но той же меркой улетели бы ТДИ, МДИ, МДА, ПВХ —
  // ровно те сокращения, ради которых справочник и заводился. Отдельные
  // опасные короткие слова идут поимённо в synonyms-stop.txt.
  // Стоп-лист держит не только классы, но и торговые имена и сокращения,
  // которыми зовут разные вещества, — причина общая для всех.
  if (STOP.has(key(name))) return "в стоп-листе: не имя одного вещества";
  return null;
}

/** Годится ли название в справочник. */
const usableName = (name) => rejectReason(name) === null;

/** Первая буква заглавной: идентификатор видит человек в карточке узла. */
function asCanon(name) {
  const s = String(name ?? "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Пауза, которую сейчас держим между запросами. */
const currentDelay = () => delayMs;
/** Выждать паузу перед следующим запросом. */
const pause = () => sleep(delayMs);

/** Сколько запросов подряд прошло без замечаний — по ним отпускаем тормоз. */
let calm = 0;

/**
 * Запрос к Wikimedia с уважением к ограничению частоты.
 *
 * 429 — это «помедленнее», а не «нет доступа»: ждём столько, сколько просят
 * заголовком Retry-After (или по нарастающей), увеличиваем паузу для всех
 * следующих запросов и пробуем снова. Ровно этим прошлый заход и захлебнулся:
 * 429 считался отказом, счётчик неудач добирал до предела, и скрипт бросал
 * работу, советуя проверить доступ, которого на самом деле хватало.
 */
async function request(endpoint, params) {
  const url = `${endpoint}?${new URLSearchParams({ format: "json", ...params })}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        // Wikimedia просит представляться; безымянные запросы она режет.
        // Только латиница: HTTP-заголовки кириллицу не принимают.
        "User-Agent": "gpt-graph/1.0 (chemical synonyms by CAS)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Слишком часто или сервер занят — это повод подождать, а не сдаться.
    if (res.status === 429 || res.status === 503) {
      calm = 0;
      delayMs = Math.min(Math.round(delayMs * 1.6), DELAY_MAX_MS);
      if (attempt >= RETRIES) {
        throw new Error(
          `Wikidata держит ограничение частоты (${res.status}) даже после ${RETRIES} попыток`,
        );
      }
      const askedFor = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(askedFor) && askedFor > 0
        ? askedFor * 1000
        : Math.min(2000 * 2 ** attempt, 30_000);
      process.stdout.write(`\r  притормаживаю на ${Math.round(wait / 1000)} с…            `);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      const err = new Error(`ответ ${res.status} ${res.statusText}`);
      err.status = res.status; // по нему пачка заголовков узнаёт, что адрес длинен
      throw err;
    }

    const data = await res.json();
    if (data?.error) throw new Error(data.error.info ?? data.error.code);

    // Долго идёт гладко — понемногу возвращаем скорость.
    if (++calm >= 25 && delayMs > DELAY_START_MS) {
      delayMs = Math.max(Math.round(delayMs * 0.8), DELAY_START_MS);
      calm = 0;
    }
    return data;
  }
}

const api = (params) => request(API, params);

/**
 * Коды элементов по названиям — пачкой, через русскую Википедию.
 *
 * Поиск по Wikidata умеет только по одному названию за запрос, и на шестистах
 * продуктах это шестьсот запросов, в которые мы и упёрлись ограничением
 * частоты. А Википедия отдаёт коды элементов сразу по полусотне заголовков и
 * заодно разворачивает перенаправления: «Кумол» приводит к той же статье, что
 * «Изопропилбензол».
 *
 * Что не нашлось статьёй — доспрашиваем поиском по одному. Если этот путь
 * почему-то не сработает вовсе, потеряется только скорость: всё уйдёт в
 * медленный поиск, как раньше.
 */
async function idsByTitles(titles) {
  const data = await request(WIKI_API, {
    action: "query",
    formatversion: "2",
    prop: "pageprops",
    ppprop: "wikibase_item",
    redirects: "1",
    titles: titles.join("|"),
  });

  // Википедия отвечает про КОНЕЧНЫЕ заголовки, а спрашивали мы про исходные:
  // по дороге их могли нормализовать и провести через перенаправление.
  // Идём от каждого спрошенного вперёд. Раньше цепочку разматывали от
  // конечного заголовка назад — и из двух названий, ведущих на одну статью
  // («Кумол» и «Кумен» → «Изопропилбензол»), статью получало только одно.
  const forward = new Map();
  for (const step of data?.query?.normalized ?? []) {
    if (step?.from && step?.to) forward.set(step.from, { to: step.to, redirect: false });
  }
  for (const step of data?.query?.redirects ?? []) {
    if (step?.from && step?.to) forward.set(step.from, { to: step.to, redirect: true });
  }
  const qidOfPage = new Map();
  for (const page of data?.query?.pages ?? []) {
    const qid = page?.pageprops?.wikibase_item;
    if (qid && page?.title) qidOfPage.set(page.title, qid);
  }

  const out = new Map();
  for (const asked of titles) {
    let cur = asked;
    let redirect = false;
    for (let i = 0; i < 5 && forward.has(cur); i++) {
      const step = forward.get(cur);
      if (step.redirect) redirect = true;
      cur = step.to;
    }
    const qid = qidOfPage.get(cur);
    if (qid) out.set(asked, { qid, title: cur, redirect });
  }
  return out;
}

/**
 * Разложить названия по пачкам: не больше TITLE_BATCH и не длиннее бюджета.
 *
 * Длину считаем с запасом: пробел encodeURIComponent пишет тремя знаками, а в
 * адрес он уходит одним «+».
 */
function titleBatches(names) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const name of names) {
    const cost = encodeURIComponent(name).length + 3; // «%7C» — разделитель
    if (cur.length && (cur.length >= TITLE_BATCH || size + cost > TITLE_URL_BUDGET)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(name);
    size += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Значения утверждения: код элемента у ссылки на элемент, строка у строки,
 * число у количества («+26» → 26).
 */
function claimValues(claims, prop) {
  const out = [];
  for (const claim of claims?.[prop] ?? []) {
    // Устаревшее утверждение Wikidata хранит для истории — как факт оно не в счёт.
    if (claim?.rank === "deprecated") continue;
    const v = claim?.mainsnak?.datavalue?.value;
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (typeof v?.id === "string") out.push(v.id);
    else if (typeof v?.amount === "string" && Number.isFinite(Number(v.amount))) {
      out.push(Number(v.amount));
    }
  }
  return out;
}

/**
 * Русские название, синонимы и номер CAS для пачки элементов.
 *
 * withMore — ещё описание, статья русской Википедии и значения перечисленных
 * утверждений (claims: { P31: [...] }). Нужно сборщику отрасли: он судит о
 * предмете по месту в классах, а не только по названию.
 */
async function entities(ids, withMore = null) {
  const data = await api({
    action: "wbgetentities",
    ids: ids.join("|"),
    props: withMore ? "labels|aliases|claims|descriptions|sitelinks" : "labels|aliases|claims",
    languages: "ru",
    ...(withMore ? { sitefilter: "ruwiki" } : {}),
  });

  const out = new Map();
  for (const [id, item] of Object.entries(data?.entities ?? {})) {
    if (item?.missing !== undefined) continue;
    // Знак ударения («Ди́кая груша», «Кишка́») — не часть написания: на графах
    // его не ставят, и ключом сравнения такое слово не совпало бы ни с чем.
    const plain = (s) => String(s ?? "").replace(/́/g, "").trim();
    const label = plain(item?.labels?.ru?.value);
    const aliases = (item?.aliases?.ru ?? []).map((a) => plain(a?.value)).filter(Boolean);

    // Номер CAS: берём первое непустое значение P231.
    let cas = null;
    for (const claim of item?.claims?.P231 ?? []) {
      const v = claim?.mainsnak?.datavalue?.value;
      if (typeof v === "string" && v.trim()) {
        cas = v.trim();
        break;
      }
    }

    const entry = { id, label, aliases, cas };
    if (withMore) {
      entry.description = String(item?.descriptions?.ru?.value ?? "").trim();
      entry.ruwiki = item?.sitelinks?.ruwiki?.title ?? null;
      entry.claims = {};
      for (const prop of withMore.claims ?? []) {
        entry.claims[prop] = claimValues(item?.claims, prop);
      }
    }
    out.set(id, entry);
  }
  return out;
}

module.exports = {
  API,
  WIKI_API,
  key,
  STOP,
  looksLikeFormula,
  rejectReason,
  usableName,
  asCanon,
  sleep,
  pause,
  currentDelay,
  request,
  api,
  idsByTitles,
  titleBatches,
  entities,
  claimValues,
};
