// routes/material-balance/utils/jobs.js
//
// Фоновые расчёты: в памяти процесса, клиент спрашивает ход по номеру.
//
// Хранить сами задачи в базе незачем: готовый расчёт туда пишет маршрут, а
// при перезапуске сервера недосчитанное всё равно пропадает — клиент получит
// 404 и предложит запустить заново.

const crypto = require("crypto");

/** Сколько держать законченную задачу, чтобы клиент успел забрать ответ. */
const KEEP_FINISHED_MS = 2 * 60 * 60 * 1000;

const jobs = new Map();

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > KEEP_FINISHED_MS) jobs.delete(id);
  }
}

/**
 * Запустить задачу. Такая же (signature) уже считается — вернуть её: второй
 * щелчок «Рассчитать» или вторая вкладка не стоят второго запроса к модели.
 */
function start(signature, run) {
  sweep();
  for (const job of jobs.values()) {
    if (job.status === "running" && job.signature === signature) return job;
  }
  const job = {
    id: crypto.randomBytes(9).toString("base64url"),
    signature,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  Promise.resolve()
    .then(run)
    .then(
      (result) => {
        job.status = "done";
        job.result = result;
        job.finishedAt = Date.now();
      },
      (err) => {
        job.status = "failed";
        job.error = err?.message || String(err);
        job.finishedAt = Date.now();
        console.error(`[material-balance] расчёт ${job.id}:`, job.error);
      },
    );
  return job;
}

function get(id) {
  return jobs.get(String(id)) ?? null;
}

/** Что отдать клиенту. */
function view(job) {
  return {
    id: job.id,
    status: job.status,
    startedAt: new Date(job.startedAt).toISOString(),
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    ...(job.status === "done" ? { result: job.result } : {}),
    ...(job.status === "failed" ? { error: job.error } : {}),
  };
}

module.exports = { start, get, view };
