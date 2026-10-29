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
