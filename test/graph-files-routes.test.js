// Роуты библиотеки графов поверх хранилища (файлы и, при TEST_DATABASE_URL,
// PostgreSQL): ответы те же, что до переезда, плюс версия графа и 409 при
// конфликте сохранений (PG-MIGRATION.md, этап 1).
//
//   npm test
//   TEST_DATABASE_URL=postgres://… npm test

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFileStore, createPgStore, setStore } = require("../routes/graph-files/store");
const graphFiles = require("../routes/graph-files/graph-files");
const bookmarks = require("../routes/graph-files/bookmarks");
const history = require("../routes/graph-files/history");
const balances = require("../routes/graph-files/material-balances");
const productIds = require("../routes/graph-files/product-ids");
const share = require("../routes/share/share");

const PG_URL = process.env.TEST_DATABASE_URL;

/** Вызвать обработчик роутера как Express; вернуть { status, body }. */
function call(router, method, routePath, { params = {}, body = {}, query = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `нет роута ${method.toUpperCase()} ${routePath}`);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(o) {
        resolve({ status: this.statusCode, body: o });
      },
      end() {
        resolve({ status: this.statusCode, body: null });
      },
    };
    layer.route.stack[0].handle({ params, body, query, on() {} }, res);
  });
}

const nodes = [{ id: "n1", type: "product", data: { label: "Фенол" } }];

const setups = [
  {
    name: "файлы",
    async open() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-routes-"));
      return { store: createFileStore({ dataDir: dir }), close: async () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
  },
];
if (PG_URL) {
  setups.push({
    name: "PostgreSQL",
    async open() {
      const { Pool } = require("pg");
      const { migrate } = require("../db/migrate");
      const pool = new Pool({ connectionString: PG_URL, max: 5 });
      const unlock = await require("./helpers/pg").lockTestDb(pool);
      await migrate(pool);
      await pool.query("TRUNCATE app.graphs, app.shares, app.settings CASCADE");
      return {
        store: createPgStore({ pool }),
        close: async () => {
          await pool.query("TRUNCATE app.graphs, app.shares, app.settings CASCADE");
          await unlock();
          await pool.end();
        },
      };
    },
  });
}

for (const s of setups) {
  describe(`роуты библиотеки — ${s.name}`, () => {
    let ctx;
    before(async () => {
      ctx = await s.open();
      setStore(ctx.store);
    });
    after(async () => {
      setStore(null);
      await ctx.close();
    });

    test("сохранить → список → открыть → перезаписать с версией → устаревшая версия: 409", async () => {
      const saved = await call(graphFiles, "post", "/save", { body: { name: "Фенол вниз", nodes, edges: [] } });
      assert.equal(saved.status, 200);
      const id = saved.body.file;
      assert.match(id, /^-_\d{4}-\d{2}-\d{2}T.*\.json$/); // кириллица из имени — как раньше: дефисы
      assert.equal(saved.body.data.version, 1);

      const list = await call(graphFiles, "get", "/");
      assert.deepEqual(list.body.data.map((g) => g.name), ["Фенол вниз"]);

      const opened = await call(graphFiles, "get", "/:id", { params: { id } });
      assert.equal(opened.body.meta.version, 1);
      assert.deepEqual(opened.body.graph.nodes, nodes);

      const put = await call(graphFiles, "put", "/:id", { params: { id }, body: { nodes, edges: [], version: 1 } });
      assert.equal(put.status, 200);
      assert.equal(put.body.data.version, 2);
      assert.equal(put.body.data.name, "Фенол вниз"); // имя прежнее, раз не прислали

      const stale = await call(graphFiles, "put", "/:id", { params: { id }, body: { nodes: [], edges: [], version: 1 } });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error, "conflict");
      assert.equal(stale.body.current.version, 2);
      // Граф не перезаписан.
      assert.equal((await call(graphFiles, "get", "/:id", { params: { id } })).body.graph.nodes.length, 1);

      // Старый клиент без версии — сохраняет как раньше.
      const legacy = await call(graphFiles, "put", "/:id", { params: { id }, body: { nodes, edges: [] } });
      assert.equal(legacy.body.data.version, 3);

      // Переименование в библиотеке — без новой версии.
      const renamed = await call(graphFiles, "patch", "/:id", { params: { id }, body: { name: "Фенол — тест" } });
      assert.equal(renamed.body.data.name, "Фенол — тест");
      assert.equal(renamed.body.data.version, 3);
    });

    test("закладки, история, расчёты баланса, идентификаторы — как раньше; сохранение графа чистит два последних", async () => {
      const id = (await call(graphFiles, "post", "/save", { body: { name: "Сайдкары", nodes, edges: [] } })).body.file;
      const b = await call(bookmarks, "put", "/:id/bookmarks/:nodeId", { params: { id, nodeId: "n1" }, body: { label: "Фенол" } });
      assert.equal(b.status, 201);
      assert.equal((await call(bookmarks, "get", "/:id/bookmarks", { params: { id } })).body.data[0].label, "Фенол");

      const h = await call(history, "post", "/:id/history", { params: { id }, body: { entries: [{ kind: "edit", title: "раз" }, { kind: "step", title: "два" }] } });
      assert.equal(h.status, 201);
      assert.deepEqual(h.body.data.map((e) => e.title), ["два", "раз"]);

      await call(balances, "put", "/:id/material-balances/:nodeId", { params: { id, nodeId: "t1" }, body: { calcs: [{ id: "c" }] } });
      await call(productIds, "put", "/:id/product-ids", { params: { id }, body: { ids: { n1: { productId: "108-95-2", productIdSource: "cas" } } } });
      assert.deepEqual((await call(balances, "get", "/:id/material-balances", { params: { id } })).body.data, { t1: [{ id: "c" }] });
      assert.deepEqual((await call(productIds, "get", "/:id/product-ids", { params: { id } })).body.data, { n1: { productId: "108-95-2", productIdSource: "cas" } });

      await call(graphFiles, "put", "/:id", { params: { id }, body: { nodes, edges: [] } });
      assert.deepEqual((await call(balances, "get", "/:id/material-balances", { params: { id } })).body.data, {});
      assert.deepEqual((await call(productIds, "get", "/:id/product-ids", { params: { id } })).body.data, {});
      // Закладки и история остаются.
      assert.equal((await call(bookmarks, "get", "/:id/bookmarks", { params: { id } })).body.data.length, 1);

      // Чужой граф — 404, удалённый — тоже.
      assert.equal((await call(bookmarks, "get", "/:id/bookmarks", { params: { id: "нет.json" } })).status, 404);
      assert.equal((await call(graphFiles, "delete", "/:id", { params: { id } })).status, 204);
      assert.equal((await call(graphFiles, "delete", "/:id", { params: { id } })).status, 404);
      assert.equal((await call(history, "get", "/:id/history", { params: { id } })).status, 404);
    });

    test("«Поделиться»: снимок по токену; неизвестный токен — 404", async () => {
      const r = await call(share, "post", "/share", { body: { name: "Снимок", nodes, edges: [] } });
      assert.equal(r.status, 200);
      assert.match(r.body.id, /^[A-Za-z0-9]{8}$/);
      const got = await call(share, "get", "/share/:id", { params: { id: r.body.id } });
      assert.equal(got.body.meta.name, "Снимок");
      assert.equal((await call(share, "get", "/share/:id", { params: { id: "Nope1234" } })).status, 404);
    });
  });
}

// Сжатое сохранение (18.11): клиент шлёт граф gzip'ом с Content-Type
// application/gzip — через настоящий Express, как на сервере: общий
// express.json впереди такие запросы пропускает, распаковывает роутер.
describe("сохранение сжатым графом", () => {
  const express = require("express");
  const zlib = require("zlib");
  let server;
  let base;
  let dir;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-gzip-"));
    setStore(createFileStore({ dataDir: dir }));
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/api/graph-files", graphFiles);
    await new Promise((r) => (server = app.listen(0, r)));
    base = `http://127.0.0.1:${server.address().port}/api/graph-files`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const gz = (o) => zlib.gzipSync(Buffer.from(JSON.stringify(o)));
  const send = (method, url, body, type = "application/gzip") =>
    fetch(`${base}${url}`, { method, headers: { "content-type": type }, body });

  test("POST и PUT сжатым — как обычным JSON, версия растёт", async () => {
    const r = await send("POST", "/save", gz({ name: "Сжатый", nodes, edges: [] }));
    assert.equal(r.status, 200);
    const saved = (await r.json()).data;
    assert.equal(saved.name, "Сжатый");

    const more = [...nodes, { id: "n2", type: "product", data: { label: "Ацетон" } }];
    const u = await send("PUT", `/${encodeURIComponent(saved.id)}`, gz({ nodes: more, edges: [], version: saved.version }));
    assert.equal(u.status, 200);
    assert.equal((await u.json()).data.version, saved.version + 1);

    const g = await (await fetch(`${base}/${encodeURIComponent(saved.id)}`)).json();
    assert.deepEqual(g.graph.nodes.map((n) => n.data.label), ["Фенол", "Ацетон"]);

    // Конфликт версий — тот же 409 и для сжатого.
    const c = await send("PUT", `/${encodeURIComponent(saved.id)}`, gz({ nodes, edges: [], version: saved.version }));
    assert.equal(c.status, 409);
  });

  test("обычный JSON по-прежнему принимается (старый клиент)", async () => {
    const r = await send("POST", "/save", JSON.stringify({ name: "Несжатый", nodes, edges: [] }), "application/json");
    assert.equal(r.status, 200);
  });

  test("битое сжатие — 400, а не падение", async () => {
    const r = await send("POST", "/save", Buffer.from("это не gzip"));
    assert.equal(r.status, 400);
  });
});
