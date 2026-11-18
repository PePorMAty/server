// routes/graph-files/product-ids.js
//
// Идентификаторы продуктов графа — сайдкаром рядом с графом, как расчёты
// баланса.
//
// Идентификатор (канон вещества по справочнику, см. industry/identify)
// клиент проставляет узлам сам, как только граф открыт. В файл графа он
// попадал, только если граф сохранить: у графа на 279 продуктов ни у одного
// его не было, и при каждом открытии справочник спрашивали обо всех заново.
// Клиент пишет сюда то, что проставил, а при открытии графа кладёт
// записанное в узлы — и спрашивает справочник только о продуктах без
// идентификатора или с идентификатором прежней версии справочника.
//
// Сохранение графа (PUT /graph-files/:id) кладёт идентификаторы в сам файл и
// сайдкар очищает.
//
//   GET /graph-files/:id/product-ids  — { [nodeId]: { productId, productIdSource, productIdVersion, productIdLabel } }
//   PUT /graph-files/:id/product-ids  — { ids: { [nodeId]: {…} | null } }: дописать пачку, null — убрать

const express = require("express");

const { resolveGraph } = require("./utils");
const { getStore } = require("./store");

const router = express.Router();

const SOURCES = new Set(["manual", "tnved", "cas", "dictionary"]);

/** Сколько узлов принимаем за раз — больше, чем продуктов в самом большом графе. */
const MAX_IDS = 5000;

/**
 * Запись узла из тела запроса; не годится — null. Без идентификатора, но с
 * версией справочника — тоже запись: «справочник этой версии такого названия
 * не знает», спрашивать о нём снова незачем.
 */
function readEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const productId = String(raw.productId ?? "").trim();
  if (productId.length > 300) return null;
  const source = SOURCES.has(raw.productIdSource) ? raw.productIdSource : null;
  const version =
    typeof raw.productIdVersion === "string" && raw.productIdVersion.length <= 64
      ? raw.productIdVersion
      : null;
  if (!productId && !version) return null;
  // Название узла, для которого получен идентификатор: узел переименовали и
  // граф не сохранили — в файле прежнее название, и чужой ему идентификатор
  // клиент при открытии не возьмёт.
  const label =
    typeof raw.productIdLabel === "string" && raw.productIdLabel.length <= 300
      ? raw.productIdLabel
      : null;
  return {
    ...(productId ? { productId } : {}),
    ...(source && productId ? { productIdSource: source } : {}),
    ...(version ? { productIdVersion: version } : {}),
    ...(label ? { productIdLabel: label } : {}),
  };
}

// Две пачки подряд не затирают друг друга: это держит хранилище (очередь на
// граф в файле, транзакция в базе).

router.get("/:id/product-ids", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;
    res.json({ success: true, data: await getStore().getProductIds(fileName) });
  } catch (e) {
    console.error("List product ids error:", e);
    res.status(500).json({ error: "Failed to read product ids" });
  }
});

router.put("/:id/product-ids", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    const ids = req.body?.ids;
    if (!ids || typeof ids !== "object" || Array.isArray(ids)) {
      return res.status(400).json({ error: "ids must be an object" });
    }
    const entries = Object.entries(ids).slice(0, MAX_IDS);

    const changes = [];
    for (const [nodeId, raw] of entries) {
      const id = String(nodeId || "").trim();
      if (!id) continue;
      if (raw === null) changes.push([id, null]);
      else {
        const entry = readEntry(raw);
        if (entry) changes.push([id, entry]);
      }
    }
    await getStore().putProductIds(fileName, changes);

    res.json({ success: true });
  } catch (e) {
    console.error("Save product ids error:", e);
    res.status(500).json({ error: "Failed to save product ids" });
  }
});

module.exports = router;
