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
// он отваливается по таймауту (проверено). Да и незачем: нам нужны названия,
// которые реально стоят на графах. Их шестьсот с небольшим, и каждое
// спрашивается отдельным лёгким запросом.
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

// Адрес можно подменить: так скрипт целиком прогоняется на заглушке, не
// трогая живую Wikidata.
const API = process.env.WIKIDATA_API || "https://www.wikidata.org/w/api.php";
const OUT = path.resolve(__dirname, "../reference/synonyms-wikidata.txt");

/** Пауза между запросами: точка публичная, вести себя надо прилично. */
const DELAY_MS = 250;
/** Сколько ждём один ответ. */
const TIMEOUT_MS = 30_000;
/** Сколько кандидатов смотрим на одно название. */
const CANDIDATES = 5;
/** По скольку элементов забираем за раз (предел API — 50). */
const BATCH = 40;

/** Ключ сравнения — тот же, что у справочника. */
const key = (s) => foldLookalikes(normalizeName(s));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: "json", ...params })}`;
  const res = await fetch(url, {
    headers: {
      // Wikidata просит представляться; безымянные запросы она режет. Только
      // латиница: HTTP-заголовки кириллицу не принимают.
      "User-Agent": "gpt-graph/1.0 (chemical synonyms by CAS)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wikidata ответила ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data?.error) throw new Error(`Wikidata: ${data.error.info ?? data.error.code}`);
  return data;
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
function usableName(name) {
  if (!name || name.length < 3) return false;
  if (!/[а-яё]/i.test(name)) return false; // русское название, латинские не наш случай
  if (/^\d+$/.test(name)) return false;
  return true;
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

  console.log(
    `\nСпрашиваю Wikidata про ${names.length} названий, по одному запросу на каждое.`,
  );
  // Оценка грубая: к опросу названий добавляется разбор кандидатов пачками.
  const seconds = Math.ceil((names.length * DELAY_MS * 1.3) / 1000);
  const eta =
    seconds < 90 ? `${seconds} с` : `${Math.ceil(seconds / 60)} мин`;
  console.log(`Пауза ${DELAY_MS} мс — уйдёт примерно ${eta}.\n`);

  // ── 1) кандидаты по каждому названию ──
  const candidatesByName = new Map();
  const allIds = new Set();
  let failed = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      const ids = await search(name);
      candidatesByName.set(name, ids);
      for (const id of ids) allIds.add(id);
    } catch (e) {
      failed += 1;
      if (failed <= 3) console.error(`\n  «${name}»: ${e.message}`);
      if (failed === 10) {
        console.error(
          "\nДесять запросов подряд не прошли — дальше нет смысла.\n" +
            "Проверьте, открыт ли с этой машины www.wikidata.org.",
        );
        break;
      }
    }
    process.stdout.write(`\rспрошено: ${i + 1} из ${names.length}`);
    await sleep(DELAY_MS);
  }
  console.log("");

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
    await sleep(DELAY_MS);
  }
  console.log("\n");

  // ── 3) отбор: есть CAS и название совпадает в точности ──
  const entries = new Map(); // Q-id → запись
  const ambiguous = [];
  const unresolved = [];

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
    const spellings = [];
    const seen = new Set();
    for (const s of [item.label, ...item.aliases]) {
      if (!usableName(s)) continue;
      const k = key(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      spellings.push(s);
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
  if (failed) console.log(`Запросов не прошло:      ${failed}`);

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
