// Колоночная упаковка данных отчёта.
//
// В отчёт уходит 6+ тысяч карточек по 108 полей каждая. В обычном JSON имена полей
// повторяются в каждой строке и съедают около 70 % веса: отчёт перевалил за 17 МБ
// и перестал влезать в лимит артефакта (16 МБ). Упаковка выносит имена полей один
// раз в __c, а строки кладёт массивами значений в __r.
//
// Упаковывается только однородный массив: у всех объектов совпадает набор и порядок
// ключей, и ни одно значение не равно undefined. Второе условие не формальность.
// Отчёт различает отсутствующее поле (скрывается) и null (рисуется прочерком),
// а JSON внутри массива превращает undefined в null — то есть упаковка такой строки
// молча поменяла бы смысл. Вместо служебного маркера в данных такой массив просто
// остаётся неупакованным: на практике значения приходят из SQLite, где есть null,
// но не бывает undefined, так что отказ не срабатывает и вес не страдает.
//
// UNPACK_JS — тот же разбор для шаблона, единственная копия на оба отчёта.

const MIN_ROWS = 20;  // ниже этого выигрыш не покрывает служебные ключи

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function uniformKeys(arr) {
  if (arr.length < MIN_ROWS || !arr.every(isPlainObject)) return null;
  const keys = Object.keys(arr[0]);
  if (!keys.length) return null;
  const signature = keys.join('\t');
  for (const row of arr) {
    const k = Object.keys(row);
    if (k.length !== keys.length || k.join('\t') !== signature) return null;
    for (const key of keys) if (row[key] === undefined) return null;
  }
  return keys;
}

export function packRows(value) {
  if (Array.isArray(value)) {
    const keys = uniformKeys(value);
    if (keys) return { __c: keys, __r: value.map((row) => keys.map((k) => packRows(row[k]))) };
    return value.map(packRows);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = packRows(v);
    return out;
  }
  return value;
}

export const UNPACK_JS = `function unpackRows(v) {
    if (Array.isArray(v)) return v.map(unpackRows);
    if (v && typeof v === 'object') {
      if (Array.isArray(v.__c) && Array.isArray(v.__r)) {
        var cols = v.__c;
        return v.__r.map(function (row) {
          var o = {};
          for (var i = 0; i < cols.length; i++) o[cols[i]] = unpackRows(row[i]);
          return o;
        });
      }
      var out = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = unpackRows(v[k]);
      return out;
    }
    return v;
  }`;
