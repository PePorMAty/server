// routes/industry/utils/ecics.js
//
// Код ТН ВЭД по номеру CAS — из ECICS, таможенного реестра химических
// веществ ЕС (reference/ecics.txt, собирает scripts/import-ecics.js).
//
// Код по названию (tnvedByName.js) находит вещество, только если у него в
// ТН ВЭД своя строка. Малеиновая, фумаровая, янтарная кислоты, глицин,
// ацетилен лежат в «прочих» — по названию до них не дойти. ECICS знает их по
// номеру CAS: это классификация таможни ЕС, а не подбор по словам.
//
// Как код ЕС становится кодом ТН ВЭД. Код Комбинированной номенклатуры ЕС —
// восемь знаков; первые шесть — Гармонизированная система, одна на весь мир,
// и в ТН ВЭД ЕАЭС они те же. Дальше ЕС и ЕАЭС делят по-своему: у малеиновой
// кислоты в ЕС 2917 19 80, а в ТН ВЭД под 2917 19 — «малоновая кислота»
// (100) и «прочие» (900). Поэтому берём шесть знаков, а если под ними в ТН
// ВЭД одна-единственная позиция — её целиком: тогда выбирать не из чего
// («2909 11 000 эфир диэтиловый простой»). Короче шести знаков ECICS даёт
// металлам («8108» — товарная позиция титана) — берём, если не короче
// четырёх: группа («72») ничего не говорит о веществе.
//
// Несколько кодов у номера и разные шесть знаков — не выбираем за таможню:
// null. Сведения ECICS справочные, юридической силы не имеют.

const fs = require("fs");
const path = require("path");

const { formatTnved, tnvedLeavesUnder, tnvedName } = require("./classifiers");

const FILE = path.resolve(__dirname, "../../../reference/ecics.txt");

/** Номер CAS → коды ЕС; null — ещё не читали, пустая — файла нет. */
let byCas = null;

function load() {
  const map = new Map();
  let text = "";
  try {
    text = fs.readFileSync(FILE, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [cas, codes = ""] = line.split("\t");
    const list = codes.split(" ").filter(Boolean);
    if (cas && list.length) map.set(cas.trim(), list);
  }
  return map;
}

/** Коды ЕС у номера CAS как есть — для отчётов. */
function ecicsCodes(cas) {
  if (byCas === null) byCas = load();
  return byCas.get(String(cas ?? "").trim()) ?? null;
}

/**
 * Позиция ТН ВЭД вещества по номеру CAS, или null.
 *
 * @returns {{ code: string, name: string, path: string, cn: string[] } | null}
 *   code — код ТН ВЭД, как его пишут; cn — коды ЕС из ECICS, по которым он
 *   найден.
 */
function tnvedByCas(cas) {
  const cn = ecicsCodes(cas);
  if (!cn) return null;
  // Общий для всех кодов номера уровень: шесть знаков, у металлов — меньше.
  const heads = new Set(cn.map((c) => c.slice(0, 6)));
  if (heads.size !== 1) return null;
  const head = [...heads][0];
  if (head.length < 4) return null;
  const leaves = tnvedLeavesUnder(head);
  if (!leaves.length) return null;
  const code = leaves.length === 1 ? leaves[0] : head;
  const named = tnvedName(code);
  if (!named) return null;
  return { code: formatTnved(code), name: named.name, path: named.path, cn };
}

/** Сколько номеров в файле — для страницы состояния. */
function ecicsStatus() {
  if (byCas === null) byCas = load();
  return { substances: byCas.size };
}

module.exports = { tnvedByCas, ecicsCodes, ecicsStatus };
