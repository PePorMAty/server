// routes/chain/utils/validate.js

const reProdId = /^Продукт\d+$/;
const reTrId = /^Преобразование\d+$/;
const reInKey = /^вход \d+$/;
const reOutKey = /^выход \d+$/;

function validateChain(data) {
  const errors = [];

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return ["Корень JSON должен быть объектом (dict)."];
  }
  if (!("Цепочка" in data) || !Array.isArray(data["Цепочка"])) {
    return ['Должен быть ключ "Цепочка" со значением-массивом.'];
  }

  const chain = data["Цепочка"];
  if (chain.length === 0) errors.push('"Цепочка" не должна быть пустой.');

  const productIds = new Set();
  const nodeIds = new Set();

  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    const idx = i + 1;

    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push(`Узел #${idx} не объект.`);
      continue;
    }

    const t = node["Тип узла"];
    const nid = node["Id узла"];

    if (typeof t !== "string" || (t !== "Продукт" && t !== "Преобразование")) {
      errors.push(
        `Узел #${idx}: неверный 'Тип узла' (ожидается Продукт/Преобразование).`,
      );
    }

    if (typeof nid !== "string") {
      errors.push(`Узел #${idx}: 'Id узла' должен быть строкой.`);
    } else {
      if (nodeIds.has(nid)) errors.push(`Дублирующийся 'Id узла': ${nid}`);
      nodeIds.add(nid);
    }

    if (t === "Продукт") {
      if (!reProdId.test(String(nid || ""))) {
        errors.push(`Продукт-узел #${idx}: Id узла должен быть ПродуктN.`);
      }

      const prods = node["Продукты"];
      const name = node["Название узла"];

      if (
        !Array.isArray(prods) ||
        prods.length < 1 ||
        !prods.every((x) => typeof x === "string" && x.trim())
      ) {
        errors.push(
          `Продукт-узел #${idx}: 'Продукты' должен быть массивом непустых строк.`,
        );
      }
      if (typeof name !== "string" || !name.trim()) {
        errors.push(
          `Продукт-узел #${idx}: 'Название узла' должен быть непустой строкой.`,
        );
      }

      if (typeof nid === "string" && reProdId.test(nid)) productIds.add(nid);
    }

    if (t === "Преобразование") {
      if (!reTrId.test(String(nid || ""))) {
        errors.push(
          `Преобразование-узел #${idx}: Id узла должен быть ПреобразованиеN.`,
        );
      }

      const tech = node["Название технологии"];
      if (typeof tech !== "string" || !tech.trim()) {
        errors.push(
          `Преобразование-узел #${idx}: 'Название технологии' должен быть непустой строкой.`,
        );
      }

      for (const [field, keyRe] of [
        ["Входы", reInKey],
        ["Выходы", reOutKey],
      ]) {
        const arr = node[field];

        if (!Array.isArray(arr) || arr.length === 0) {
          errors.push(
            `Преобразование-узел #${idx}: '${field}' должен быть непустым массивом.`,
          );
          continue;
        }

        for (let j = 0; j < arr.length; j++) {
          const obj = arr[j];
          const jj = j + 1;

          if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            errors.push(
              `Преобразование-узел #${idx}: ${field}[${jj}] должен быть объектом.`,
            );
            continue;
          }

          const keys = Object.keys(obj);
          if (keys.length !== 1) {
            errors.push(
              `Преобразование-узел #${idx}: ${field}[${jj}] должен содержать ровно 1 пару ключ-значение.`,
            );
            continue;
          }

          const k = keys[0];
          const v = obj[k];

          const example = field === "Входы" ? "вход 1" : "выход 1";
          if (typeof k !== "string" || !keyRe.test(k)) {
            errors.push(
              `Преобразование-узел #${idx}: ${field}[${jj}] ключ должен быть вида '${example}'.`,
            );
          }
          if (typeof v !== "string" || !reProdId.test(v)) {
            errors.push(
              `Преобразование-узел #${idx}: ${field}[${jj}] значение должно быть Id продукта вида 'ПродуктN'.`,
            );
          }
        }
      }
    }
  }

  if (!productIds.has("Продукт1")) {
    errors.push(
      "Обязательный финальный продукт 'Продукт1' отсутствует среди продукт-узлов.",
    );
  }

  // Проверка ссылок на существующие продукты
  for (const node of chain) {
    if (node?.["Тип узла"] === "Преобразование") {
      for (const field of ["Входы", "Выходы"]) {
        const arr = node[field];
        if (!Array.isArray(arr)) continue;

        for (const obj of arr) {
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            const keys = Object.keys(obj);
            if (keys.length === 1) {
              const pid = obj[keys[0]];
              if (
                typeof pid === "string" &&
                reProdId.test(pid) &&
                !productIds.has(pid)
              ) {
                errors.push(
                  `Ссылка на ${pid} из ${node["Id узла"]}:${field}, но такого продукт-узла нет.`,
                );
              }
            }
          }
        }
      }
    }
  }

  return errors;
}

module.exports = { validateChain };
