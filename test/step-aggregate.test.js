// Обобщение шага (POST /api/graphs/gpt/step/aggregate): что уходит модели.
//
// Модель не вызывается — транспорт подменён и запоминает запрос. База
// источников — во временной папке, раздел записывается прямо в таблицы.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.LOCAL_SOURCES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "step-aggregate-test-"));

// ---------- подмена транспорта к модели ----------
const utilsPath = require.resolve(path.join(__dirname, "../routes/sources/utils"));
const real = require(utilsPath);
let captured = null; // первый запрос к модели в обобщении
let calls = []; // все запросы
let replies = []; // ответы модели по очереди; кончились — заглушка
require.cache[utilsPath].exports = {
  ...real,
  callOpenAIResponsesRaw: async ({ payload }) => {
    calls.push(payload);
    if (!captured) captured = payload;
    return { status: "completed", text: replies.shift() ?? "# Раскрываемый продукт\n" };
  },
  extractOutputText: (r) => r.text,
};

const store = require("../routes/local-sources/utils/store");
const router = require("../routes/step/aggregate.js");
const handle = router.stack.find((l) => l.route?.path === "/gpt/step/aggregate" && l.route.methods.post)
  .route.stack[0].handle;

let lastBody = null;
function aggregate(body, modelReplies = []) {
  captured = null;
  calls = [];
  replies = [...modelReplies];
  return new Promise((resolve) => {
    let out = "";
    const res = {
      statusCode: 200,
      writableEnded: false,
      status(c) { this.statusCode = c; return this; },
      setHeader() {},
      flushHeaders() {},
      on() {},
      write(s) { out += s; },
      end(s) {
        out += s || "";
        this.writableEnded = true;
        lastBody = JSON.parse(out.trim());
        resolve(this.statusCode);
      },
      json() { resolve(this.statusCode); },
    };
    handle({ body, on() {} }, res);
  });
}

/** Раздел с промежуточными продуктами — как его записывает разбор моделью. */
function addSection(intermediates) {
  store.listDocuments(); // схема
  store.close();
  const db = new (require("better-sqlite3"))(path.join(store.baseDir(), "sources.sqlite"));
  const doc = db
    .prepare(
      `INSERT INTO documents (sha256, file_name, title, short_title, pages, chars, bytes, added_at, added_via)
       VALUES (?, 'its18.pdf', 'ИТС 18', 'ИТС 18', 100, 1000, 1000, '2026-10-29T00:00:00Z', 'ui')`,
    )
    .run(`its18-${Math.random()}`).lastInsertRowid;
  const id = Number(
    db
      .prepare(
        `INSERT INTO sections (doc_id, ord, title, path, page_from, page_to, text, status, summary)
         VALUES (?, 0, 'Раздел 6', '', 1, 10, 'текст', 'done', 'описание')`,
      )
      .run(doc).lastInsertRowid,
  );
  const link = db.prepare(
    `INSERT OR IGNORE INTO section_products (section_id, key, label, direction, role, origin)
     VALUES (?, ?, ?, 'down', 'intermediate', 'model')`,
  );
  for (const name of intermediates) for (const key of store.nameKeys(name)) link.run(id, key, name);
  db.close();
  return id;
}

test("промежуточные продукты раздела базы — строкой в начале его блока", async () => {
  const sectionId = addSection(["Циклогексанол", "Циклогексанон", "Циклогексаноноксим"]);
  const description = "Капролактам получают из фенола: гидрирование, окисление, оксимирование. ".repeat(40);
  const status = await aggregate({
    productName: "Фенол",
    direction: "down",
    sources: [
      { origin: "local", sectionId, url: `local-sources/documents/1/file?section=${sectionId}`, technology_description: description },
      { title: "Найдено моделью", url: "https://example.com", technology_description: "Бисфенол А из фенола и ацетона." },
    ],
  });
  assert.equal(status, 200);
  const input = captured?.input || "";
  // Описание длиннее блока: строка в начале обрезку переживает.
  assert.match(input, /Промежуточные продукты раздела: Циклогексанол, Циклогексанон, Циклогексаноноксим\.\n/);
  // У источника не из базы такой строки нет.
  assert.equal(input.match(/Промежуточные продукты раздела: [А-ЯЁ]/g).length, 1);
});

test("раздел без промежуточных и сервер без базы — блок как был", async () => {
  const sectionId = addSection([]);
  await aggregate({
    productName: "Фенол",
    direction: "down",
    sources: [{ origin: "local", sectionId, technology_description: "Алкилирование фенола." }],
  });
  assert.doesNotMatch(captured?.input || "", /Промежуточные продукты раздела: [А-ЯЁ]/);

  store.close();
  process.env.LOCAL_SOURCES_DIR = path.join(os.tmpdir(), `step-aggregate-none-${Date.now()}`);
  await aggregate({
    productName: "Фенол",
    direction: "down",
    sources: [{ origin: "local", sectionId: 1, technology_description: "Алкилирование фенола." }],
  });
  assert.match(captured?.input || "", /Алкилирование фенола/);
  // Ради подсказки файл базы не создаётся.
  assert.equal(fs.existsSync(process.env.LOCAL_SOURCES_DIR), false);
});

// ---------- перепрыгивание уровня: дозапрос ----------
const answer = (out, inp, desc) => `# Раскрываемый продукт

**Продукт:** Фенол

# Новый производственный шаг

## Шаг

- **Что производят:** [${out}]

- **Из чего производят:** [${inp}]

- **Побочные продукты:** []

- **Краткая формула шага:** ${out} производят из ${inp}

- **Описание:** ${desc}

# Альтернативы

## Альтернатива: Бисфенол А

- **Что производят:** [Бисфенол А]

- **Из чего производят:** [Фенол, ацетон]

# Примечания

- нет
`;
const SKIP = answer(
  "Капролактам",
  "Фенол, водород, аммиак, серная кислота, олеум",
  "Фенол гидрируют до циклогексанола, его дегидрируют до циклогексанона, оксим циклогексанона перегруппировывают в капролактам.",
);
const FIXED = answer("Циклогексанон", "Фенол, водород", "Фенол гидрируют до циклогексанона.");
const capro = () => addSection(["Циклогексанол", "Циклогексанон", "Лактамное масло"]);

test("выход мимо промежуточных раздела — один дозапрос в той же переписке", async () => {
  process.env.LOCAL_SOURCES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "step-aggregate-skip-"));
  store.close();
  const sectionId = capro();
  const status = await aggregate(
    { productName: "Фенол", direction: "down", sources: [{ origin: "local", sectionId, technology_description: "Капролактам из фенола." }] },
    [SKIP, FIXED],
  );
  assert.equal(status, 200);
  assert.equal(calls.length, 2);
  // Второй запрос — переписка: задание, первый ответ, замечание сервера.
  const [, second] = calls;
  assert.deepEqual(second.input.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(second.input[1].content, SKIP.trim());
  assert.match(second.input[2].content, /Циклогексанол, Циклогексанон/);
  assert.doesNotMatch(second.input[2].content, /Лактамное масло/); // поток, не продукт
  assert.match(lastBody.aggregated_markdown, /\*\*Что производят:\*\* \[Циклогексанон\]/);
  assert.equal(lastBody.levelCheck.changed, true);
});

test("выход — сама ступень или схема без промежуточных — без дозапроса", async () => {
  process.env.LOCAL_SOURCES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "step-aggregate-ok-"));
  store.close();
  const sectionId = capro();
  const src = [{ origin: "local", sectionId, technology_description: "Капролактам из фенола." }];
  await aggregate({ productName: "Фенол", direction: "down", sources: src }, [FIXED]);
  assert.equal(calls.length, 1);
  assert.equal(lastBody.levelCheck, undefined);
  // Источники не из базы — промежуточных не знаем, проверять не по чему.
  await aggregate({ productName: "Фенол", direction: "down", sources: [{ technology_description: "Капролактам из фенола." }] }, [SKIP]);
  assert.equal(calls.length, 1);
});
