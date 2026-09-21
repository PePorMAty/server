// routes/industry/industry.js
//
// Слой промышленных данных: проверка продуктов графа по реестру российской
// промышленной продукции (ГИСП, ПП №719).
//
//   GET  /industry/status   — подключена ли база и что в ней
//   POST /industry/lookup   — найти продукты в реестре (пачкой)
//   POST /industry/identify — опознать продукты по справочнику синонимов
//
// Модель здесь не участвует: реестр — это авторитетные данные (ИНН, номера
// записей), и придуманный номер отличить от настоящего невозможно. Ищем по
// самой базе, а нечёткость названий берёт на себя лестница запросов в
// utils/normalize.js.

const express = require("express");

const { lookupProduct, status } = require("./utils/store");
const { identify, synonymsStatus } = require("./utils/synonyms");

const router = express.Router();

/** Сколько продуктов принимаем за один запрос. */
const MAX_PRODUCTS = 500;

/** Собрать из тела запроса список названий: без пустых, без повторов, с пределом. */
function readProductNames(raw) {
  const names = [];
  const seen = new Set();
  for (const item of raw) {
    const name = String(item ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= MAX_PRODUCTS) break;
  }
  return names;
}

router.get("/industry/status", (req, res) => {
  try {
    const synonyms = synonymsStatus();
    res.json({
      success: true,
      ...status(),
      synonyms: {
        ready: synonyms.loaded,
        substances: synonyms.entries,
        spellings: synonyms.spellings,
        // Из каких файлов собрано: правленного руками и собранного из Wikidata.
        sources: synonyms.sources,
        // Конфликт — это одно написание у двух РАЗНЫХ веществ. Показываем их
        // числом и списком: молча выбрать победителя значило бы слить
        // несовместимое. Расхождение лишь в выборе канонического имени идёт
        // отдельным счётчиком — оно безобидно.
        conflicts: synonyms.conflicts,
        renames: synonyms.renames,
      },
    });
  } catch (e) {
    console.error("Industry status error:", e);
    res.status(500).json({ success: false, error: "Failed to read GISP status" });
  }
});

/**
 * Опознать продукты по справочнику синонимов.
 *
 * Отвечает каноническим названием вещества — им на графе становится
 * идентификатор продукта, по которому узлы считаются одним и тем же. Реестр
 * здесь не участвует: схлопывание «ИПБ» и «Изопропилбензола» в один узел не
 * зависит от того, есть ли вещество в ГИСП.
 */
router.post("/industry/identify", (req, res) => {
  try {
    const raw = req.body?.products;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "products must be an array" });
    }

    const results = {};
    for (const name of readProductNames(raw)) {
      const hit = identify(name);
      // Неопознанные не пропускаем молча: клиенту важно отличать «справочник
      // не знает такого» от «не спрашивали».
      results[name] = hit
        ? { id: hit.id, canon: hit.canon, exact: hit.exact }
        : null;
    }

    const info = synonymsStatus();
    res.json({ success: true, ready: info.loaded, results });
  } catch (e) {
    console.error("Industry identify error:", e);
    res.status(500).json({ success: false, error: "Failed to identify products" });
  }
});

router.post("/industry/lookup", (req, res) => {
  try {
    const raw = req.body?.products;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "products must be an array" });
    }

    // Один и тот же продукт часто встречается в графе несколько раз — ищем его
    // один раз, а в ответе раскладываем по всем присланным написаниям.
    const names = readProductNames(raw);

    const info = status();
    if (!info.ready) {
      return res.json({
        success: true,
        ready: false,
        reason: info.reason,
        results: {},
      });
    }

    const results = {};
    for (const name of names) {
      results[name] = lookupProduct(name);
    }

    res.json({
      success: true,
      ready: true,
      actualAt: info.actualAt,
      results,
    });
  } catch (e) {
    console.error("Industry lookup error:", e);
    res.status(500).json({ success: false, error: "Failed to search GISP" });
  }
});

module.exports = router;
