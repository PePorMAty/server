#!/usr/bin/env node
//
// Собрать синонимы продуктов из Wikidata по номеру CAS.
//
//   node scripts/fetch-wikidata-synonyms.js --dry-run       — посмотреть, что выйдет
//   node scripts/fetch-wikidata-synonyms.js                 — записать файл
//   node scripts/fetch-wikidata-synonyms.js --missing-only  — только незнакомые справочнику
//   node scripts/fetch-wikidata-synonyms.js --names "Бензол,Кумол"
//   node scripts/fetch-wikidata-synonyms.js --limit 50      — оборвать после N названий
//
// Зачем Wikidata. Номер CAS — единственный ходовой идентификатор ВЕЩЕСТВА:
// ОКПД2 и ТН ВЭД классифицируют товарные категории, и под одним их кодом лежат
// разные продукты. Базы CAS в открытом доступе нет, но Wikidata хранит номер
// свойством P231, а рядом — русские название и синонимы. То есть даёт ровно
// то, что мы писали руками, но с происхождением: у каждой записи код элемента,
// по которому её можно открыть и проверить.
//
// Почему СПРАШИВАЕМ ПРО СВОИ ПРОДУКТЫ, а не скачиваем всё. Запрос «все
// вещества с номером CAS» публичная точка не отдаёт — сущностей сотни тысяч, и
// он отваливается по таймауту (проверено). Да и незачем: нужны названия,
// которые реально стоят на графах.
//
// Как спрашиваем. Сперва пачками по полусотне через русскую Википедию: она
// отдаёт коды элементов и сама разворачивает перенаправления, так что шестьсот
// названий укладываются в дюжину запросов. Остаток — поиском по Wikidata, по
// одному. Такой порядок взят не для красоты: поиск по одному упирался в
// ограничение частоты (429), и лекарство от него — не частить, а спрашивать
// пачками.
//
// Как отбираем. Поиск по названию возвращает кандидатов; оставляем тех, у кого
// ЕСТЬ номер CAS (это отсекает всё нехимическое) и чьё русское название или
// синоним в точности равны спрошенному. Если под одно название подошло
// несколько РАЗНЫХ веществ — не выбираем, а откладываем в неоднозначные:
// угадав здесь, мы слили бы в один узел разные вещества.

const fs = require("fs");
const path = require("path");

const { collectProducts } = require("./lib/graph-products");
const { identify } = require("../routes/industry/utils/synonyms");
const {
  foldLookalikes,
  normalizeName,
} = require("../routes/industry/utils/normalize");

// Адреса можно подменить: так скрипт целиком прогоняется на заглушке, не
// трогая живую Wikimedia.
const API = process.env.WIKIDATA_API || "https://www.wikidata.org/w/api.php";
const WIKI_API = process.env.RUWIKI_API || "https://ru.wikipedia.org/w/api.php";
const OUT = path.resolve(__dirname, "../reference/synonyms-wikidata.txt");

/**
 * Пауза между запросами.
 *
 * Четыре запроса в секунду Wikimedia не терпит — отвечает 429 и просит
 * помедленнее. Начинаем с секунды и подстраиваемся по ответам.
 */
const DELAY_START_MS = 1100;
const DELAY_MAX_MS = 6000;
let delayMs = DELAY_START_MS;

/** Сколько ждём один ответ. */
const TIMEOUT_MS = 30_000;
/** Сколько раз повторяем запрос, упёршийся в ограничение частоты. */
const RETRIES = 5;
/** Сколько кандидатов смотрим на одно название. */
const CANDIDATES = 5;
/** По скольку элементов забираем за раз (предел API — 50). */
const BATCH = 40;
/** По скольку названий спрашиваем у Википедии (предел тот же). */
const TITLE_BATCH = 50;

/** Ключ сравнения — тот же, что у справочника. */
const key = (s) => foldLookalikes(normalizeName(s));

const STOP_FILE = path.resolve(__dirname, "../reference/synonyms-stop.txt");

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
    text = fs.readFileSync(STOP_FILE, "utf8").replace(/^\uFEFF/, "");
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

/** Коды пищевых добавок: «Е240», «E 355» — не названия вещества. */
const FOOD_CODE = /^[ЕE]\s?\d{2,4}$/i;

/**
 * Годится ли написание ключом равенства.
 *
 * Возвращает причину отказа — её показываем, чтобы отсев был виден, а не
 * происходил молча.
 */
function rejectReason(name) {
  if (!name || name.length < 3) return "слишком короткое";
  if (!/[а-яё]/i.test(name)) return "не по-русски";
  if (/^\d+$/.test(name)) return "одни цифры";
  // По длине короткое НЕ отсеиваем. Соблазн был: «фен» у бензола — это и
  // причёска, и вещество. Но той же меркой улетели бы ТДИ, МДИ, МДА, ПВХ —
  // ровно те сокращения, ради которых справочник и заводился. Отдельные
  // опасные короткие слова идут поимённо в synonyms-stop.txt.
  if (FOOD_CODE.test(name)) return "код пищевой добавки";
  if (STOP.has(key(name))) return "класс веществ, не вещество";
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      throw new Error(`ответ ${res.status} ${res.statusText}`);
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
  // Разматываем цепочку обратно, иначе ответ не с чем сопоставить.
  const backwards = new Map();
  for (const step of [
    ...(data?.query?.normalized ?? []),
    ...(data?.query?.redirects ?? []),
  ]) {
    if (step?.from && step?.to) backwards.set(step.to, step.from);
  }
  const original = (title) => {
    let cur = title;
    for (let i = 0; i < 5 && backwards.has(cur); i++) cur = backwards.get(cur);
    return cur;
  };

  const out = new Map();
  for (const page of data?.query?.pages ?? []) {
    const qid = page?.pageprops?.wikibase_item;
    if (!qid || !page?.title) continue;
    out.set(original(page.title), qid);
  }
  return out;
}

/** Кандидаты по русскому названию. */
async function search(name) {
  const data = await api({
    action: "wbsearchentities",
    search: name,
    language: "ru",
    uselang: "ru",
    type: "item",
    limit: String(CANDIDATES),
  });
  return (data?.search ?? []).map((s) => s.id).filter(Boolean);
}

/** Русские название, синонимы и номер CAS для пачки элементов. */
async function entities(ids) {
  const data = await api({
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "labels|aliases|claims",
    languages: "ru",
  });

  const out = new Map();
  for (const [id, item] of Object.entries(data?.entities ?? {})) {
    if (item?.missing !== undefined) continue;
    const label = String(item?.labels?.ru?.value ?? "").trim();
    const aliases = (item?.aliases?.ru ?? [])
      .map((a) => String(a?.value ?? "").trim())
      .filter(Boolean);

    // Номер CAS: берём первое непустое значение P231.
    let cas = null;
    for (const claim of item?.claims?.P231 ?? []) {
      const v = claim?.mainsnak?.datavalue?.value;
      if (typeof v === "string" && v.trim()) {
        cas = v.trim();
        break;
      }
    }

    out.set(id, { id, label, aliases, cas });
  }
  return out;
}

/** Годится ли название в справочник. */
const usableName = (name) => rejectReason(name) === null;

/** Первая буква заглавной: идентификатор видит человек в карточке узла. */
function asCanon(name) {
  const s = String(name ?? "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const missingOnly = args.includes("--missing-only");
  const namesArg = args.indexOf("--names");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

  let names;
  if (namesArg >= 0) {
    names = String(args[namesArg + 1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    const { counts, graphs } = collectProducts();
    console.log(`Графов: ${graphs.length}, различных названий: ${counts.size}`);
    names = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);
    if (missingOnly) {
      const before = names.length;
      names = names.filter((n) => !identify(n));
      console.log(`Справочнику незнакомы: ${names.length} из ${before}`);
    }
  }

  names = names.filter(usableName).slice(0, limit);
  if (!names.length) {
    console.log("Спрашивать нечего.");
    return;
  }

  console.log(`\nНазваний к опросу: ${names.length}.`);

  const candidatesByName = new Map();
  const allIds = new Set();
  let failed = 0;
  let inARow = 0;

  /** Единая реакция на сорвавшийся запрос: считаем и знаем, когда сдаться. */
  const note = (what, e) => {
    failed += 1;
    inARow += 1;
    if (failed <= 3) console.error(`\n  ${what}: ${e.message}`);
    if (inARow === 12) {
      console.error(
        `\n  Двенадцать запросов подряд не прошли — дальше нет смысла.` +
          `\n  Последняя ошибка: ${e.message}`,
      );
      return true;
    }
    return false;
  };

  // ── 1) быстрый проход: коды элементов пачками через Википедию ──
  // Он и есть лекарство от 429: шестьсот запросов превращаются в дюжину.
  const batches = Math.ceil(names.length / TITLE_BATCH);
  console.log(`Сперва пачками через Википедию: ${batches} запрос(ов).`);

  let byTitle = new Map();
  for (let i = 0; i < names.length; i += TITLE_BATCH) {
    const chunk = names.slice(i, i + TITLE_BATCH);
    try {
      const got = await idsByTitles(chunk);
      for (const [title, qid] of got) byTitle.set(title, qid);
      inARow = 0;
    } catch (e) {
      if (note(`пачка заголовков ${i / TITLE_BATCH + 1}`, e)) break;
    }
    process.stdout.write(
      `\rстатей разобрано: ${Math.min(i + TITLE_BATCH, names.length)} из ${names.length}, нашлось ${byTitle.size}   `,
    );
    await sleep(delayMs);
  }
  console.log("");

  for (const [name, qid] of byTitle) {
    candidatesByName.set(name, [qid]);
    allIds.add(qid);
  }

  // ── 2) чего не нашлось статьёй — доспрашиваем поиском, по одному ──
  const rest = names.filter((n) => !byTitle.has(n));
  if (rest.length) {
    const seconds = Math.ceil((rest.length * delayMs) / 1000);
    const eta = seconds < 90 ? `${seconds} с` : `${Math.ceil(seconds / 60)} мин`;
    console.log(`Остальные ${rest.length} — поиском по одному, примерно ${eta}.`);
    inARow = 0;

    for (let i = 0; i < rest.length; i++) {
      const name = rest[i];
      try {
        const ids = await search(name);
        candidatesByName.set(name, ids);
        for (const id of ids) allIds.add(id);
        inARow = 0;
      } catch (e) {
        if (note(`«${name}»`, e)) break;
      }
      process.stdout.write(
        `\rспрошено: ${i + 1} из ${rest.length} (пауза ${delayMs} мс)   `,
      );
      await sleep(delayMs);
    }
    console.log("");
  }

  if (!allIds.size) {
    console.error("\nНи одного кандидата не нашлось — записывать нечего.");
    process.exit(1);
  }

  // ── 2) сведения о кандидатах, пачками ──
  const ids = [...allIds];
  const info = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    try {
      const got = await entities(ids.slice(i, i + BATCH));
      for (const [id, item] of got) info.set(id, item);
    } catch (e) {
      console.error(`\n  пачка со смещения ${i}: ${e.message}`);
    }
    process.stdout.write(`\rразобрано элементов: ${info.size} из ${ids.length}`);
    await sleep(delayMs);
  }
  console.log("\n");

  // ── 3) отбор: есть CAS и название совпадает в точности ──
  const entries = new Map(); // Q-id → запись
  const ambiguous = [];
  const unresolved = [];
  // Что выброшено отсевом — показываем, чтобы он не работал молча.
  const dropped = [];

  for (const [name, candidateIds] of candidatesByName) {
    const wanted = key(name);
    const hits = [];
    for (const id of candidateIds) {
      const item = info.get(id);
      if (!item?.cas) continue; // нехимическое — мимо
      const spellings = [item.label, ...item.aliases].filter(usableName);
      if (!spellings.some((s) => key(s) === wanted)) continue; // похожее, но не то
      hits.push(item);
    }

    if (!hits.length) {
      unresolved.push(name);
      continue;
    }
    // Несколько РАЗНЫХ веществ под одним названием — не выбираем.
    const distinct = new Set(hits.map((h) => h.cas));
    if (distinct.size > 1) {
      ambiguous.push({ name, cas: [...distinct] });
      continue;
    }

    const item = hits[0];

    // Канон-категория испортил бы всё, что к нему привяжется: «спирт» стянул
    // бы к себе и метанол, и этанол. Такую запись берём не с другим каноном,
    // а не берём вовсе — выбрать за Wikidata, какое из имён главное, мы не
    // можем.
    const canonBad = rejectReason(item.label);
    if (canonBad) {
      dropped.push({ name: item.label, why: `${canonBad} (канон ${item.id})` });
      continue;
    }

    const spellings = [];
    const seen = new Set();
    for (const s of [item.label, ...item.aliases]) {
      const why = rejectReason(s);
      if (why) {
        dropped.push({ name: s, why, of: item.label });
        continue;
      }
      const k = key(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      spellings.push(asCanon(s));
    }
    if (spellings.length) {
      entries.set(item.id, { ...item, spellings });
    }
  }

  // Вещество с единственным написанием в справочнике бесполезно: одинаковые
  // названия схлопываются и без него.
  const useful = [...entries.values()].filter((e) => e.spellings.length > 1);

  console.log(`Опознано веществ:        ${entries.size}`);
  console.log(`Из них с разнописанием:  ${useful.length}  ← только они идут в файл`);
  console.log(`Названий без совпадения: ${unresolved.length}`);
  console.log(`Неоднозначных:           ${ambiguous.length}`);
  console.log(`Синонимов отсеяно:       ${dropped.length}`);
  if (failed) console.log(`Запросов не прошло:      ${failed}`);

  if (dropped.length) {
    // Показываем всё: отсев решает, что попадёт в ключ равенства, и работать
    // молча ему нельзя. Увидели лишнее — reference/synonyms-stop.txt правится
    // руками, и пересбор это учтёт.
    const byReason = new Map();
    for (const d of dropped) {
      if (!byReason.has(d.why)) byReason.set(d.why, []);
      byReason.get(d.why).push(d.of ? `${d.name} (у «${d.of}»)` : d.name);
    }
    console.log("\nОтсеяно из синонимов:");
    for (const [why, list] of byReason) {
      console.log(`  ${why}: ${list.length}`);
      for (const n of list.slice(0, 12)) console.log(`      ${n}`);
      if (list.length > 12) console.log(`      … и ещё ${list.length - 12}`);
    }
  }

  if (ambiguous.length) {
    console.log("\nНеоднозначные (под одним названием разные вещества, пропущены):");
    for (const a of ambiguous.slice(0, 15)) {
      console.log(`  ${a.name} → CAS ${a.cas.join(", ")}`);
    }
  }

  if (!useful.length) {
    console.log("\nЗаписывать нечего.");
    return;
  }

  console.log("\nПервые записи:");
  for (const e of useful.slice(0, 12)) {
    console.log(`  ${e.spellings.join(" | ")}   # CAS ${e.cas} ${e.id}`);
  }

  if (dryRun) {
    console.log(`\n--dry-run: файл не тронут. Уберите флаг, чтобы записать\n  ${OUT}`);
    return;
  }

  const head = [
    "# Синонимы продуктов, собранные из Wikidata по номеру CAS.",
    "#",
    "# СОБРАН МАШИНОЙ, ПРАВИТЬ РУКАМИ НЕ НАДО — перезапишется при следующем",
    "# сборе (scripts/fetch-wikidata-synonyms.js). Нашли ошибку — поправьте",
    "# запись в reference/synonyms.txt: тот файл читается первым и побеждает.",
    "#",
    "# В хвосте строки — номер CAS и код элемента Wikidata. По коду запись",
    "# открывается и проверяется: https://www.wikidata.org/wiki/Q…",
    "#",
    `# Собрано: ${new Date().toISOString().slice(0, 10)}, веществ: ${useful.length}`,
    "",
  ].join("\n");

  const body = useful
    .map((e) => `${e.spellings.join(" | ")}   # CAS ${e.cas} ${e.id}`)
    .join("\n");

  fs.writeFileSync(OUT, `${head}${body}\n`, "utf8");
  console.log(`\nЗаписано: ${OUT}`);
  console.log("Проверьте, что вышло:  node scripts/audit-products.js");
}

main().catch((e) => {
  console.error("Сорвалось:", e.message);
  process.exit(1);
});
