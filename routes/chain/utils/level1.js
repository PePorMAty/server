// routes/chain/utils/level1.js

function getSingleValue(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return null;
  return obj[keys[0]];
}

function parseTransformNum(id) {
  const m = String(id || "").match(/^Преобразование(\d+)$/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function buildLevel1(chainJson, targetPid = "Продукт1") {
  const items = Array.isArray(chainJson?.["Цепочка"])
    ? chainJson["Цепочка"]
    : [];

  const products = new Map();
  const transforms = [];

  for (const n of items) {
    if (n?.["Тип узла"] === "Продукт" && typeof n["Id узла"] === "string") {
      products.set(n["Id узла"], n);
    }
    if (n?.["Тип узла"] === "Преобразование") {
      transforms.push(n);
    }
  }

  // ищем преобразование, которое имеет в Выходы targetPid
  const t = transforms
    .filter((tr) => {
      const outs = Array.isArray(tr["Выходы"]) ? tr["Выходы"] : [];
      const outIds = outs.map(getSingleValue).filter(Boolean);
      return outIds.includes(targetPid);
    })
    .sort(
      (a, b) =>
        parseTransformNum(a["Id узла"]) - parseTransformNum(b["Id узла"]),
    )[0];

  if (!t) return null;

  const ins = Array.isArray(t["Входы"]) ? t["Входы"] : [];
  const inputPids = [...new Set(ins.map(getSingleValue).filter(Boolean))];

  const sub = [];
  if (products.get(targetPid)) sub.push(products.get(targetPid));
  sub.push(t);
  for (const pid of inputPids) {
    if (products.get(pid)) sub.push(products.get(pid));
  }

  return {
    targetPid,
    transformationId: t["Id узла"],
    inputPids,
    chain: { Цепочка: sub },
  };
}

module.exports = { buildLevel1 };
