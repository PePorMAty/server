// Источники шага, найденные моделью, — проверка сервером
// (routes/step/utils/verifySources.js). Страницы не грузятся: загрузчик
// подменён. Случаи — из живого прогона 2026-10-29.
//
//   npm test

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { verifyStepSources, isPlaceholder } = require("../routes/step/utils/verifySources");

class SourceError extends Error {}
const pages = {
  "https://patents.google.com/patent/US4560176A/en": { title: "US4560176A - Inverted cone stuffing box", text: "A stuffing box for a pump shaft with an inverted cone packing ... ".repeat(40) },
  "https://www.textileworld.com/x/": new SourceError("страницы нет (HTTP 404)"),
  "https://pubs.acs.org/doi/10.1021/x": new SourceError("доступ закрыт (HTTP 403): нужен вход или сайт не пускает сервер"),
  "https://surfactants-handbook.org/ape-sulfation": { title: "Sulfation of alkylphenol ethoxylates", text: "Alkylphenol polyglycol ether sulfates are obtained by sulfation of the ethoxylates with SO3 ... ".repeat(20) },
};
const fetchPage = async (url) => {
  const p = pages[url];
  if (!p) throw new SourceError("адрес сайта не найден (DNS)");
  if (p instanceof Error) throw p;
  return p;
};

const src = (title, url, extra = {}) => ({ title, url, access_hint: "open html", technology_description: "…", ...extra });

test("заглушка «источников нет» — не источник", () => {
  assert.equal(
    isPlaceholder(src("Отсутствие подтвержденных открытых источников с детальным технологическим описанием", "https://N/A", { access_hint: "no_valid_source_found" })),
    true,
  );
  assert.equal(isPlaceholder(src("Alkylphenol Ethoxylates", "https://www.sciencedirect.com/topics/chemistry/alkylphenol-ethoxylate")), false);
});

test("чужая страница, 404 и несуществующий сайт — отброшены; закрытый сайт — «не проверен»", async () => {
  const { kept, dropped } = await verifyStepSources(
    [
      src("Patent US4560176A - Process for preparing alkylphenol polyglycol ether sulfates", "https://patents.google.com/patent/US4560176A/en"),
      src("Industrial Applications of Nonionic Surfactants: Textile Processing", "https://www.textileworld.com/x/"),
      src("Surfactants in Pesticide Formulations: Role of Alkylphenol Ethoxylates", "https://pubs.acs.org/doi/10.1021/x"),
      src("Sulfation of Alkylphenol Ethoxylates to Ether Sulfates", "https://surfactants-handbook.org/ape-sulfation"),
      src("Нет такого сайта", "https://no-such-host.invalid/page"),
      src("Отсутствие источников", "https://N/A", { access_hint: "no_valid_source_found" }),
      { origin: "local", title: "Раздел 10 ИТС 31", url: "local-sources/documents/3/file?section=127", technology_description: "…" },
    ],
    { fetchPage },
  );
  assert.deepEqual(
    kept.map((k) => [k.title.slice(0, 20), k.server_check?.status ?? "local"]),
    [
      ["Surfactants in Pesti", "unchecked"],
      ["Sulfation of Alkylph", "ok"],
      ["Раздел 10 ИТС 31", "local"],
    ],
  );
  assert.equal(dropped.length, 4);
  assert.match(dropped.find((d) => /US4560176A/.test(d.title)).reason, /другая страница: «US4560176A - Inverted cone stuffing box»/);
  assert.match(dropped.find((d) => /Textile/.test(d.title)).reason, /404/);
});

// Живой прогон 2026-11-03: на поиск вниз от «Алкилсалицилатные присадки»
// модель вернула страницы о веб-технологиях и машинном обучении. Страницы
// настоящие — проверка страницы их пропускала.
const { aboutProduct } = require("../routes/step/utils/verifySources");

test("источник не о продукте — отброшен ещё до загрузки страницы", async () => {
  let fetched = 0;
  const { kept, dropped } = await verifyStepSources(
    [
      src("GitHub: mattpocock/skills", "https://github.com/mattpocock/skills", {
        technology_description: "Репозиторий содержит набор навыков и упражнений для изучения современных веб-технологий.",
        evidence_snippets: ["2026年5月GitHub最受欢迎的十大开源AI项目全解析"],
      }),
      src("World Bank Data360", "https://data.worldbank.org/", {
        technology_description: "Data360 — это платформа Всемирного банка, предоставляющая доступ к данным.",
      }),
      src("Overbased calcium alkyl salicylate detergents for marine engine oils", "https://lubes.example.net/salicylates", {
        technology_description: "Алкилсалицилаты кальция вводят в судовые моторные масла.",
      }),
    ],
    { productName: "Алкилсалицилатные присадки", fetchPage: async () => (fetched++, { title: "Overbased calcium alkyl salicylate detergents", text: "x" }) },
  );
  assert.deepEqual(kept.map((k) => k.title.slice(0, 15)), ["Overbased calci"]);
  assert.equal(fetched, 1);
  assert.match(dropped[0].reason, /не о «Алкилсалицилатные присадки» и вообще не о химии/);
});

// Тот же день: у «Полиэтилена низкой плотности» источники звали его LDPE —
// сокращения в справочнике нет, но это химия, и источник остаётся.
test("продукт назван сокращением — источник о химии остаётся", async () => {
  const { kept, dropped } = await verifyStepSources(
    [
      src("Hydrocracking of LDPE to Produce Lubricant Base Oils", "https://www.mdpi.com/2073-4344/12/5/512", {
        technology_description: "Гидрокрекинг ПЭНП на бифункциональных катализаторах даёт базовые масла.",
      }),
    ],
    { productName: "Полиэтилен низкой плотности", fetchPage: async () => ({ title: "Hydrocracking of LDPE to Produce Lubricant Base Oils", text: "x" }) },
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test("продукт назван по-английски — источник о нём", () => {
  const about = (product, title) => aboutProduct({ title, technology_description: "" }, product);
  for (const [product, title] of [
    ["Оксиэтилированный алкилфенол", "Alkylphenol Ethoxylates: Production, Properties and Applications"],
    ["Фенол", "Caprolactam Production via Phenol Route"],
    ["Хлорбензол", "Nitration of chlorobenzene"],
    ["Этиленгликоль", "Ethylene glycol to polyester fibres"],
    ["Стирол", "Styrene polymerization"],
    ["Ацетон", "Acetone cyanohydrin route to MMA"],
    ["Гексан", "Hexane as extraction solvent"],
  ]) {
    assert.equal(about(product, title), true, `${product} ~ ${title}`);
  }
  assert.equal(about("Фенол", "NVIDIA Open Source Projects"), false);
});

test("ответы модели «данных нет» в виде источника — заглушки", () => {
  for (const title of [
    "Общий обзор отсутствия данных по конкретному веществу в открытых базах",
    "Заключение о невозможности выполнения задачи в заданном формате с текущими данными",
    "Неприменимость предоставленных материалов к задаче",
  ]) {
    assert.equal(isPlaceholder(src(title, "https://www.example-science.org/x")), true, title);
  }
});
