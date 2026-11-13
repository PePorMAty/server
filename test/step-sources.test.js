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
    // Crossref здесь не спрашиваем: закрытый сайт остаётся «не проверен».
    { fetchPage, crossref: async () => null },
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
  assert.match(dropped[0].reason, /не о «Алкилсалицилатные присадки» и вообще не о производстве/);
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

// ---------- сверка научных ссылок с Crossref (utils/crossref.js) ----------
// DOI из ответов модели 2026-11-03 и что за ними на самом деле (Crossref).
const { crossrefCheck, doiFromUrl, sameTitle } = require("../routes/step/utils/crossref");

const crossrefWorks = {
  "10.1021/bk-2005-0906.ch001": "Semiochemicals in Pest and Weed Control: An Introduction",
  "10.1038/s41598-021-98765-4": "Predictors for depressive symptoms by four types of disability",
  "10.1021/ie00045a001": "Liquid-phase oxidation of cyclohexane to cyclohexanol and cyclohexanone",
};
const crossrefSearch = {
  "Hydrocracking of polyethylene waste to lubricant base oils": [{ DOI: "10.1016/j.fuel.2020.118000", title: ["Hydrocracking of polyethylene waste into lubricant base oils"] }],
};
/** Подменённый Crossref: ответ по DOI или поиск по названию. */
const fakeCrossref = async (url) => {
  const u = new URL(url);
  const doi = decodeURIComponent(u.pathname.replace(/^\/works\/?/, ""));
  if (doi) {
    const title = crossrefWorks[doi];
    return title ? { ok: true, status: 200, json: async () => ({ message: { title: [title] } }) } : { ok: false, status: 404 };
  }
  const items = crossrefSearch[u.searchParams.get("query.bibliographic")] || [{ DOI: "10.1/other", title: ["Something else entirely"] }];
  return { ok: true, status: 200, json: async () => ({ message: { items } }) };
};
const check = (item) => crossrefCheck(item, { fetchImpl: fakeCrossref });

test("DOI из адреса статьи: /doi/, doi.org, Springer, Nature", () => {
  assert.equal(doiFromUrl("https://pubs.acs.org/doi/10.1021/bk-2005-0906.ch001"), "10.1021/bk-2005-0906.ch001");
  assert.equal(doiFromUrl("https://onlinelibrary.wiley.com/doi/full/10.1002/app.56789"), "10.1002/app.56789");
  assert.equal(doiFromUrl("https://link.springer.com/chapter/10.1007/978-1-4615-1759-3_10"), "10.1007/978-1-4615-1759-3_10");
  assert.equal(doiFromUrl("https://www.nature.com/articles/s41598-021-98765-4"), "10.1038/s41598-021-98765-4");
  assert.equal(doiFromUrl("https://www.sciencedirect.com/science/article/pii/S0016236121005678"), null);
});

test("названия сравниваются по словам, без окончаний и разметки", () => {
  assert.equal(sameTitle("Alkylphenol Ethoxylates in Textile Processing", "Alkylphenol ethoxylate in <i>textile</i> processing"), true);
  assert.equal(sameTitle("Surfactants in Pesticide Formulations: Role of Alkylphenol Ethoxylates", "Semiochemicals in Pest and Weed Control: An Introduction"), false);
  // «hydrocracking» ≠ «hydrocarbon»: по 6 буквам совпадали (живой Crossref 2026-11-12).
  assert.equal(sameTitle("Hydrocracking of LDPE to Produce Lubricant Base Oils", "Guide for Characterizing Hydrocarbon Lubricant Base Oils"), false);
});

test("DOI ведёт на чужую статью или его нет — выдумана; совпал — настоящая", async () => {
  const acs = await check({ title: "Surfactants in Pesticide Formulations: Role of Alkylphenol Ethoxylates", url: "https://pubs.acs.org/doi/10.1021/bk-2005-0906.ch001" });
  assert.equal(acs.status, "unrelated");
  assert.match(acs.reason, /другая статья: «Semiochemicals in Pest and Weed Control/);
  assert.equal((await check({ title: "Solvent-Free Functionalization of LDPE", url: "https://onlinelibrary.wiley.com/doi/10.1002/app.56789" })).status, "missing");
  assert.deepEqual(await check({ title: "Liquid-phase oxidation of cyclohexane", url: "https://pubs.acs.org/doi/10.1021/ie00045a001" }), { status: "ok" });
});

test("статья без DOI в адресе: Crossref ищет по названию; не нашёл — выдумана; сайт не научный — не наш вопрос", async () => {
  const real = await check({ title: "Hydrocracking of polyethylene waste to lubricant base oils", url: "https://www.sciencedirect.com/science/article/pii/S0016236120301234" });
  assert.deepEqual(real, { status: "ok", url: "https://doi.org/10.1016/j.fuel.2020.118000", reason: "адрес исправлен по Crossref" });
  const fake = await check({ title: "Пиролизная жидкость как сырье для производства топлив и химикатов", url: "https://www.sciencedirect.com/science/article/pii/S0360544221001234" });
  assert.equal(fake.status, "unrelated");
  assert.equal(await check({ title: "LDPE film market", url: "https://www.plasticsnews.com/ldpe" }), null);
  // Подборка ScienceDirect — настоящая страница, а не статья: в Crossref её нет.
  assert.equal(await check({ title: "Alkylphenol Ethoxylate — an overview", url: "https://www.sciencedirect.com/topics/chemistry/alkylphenol-ethoxylate" }), null);
});

test("закрытый сайт издательства: выдумка выброшена, настоящая статья — с исправленным адресом", async () => {
  const closed = async () => {
    throw new SourceError("доступ закрыт (HTTP 403): нужен вход или сайт не пускает сервер");
  };
  const { kept, dropped } = await verifyStepSources(
    [
      src("Surfactants in Pesticide Formulations: Role of Alkylphenol Ethoxylates", "https://pubs.acs.org/doi/10.1021/bk-2005-0906.ch001"),
      src("Hydrocracking of polyethylene waste to lubricant base oils", "https://www.sciencedirect.com/science/article/pii/S0016236120301234"),
      src("Alkylphenol ethoxylates market report", "https://www.marketsandmarkets.com/ape"),
    ],
    { fetchPage: closed, crossref: (item, o) => crossrefCheck(item, { ...o, fetchImpl: fakeCrossref }) },
  );
  assert.deepEqual(
    kept.map((k) => [k.url, k.server_check.status]),
    [
      ["https://doi.org/10.1016/j.fuel.2020.118000", "ok"],
      ["https://www.marketsandmarkets.com/ape", "unchecked"],
    ],
  );
  assert.equal(kept[0].model_url, "https://www.sciencedirect.com/science/article/pii/S0016236120301234");
  assert.match(dropped[0].reason, /другая статья/);
});

test("Crossref недоступен — источник остаётся «не проверен»", async () => {
  const { kept } = await verifyStepSources([src("Liquid-phase oxidation of cyclohexane", "https://pubs.acs.org/doi/10.1021/ie00045a001")], {
    fetchPage: async () => {
      throw new SourceError("доступ закрыт (HTTP 403)");
    },
    crossref: async () => {
      throw new Error("Crossref: HTTP 503");
    },
  });
  assert.equal(kept[0].server_check.status, "unchecked");
});

// 2026-11-13: «Автомобиль» и «Самолёт» вверх — источники по-английски о сборке
// («car», «aircraft»): названия продукта в них нет, а слов химии — тоже, и
// проверка их выбрасывала. Поиск — не только о химии.
const { aboutProduction } = require("../routes/step/utils/verifySources");

test("источник о производстве не химии — остаётся, хоть продукт назван иначе", async () => {
  const { kept, dropped } = await verifyStepSources(
    [
      src("How a car is made: body in white, paint shop and final assembly", "https://www.madehow.com/Volume-1/Automobile.html", {
        technology_description: "Steel coils are stamped into panels, welded into the body, painted; engine and transmission are installed on the assembly line.",
      }),
      src("Aircraft manufacturing: fuselage sections, wings and final assembly line", "https://en.wikipedia.org/wiki/Aircraft_manufacturing", {
        technology_description: "Aluminium alloys and composite materials are used for fuselage panels; suppliers deliver engines and avionics.",
      }),
    ],
    {
      productName: "Автомобиль",
      fetchPage: async (url) =>
        url.includes("madehow")
          ? { title: "How a car is made", text: "Body in white: panels are welded; the paint shop; final assembly of the car. ".repeat(20) }
          : { title: "Aircraft manufacturing", text: "Fuselage sections and wings arrive at the final assembly line. ".repeat(20) },
    },
  );
  assert.equal(dropped.length, 0, JSON.stringify(dropped));
  assert.equal(kept.length, 2);
  assert.equal(aboutProduction({ title: "GitHub: mattpocock/skills", technology_description: "Репозиторий навыков для изучения веб-технологий; производительность вычислений." }), false);
});

// ---------- список найденных поиском страниц (Responses API, 2026-11-13) ----------
const { pageKey } = require("../routes/step/utils/verifySources");
const { normalizeAndFilterItems } = require("../routes/sources/utils/openai");

test("адрес не из найденного поиском — выдуман; www, параметры и косая черта не мешают", async () => {
  const searched = [
    "https://www.airbus.com/en/products-services/commercial-aircraft/the-life-cycle-of-an-aircraft/production",
    "https://global.toyota/en/company/plant-tours/assembly/index.html?utm=x",
  ];
  const { kept, dropped } = await verifyStepSources(
    [
      src("Production - Airbus", "https://airbus.com/en/products-services/commercial-aircraft/the-life-cycle-of-an-aircraft/production/", { technology_description: "Aircraft final assembly lines." }),
      src("Car Production Process: Assembly", "https://global.toyota/en/company/plant-tours/assembly/index.html", { technology_description: "Final assembly of the car." }),
      src("Ту-214: производственные мощности", "https://example-aero.ru/tu-214", { technology_description: "Сборка самолёта." }),
    ],
    { productName: "Самолёт", searched, fetchPage: async (url) => ({ title: url.includes("toyota") ? "Car Production Process: Assembly" : "Production - Airbus", text: "Production Airbus car assembly process ".repeat(20) }) },
  );
  assert.deepEqual(kept.map((k) => k.title), ["Production - Airbus", "Car Production Process: Assembly"]);
  assert.match(dropped[0].reason, /нет среди страниц, найденных поиском/);
  assert.equal(pageKey("https://www.Example.com/a/b/?q=1#x"), "example.com/a/b");
});

test("поле описания под другим именем (technological_description) — не теряется", () => {
  const [it] = normalizeAndFilterItems([
    { title: "Production - Airbus", url: "https://www.airbus.com/production", technological_description: "Airbus has more than 20 manufacturing sites.", evidence: ["20 sites"] },
  ]);
  assert.equal(it.technology_description, "Airbus has more than 20 manufacturing sites.");
  assert.deepEqual(it.evidence_snippets, ["20 sites"]);
});
