// routes/step/utils/antiIdle.js
//
// Долгий ответ модели через nginx: статус 200 и пробел сразу, дальше пробел
// раз в 15 с — иначе прокси рвёт соединение по тайм-ауту чтения. Итог
// (с http_status внутри) — одним JSON в конце. Та же схема, что у остальных
// роутов шага; у них пока свои копии.

function startAntiIdle(res, req, { heartbeatMs = 15000 } = {}) {
  let aborted = false;
  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  try {
    res.write(" ");
  } catch {}
  const hb = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(" \n");
    } catch {}
  }, heartbeatMs);
  const stop = () => clearInterval(hb);
  req.on("aborted", () => {
    aborted = true;
    stop();
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      stop();
    }
  });
  return {
    stop,
    get aborted() {
      return aborted;
    },
  };
}

module.exports = { startAntiIdle };
