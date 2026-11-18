// routes/graph-files/material-balances.js
//
// Расчёты материального баланса графа — сайдкаром рядом с графом, как
// закладки.
//
// Расчёт живёт в данных узла преобразования (materialBalances) и попадает в
// файл графа при сохранении. Но считается он минуты: приходит, когда граф
// уже сохранён (подпись «Все изменения сохранены» расчёты не учитывает) или
// вовсе закрыт, — и при следующем открытии его не было. Клиент пишет сюда
// список расчётов узла при каждом изменении, а при открытии графа кладёт
// записанное в узлы.
//
// Запись узла — его список целиком. Пустой список значит «расчёты убраны», а
// не «не знаю»: иначе при открытии вернулись бы удалённые. Сохранение графа
// (PUT /graph-files/:id) кладёт расчёты в сам файл и сайдкар очищает.
//
//   GET /graph-files/:id/material-balances          — { [nodeId]: calcs[] }
//   PUT /graph-files/:id/material-balances/:nodeId  — список расчётов узла

const express = require("express");

const { resolveGraph } = require("./utils");
const { getStore } = require("./store");

const router = express.Router();

// Запись узла — одна строка (в базе) или «прочитать, поправить, записать»
// с очередью на граф (в файле): две правки разных узлов подряд не затирают
// друг друга — это делает хранилище.

router.get("/:id/material-balances", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    res.json({ success: true, data: await getStore().getBalances(fileName) });
  } catch (e) {
    console.error("List material balances error:", e);
    res.status(500).json({ error: "Failed to read material balances" });
  }
});

router.put("/:id/material-balances/:nodeId", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    const nodeId = String(req.params.nodeId || "").trim();
    if (!nodeId) return res.status(400).json({ error: "Bad node id" });

    const { calcs } = req.body ?? {};
    if (!Array.isArray(calcs)) {
      return res.status(400).json({ error: "calcs must be an array" });
    }

    await getStore().putBalance(fileName, nodeId, calcs);

    res.json({ success: true });
  } catch (e) {
    console.error("Save material balances error:", e);
    res.status(500).json({ error: "Failed to save material balances" });
  }
});

module.exports = router;
