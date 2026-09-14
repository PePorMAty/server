// routes/industry/industry.js
//
// Слой промышленных данных: проверка продуктов графа по реестру российской
// промышленной продукции (ГИСП, ПП №719).
//
//   GET  /industry/status   — подключена ли база и что в ней
//   POST /industry/lookup   — найти продукты в реестре (пачкой)
//
// Модель здесь не участвует: реестр — это авторитетные данные (ИНН, номера
// записей), и придуманный номер отличить от настоящего невозможно. Ищем по
// самой базе, а нечёткость названий берёт на себя лестница запросов в
// utils/normalize.js.

const express = require("express");

const { lookupProduct, status } = require("./utils/store");

const router = express.Router();

/** Сколько продуктов принимаем за один запрос. */
const MAX_PRODUCTS = 500;

router.get("/industry/status", (req, res) => {
  try {
    res.json({ success: true, ...status() });
  } catch (e) {
    console.error("Industry status error:", e);
    res.status(500).json({ success: false, error: "Failed to read GISP status" });
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
    const names = [];
    const seen = new Set();
    for (const item of raw) {
      const name = String(item ?? "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= MAX_PRODUCTS) break;
    }

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
