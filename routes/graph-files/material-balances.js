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

const {
  BALANCES_DIR,
  sidecarPath,
  readJson,
  writeJson,
  resolveGraph,
} = require("./utils");

const router = express.Router();

async function readBalances(fileName) {
  const stored = await readJson(sidecarPath(BALANCES_DIR, fileName));
  const items = stored?.items;
  return items && typeof items === "object" && !Array.isArray(items) ? items : {};
}

// Запись — «прочитать, поправить, записать»: две правки разных узлов подряд
// иначе затирали бы друг друга. Очередь на каждый граф.
const queues = new Map();

function serialized(fileName, task) {
  const prev = queues.get(fileName) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(fileName, next);
  next
    .finally(() => {
      if (queues.get(fileName) === next) queues.delete(fileName);
    })
    .catch(() => {});
  return next;
}

router.get("/:id/material-balances", async (req, res) => {
  try {
    const fileName = await resolveGraph(req, res);
    if (!fileName) return;

    const items = await readBalances(fileName);
    const data = Object.fromEntries(
      Object.entries(items).map(([nodeId, entry]) => [
        nodeId,
        Array.isArray(entry?.calcs) ? entry.calcs : [],
      ]),
    );
    res.json({ success: true, data });
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

    await serialized(fileName, async () => {
      const items = await readBalances(fileName);
      items[nodeId] = { calcs, updatedAt: new Date().toISOString() };
      await writeJson(sidecarPath(BALANCES_DIR, fileName), {
        graphId: fileName,
        updatedAt: new Date().toISOString(),
        items,
      });
    });

    res.json({ success: true });
  } catch (e) {
    console.error("Save material balances error:", e);
    res.status(500).json({ error: "Failed to save material balances" });
  }
});

module.exports = router;
