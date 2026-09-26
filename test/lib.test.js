// Чистые функции: упаковка строк, разрешения и примитивы форматирования.
//
// Всё, что здесь проверяется, объединяет одно свойство: ошибка в них не падает, а тихо
// меняет смысл. Упаковка, потерявшая undefined, превратит «поля нет» в «поле пустое».
// riskyPerms, вернувший пустой массив вместо null, превратит «не проверяли» в «опасных
// разрешений нет». short, вернувший «0» вместо прочерка, превратит «неизвестно» в ноль.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packRows, UNPACK_JS } from '../src/lib/pack.js';
import { parsePerms, permsLang, riskyPerms, copyability } from '../src/lib/permissions.js';
import { COMMON_JS } from '../src/lib/report-common.js';

// ---------- упаковка ----------
const unpack = new Function(`${UNPACK_JS}; return unpackRows;`)();
const rows = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ a: i, b: 'x' + i, c: null, ...extra }));

test('упаковка и распаковка возвращают то же самое', () => {
  const src = rows(30);
  const packed = packRows(src);
  assert.ok(packed.__c && packed.__r, 'однородный массив должен упаковаться');
  assert.deepEqual(unpack(packed), src);
});

test('короткий массив не упаковывается — служебные ключи дороже выигрыша', () => {
  const src = rows(5);
  assert.deepEqual(packRows(src), src);
});

test('неоднородный массив остаётся как есть — иначе поля разъедутся по колонкам', () => {
  const src = rows(30);
  src[7] = { a: 7, b: 'x7' };                       // нет колонки c
  const packed = packRows(src);
  assert.equal(packed.__c, undefined);
  assert.deepEqual(packed, src);
});

test('undefined не упаковывается: «поля нет» и «поле пустое» — разные утверждения', () => {
  const src = rows(30);
  src[3].c = undefined;
  const packed = packRows(src);
  assert.equal(packed.__c, undefined, 'строка с undefined не должна была упаковаться');
});

test('null переживает упаковку и остаётся null, а не превращается в пусто', () => {
  const src = rows(30);
  const back = unpack(packRows(src));
  assert.equal(back[0].c, null);
  assert.ok('c' in back[0]);
});

// ---------- разрешения ----------
const RISKY = ['read sms', 'read contacts', 'access fine location'];

test('язык списка разрешений определяется по словам, а не по флагу', () => {
  assert.equal(permsLang(['Read SMS', 'Camera']), 'en');
  assert.equal(permsLang(['Чтение SMS', 'Камера']), 'other');
  assert.equal(permsLang(null), null);
});

test('неанглийский список даёт «не проверяли», а не «опасного нет»', () => {
  // Ровно эта ошибка держалась в отчёте: Play отдаёт названия разрешений на языке витрины,
  // английские образцы по ним не совпадали ни разу, и все приложения выглядели чистыми.
  assert.equal(riskyPerms(['Чтение SMS', 'Камера'], RISKY), null);
  assert.deepEqual(riskyPerms(['Camera'], RISKY), []);
  assert.deepEqual(riskyPerms(['Read SMS', 'Camera'], RISKY), ['Read SMS'], 'возвращаются исходные подписи: в отчёте важно, ЧТО именно требует приложение');
});

test('копируемость не выдаёт вердикт по непроверенному списку', () => {
  const unchecked = copyability({ perms: ['Чтение SMS'], riskyLabels: RISKY, genreId: 'TOOLS', policyRiskCats: new Set(), feedCats: new Set() });
  assert.ok(!unchecked.checked, 'список не на английском — проверки не было');
  const easy = copyability({ perms: ['Camera'], riskyLabels: RISKY, genreId: 'TOOLS', policyRiskCats: new Set(), feedCats: new Set() });
  assert.equal(easy.level, 'easy');
  const hard = copyability({ perms: ['Read SMS'], riskyLabels: RISKY, genreId: 'MEDICAL', policyRiskCats: new Set(['MEDICAL']), feedCats: new Set() });
  assert.notEqual(hard.level, 'easy');
  assert.ok(hard.reasons.length, 'вердикт «дороже» обязан называть причину');
});

test('разбор разрешений переживает мусор', () => {
  assert.equal(parsePerms(null), null);
  assert.equal(parsePerms('не json'), null);
  assert.deepEqual(parsePerms('["Camera"]'), ['Camera']);
});

// ---------- примитивы отчёта ----------
const C = new Function(`${COMMON_JS}; return { esc, isNum, short, int, fix, pct, dash, dmy, median, doorRatio };`)();

test('пусто — это прочерк, а не ноль', () => {
  for (const f of ['short', 'int', 'fix', 'pct']) {
    assert.equal(C[f](null), '—', `${f}(null)`);
    assert.equal(C[f](undefined), '—', `${f}(undefined)`);
    assert.equal(C[f](NaN), '—', `${f}(NaN)`);
  }
  assert.equal(C.short(0), '0', 'ноль — это ноль, его прятать нельзя');
});

test('сокращение чисел', () => {
  assert.equal(C.short(999), '999');
  assert.equal(C.short(1500), '1.5K');
  assert.equal(C.short(12000), '12K');
  assert.equal(C.short(1.2e6), '1.2M');
  assert.equal(C.short(3.4e9), '3.4B');
  assert.equal(C.short(-1500), '-1.5K');
});

test('экранирование закрывает апостроф — значения уходят в атрибуты', () => {
  assert.equal(C.esc(`Bob's <b>app</b>`), 'Bob&#39;s &lt;b&gt;app&lt;/b&gt;');
  assert.equal(C.esc(null), '');
});

test('прочерк всегда несёт причину', () => {
  assert.match(C.dash(), /title="нет данных"/);
  assert.match(C.dash('дверь не посчитана'), /title="дверь не посчитана"/);
});

test('отношение дверей не печатает миллионы с десятой долей', () => {
  assert.equal(C.doorRatio(1000, 100), '×10');
  assert.equal(C.doorRatio(150, 100), '×1.5');
  assert.match(C.doorRatio(5.1e6, 3), /почти без установок/);
  assert.equal(C.doorRatio(100, 0), '', 'деление на нулевую дверь смысла не имеет');
  assert.equal(C.doorRatio(null, 100), '');
});

test('дата и медиана', () => {
  assert.equal(C.dmy('2026-09-27'), '27.09.2026');
  assert.equal(C.dmy(null), '—');
  assert.equal(C.median([3, 1, 2]), 2);
  assert.equal(C.median([4, 1, 2, 3]), 2.5);
  assert.equal(C.median([]), null);
  assert.equal(C.median([1, null, 3]), 2, 'пустые значения не участвуют в медиане');
});
