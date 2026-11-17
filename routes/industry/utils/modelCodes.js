// routes/industry/utils/modelCodes.js
//
// Коды, определённые моделью, — сохраняются, чтобы дальше приходить сами.
//
// Определить коды стоит запросов к модели, а продукт встречается на многих
// графах. Поэтому найденное хранится на сервере, в data/product-codes.json, и
// отдаётся в ответе /industry/lookup (поле modelCodes) — любому графу и любому
// клиенту, где бы продукт ни стоял. Ключ — нормализованное название и, если
// справочник синонимов знает вещество, его каноническое имя: коды «Кумола»
// получит и «Изопропилбензол».
//
// Файл маленький (запись на продукт); читаем его заново, только когда он
// изменился, — на сервере может работать не один процесс. Пишем во временный
// файл и переименовываем: оборванная запись не испортит прежний.
//
// При переходе на PostgreSQL (PG-MIGRATION.md, этап 2) — таблица product_codes.

const fs = require("fs");
const path = require("path");

const { normalizeName } = require("./normalize");
const { identify } = require("./synonyms");
const { isUnqualifiedGeneric } = require("../../shared/genericParts");

// PRODUCT_CODES_FILE — другой файл: для тестов и пробных прогонов.
const FILE = process.env.PRODUCT_CODES_FILE || path.resolve(__dirname, "../../../data/product-codes.json");

let cache = { mtimeMs: -1, data: {} };

function load() {
  try {
    const st = fs.statSync(FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      cache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(FILE, "utf8")) || {} };
    }
  } catch {
    cache = { mtimeMs: -1, data: {} };
  }
  return cache.data;
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, FILE);
  cache = { mtimeMs: fs.statSync(FILE).mtimeMs, data };
}

/** Ключи продукта: название и каноническое имя вещества. */
function keysOf(name) {
  const keys = [`name:${normalizeName(name)}`];
  const canon = identify(name)?.canon;
  if (canon) keys.push(`canon:${normalizeName(canon)}`);
  return keys.filter((k) => !k.endsWith(":"));
}

/**
 * Сохранённые коды продукта: { okpd2?, tnved? } или null. Своё название
 * главнее канона: коды могли определить и для синонима, и для него самого.
 */
function savedCodes(name) {
  // Общее название («Двигатель») — код зависит от изделия; записанное по
  // имени до 2026-11-17 (двигатель автомобиля с кодом 28.11) не отдаём.
  if (isUnqualifiedGeneric(name)) return null;
  const data = load();
  const [own, canon] = keysOf(name);
  const a = data[own];
  const b = canon ? data[canon] : null;
  const okpd2 = a?.okpd2 ?? b?.okpd2;
  const tnved = a?.tnved ?? b?.tnved;
  return okpd2 || tnved ? { ...(okpd2 ? { okpd2 } : {}), ...(tnved ? { tnved } : {}) } : null;
}

/**
 * Записать найденные коды продукта. codes — { okpd2?, tnved? }; не найденный
 * код (NONE) не пишем — прежний найденный остаётся.
 */
function storeCodes(name, codes) {
  const data = { ...load() };
  for (const key of keysOf(name)) {
    const prev = data[key] ?? {};
    data[key] = { ...prev, name: prev.name && key.startsWith("canon:") ? prev.name : name, ...codes };
  }
  save(data);
}

/** Стереть коды видов kinds у продукта (по названию и канону). */
function clearCodes(name, kinds) {
  const data = { ...load() };
  let changed = false;
  for (const key of keysOf(name)) {
    const rec = data[key];
    if (!rec) continue;
    const next = { ...rec };
    for (const k of kinds) if (next[k]) {
      delete next[k];
      changed = true;
    }
    if (next.okpd2 || next.tnved) data[key] = next;
    else delete data[key];
  }
  if (changed) save(data);
}

module.exports = { savedCodes, storeCodes, clearCodes, keysOf, FILE };
