// routes/industry/utils/classifiers.js
//
// Расшифровка кодов из реестра: «20.16.10» → «Полимеры этилена в первичных
// формах».
//
// Реестр хранит коды, а не названия, и в карточке стояла голая цифра. Сами
// классификаторы лежат в reference/ — они меняются раз в год и приезжают с
// кодом, поэтому читаем их файлы, а не кладём в базу: иначе смена справочника
// требовала бы переимпорта всего реестра.
//
// Читаются лениво, при первом обращении, и остаются в памяти: ОКПД2 — 1,7 тыс
// строк, ТН ВЭД — 13 тыс, вместе пара мегабайт. Файлов нет — расшифровки не
// будет, но ничего не сломается: коды показываются как есть.

const fs = require("fs");
const path = require("path");

const DIR = path.resolve(__dirname, "../../../reference");

/** Код → название. null, пока не читали; Map — после. */
let okpd2 = null;
let tnved = null;

/** Прочитать файл справочника. Нет файла — это не ошибка. */
function readFile(name) {
  const file = path.join(DIR, name);
  try {
    // BOM в начале: файлы приходят из Windows-инструментов, и первый код
    // иначе получил бы невидимый символ впереди и не сошёлся бы ни с чем.
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

/** ОКПД2: плоский список «код⇥название». */
function loadOkpd2() {
  const map = new Map();
  const text = readFile("okpd2.txt");
  if (!text) return map;
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const code = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (code && name) map.set(code, name);
  }
  return map;
}

/**
 * ТН ВЭД: иерархия, где имя строки без родителей бессмысленно.
 *
 * «– – – прочие» сам по себе не значит ничего — полное имя собирается по
 * цепочке вверх, а глубина задана количеством тире в начале наименования.
 * Строки без кода — заголовки уровня, они в выдачу не идут, но в цепочку
 * входят.
 */
function loadTnved() {
  const map = new Map();
  const text = readFile("tnved.txt");
  if (!text) return map;

  let group = "";
  const parents = [];
  for (const line of text.split("\n")) {
    if (!line.includes("\t")) {
      if (line.startsWith("ГРУППА")) {
        group = line.trim();
        parents.length = 0;
      }
      continue;
    }
    const [rawCode, rawName = ""] = line.split("\t");
    const depth = (rawName.match(/–/g) ?? []).length;
    const name = rawName.replace(/^[\s–]+/, "").replace(/:\s*$/, "").trim();
    if (!name) continue;

    parents[depth] = name;
    parents.length = depth + 1;

    // В колонке кода попадаются примечания — у них там текст, а не цифры.
    const code = rawCode.replace(/\s+/g, "");
    if (!/^\d{4,10}$/.test(code)) continue;

    map.set(code, {
      name,
      path: parents.filter(Boolean).join(" → "),
      group,
    });
  }
  return map;
}

/**
 * Название по коду ОКПД2.
 *
 * В реестре коды длиннее, чем в справочнике: «20.16.10.110» против
 * «20.16.10». Отсекаем хвост по группам цифр, пока не найдём.
 */
function okpd2Name(code) {
  if (okpd2 === null) okpd2 = loadOkpd2();
  const clean = String(code ?? "").trim();
  if (!clean) return null;

  let key = clean;
  while (key) {
    const hit = okpd2.get(key);
    if (hit) return hit;
    const dot = key.lastIndexOf(".");
    if (dot < 0) break;
    key = key.slice(0, dot);
  }
  return null;
}

/**
 * Название по коду ТН ВЭД.
 *
 * Коды в реестре десятизначные, в номенклатуре встречаются 4, 6, 9 и 10 цифр.
 * Укорачиваем, пока не совпадёт: чем короче код, тем шире товарная группа, и
 * это честнее, чем не сказать ничего.
 */
function tnvedName(code) {
  if (tnved === null) tnved = loadTnved();
  const digits = String(code ?? "").replace(/\D+/g, "");
  if (digits.length < 4) return null;

  for (let len = digits.length; len >= 4; len--) {
    const hit = tnved.get(digits.slice(0, len));
    if (hit) {
      return {
        name: hit.name,
        path: hit.path,
        group: hit.group,
        // Код короче спрошенного — значит это группа, а не сама позиция.
        exact: len === digits.length,
      };
    }
  }
  return null;
}

/** Что удалось прочитать — для диагностики и страницы состояния. */
function classifiersStatus() {
  if (okpd2 === null) okpd2 = loadOkpd2();
  if (tnved === null) tnved = loadTnved();
  return { okpd2: okpd2.size, tnved: tnved.size, dir: DIR };
}

module.exports = { okpd2Name, tnvedName, classifiersStatus };
