// Самопроверка модуля объёма поиска на синтетике: node tools/selftest-kw.js
// Сеть не трогает, в базу радара не пишет — все проверки на данных, сгенерированных здесь.
// Синтетика нужна, чтобы проверить сам код (алгоритм, модели, валидацию), а не методику:
// качество методики на реальных словах проверяется только выгрузкой Play Console.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// База — временный файл. Путь к базе фиксируется при загрузке db.js, поэтому переменная
// выставляется до первого импорта модуля, а сами модули подгружаются динамически.
const TMP_DB = path.join(os.tmpdir(), `kw-selftest-${process.pid}.db`);
process.env.RADAR_DB = TMP_DB;
const { scorePhrase, percentileScores, positionOf, scriptOf, wLen, wPos } = await import('../src/lib/kw/popularity.js');
const { spearman } = await import('../src/lib/util.js');
const { DB_PATH } = await import('../src/lib/db.js');
assert.equal(DB_PATH, TMP_DB, 'самопроверка не должна открывать базу радара');

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Детерминированный генератор, чтобы проверки не мигали.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Модель подсказок Play: на префикс — пять самых популярных фраз, начинающихся с него.
function syntheticStore(seed = 7, n = 600) {
  const r = rng(seed);
  const heads = ['photo', 'phone', 'piano', 'plant', 'player', 'planner', 'pdf', 'podcast', 'poker', 'pixel'];
  const tails = ['editor', 'scanner', 'app', 'maker', 'lessons', 'identifier', 'tracker', 'reader', 'games', 'cleaner',
    'booster', 'widget', 'free', 'offline', 'pro', 'for kids', 'collage', 'recorder', 'translator', 'timer'];
  const phrases = new Map();
  for (const h of heads) phrases.set(h, Math.exp(9 + r() * 3));
  while (phrases.size < n) {
    const h = heads[Math.floor(r() * heads.length)];
    const t1 = tails[Math.floor(r() * tails.length)];
    const t2 = r() < 0.4 ? ' ' + tails[Math.floor(r() * tails.length)] : '';
    const p = `${h} ${t1}${t2}`;
    if (!phrases.has(p)) phrases.set(p, Math.exp(r() * 10) * (t2 ? 0.2 : 1));
  }
  const list = [...phrases].sort((a, b) => b[1] - a[1]);
  let calls = 0;
  const suggest = (prefix) => {
    calls++;
    return list.filter(([p]) => p.startsWith(prefix)).slice(0, 5).map(([p]) => p);
  };
  return { phrases, suggest, calls: () => calls };
}

const lookupOf = (suggest) => async (prefix) => ({ values: suggest(prefix), cached: false });

test('веса и позиция в списке', () => {
  assert.equal(wLen(3, 10), 0.8);
  assert.equal(wPos(1), 1);
  assert.ok(Math.abs(wPos(5) - 1 / Math.pow(5, 0.7)) < 1e-12);
  assert.equal(positionOf(['a b', 'Photo  Editor'], 'photo editor'), 2);
  assert.equal(positionOf(['a'], 'b'), null);
  assert.equal(scriptOf('電卓'), 'han');
  assert.equal(scriptOf('계산기'), 'hangul');
  assert.equal(scriptOf('photo'), 'latin');
});

test('exact считает сумму по всем префиксам вручную', async () => {
  // Фраза длиной 6: появляется с i=4 на 2-й позиции, с i=5 на 1-й.
  const answers = { 'abc': ['x'], 'abcd': ['y', 'abcdef'], 'abcde': ['abcdef'], 'abcdef': ['abcdef'] };
  const res = await scorePhrase('abcdef', { mode: 'exact', lookup: async (p) => ({ values: answers[p] || [], cached: false }) });
  const expected = wLen(4, 6) * wPos(2) + wLen(5, 6) * wPos(1) + wLen(6, 6) * wPos(1);
  assert.ok(Math.abs(res.score_raw - expected) < 1e-12, `${res.score_raw} != ${expected}`);
  assert.equal(res.min_prefix_len, 4);
  assert.equal(res.requests, 4);
  assert.equal(res.prefix_hit_share, 3 / 4);
});

test('фразы нет даже целиком — ноль за один запрос', async () => {
  let calls = 0;
  const res = await scorePhrase('rare phrase here', { mode: 'binary', lookup: async () => { calls++; return { values: [], cached: false }; } });
  assert.equal(res.score_raw, 0);
  assert.equal(res.min_prefix_len, null);
  assert.equal(calls, 1);
});

test('binary находит ту же точку появления, что exact, и дешевле', async () => {
  const store = syntheticStore();
  const terms = [...store.phrases.keys()].filter((p) => p.length >= 8).slice(0, 200);
  let exactReq = 0, binReq = 0, sameMin = 0;
  const exact = [], binary = [], rough = [], truth = [];
  for (const t of terms) {
    const e = await scorePhrase(t, { mode: 'exact', lookup: lookupOf(store.suggest) });
    const b = await scorePhrase(t, { mode: 'binary', lookup: lookupOf(store.suggest) });
    const r = await scorePhrase(t, { mode: 'rough', lookup: lookupOf(store.suggest) });
    exactReq += e.requests; binReq += b.requests;
    if (e.min_prefix_len === b.min_prefix_len) sameMin++;
    assert.ok(b.score_raw <= e.score_raw + 1e-9, `binary завысил «${t}»: ${b.score_raw} > ${e.score_raw}`);
    exact.push(e.score_raw); binary.push(b.score_raw); rough.push(r.score_raw); truth.push(store.phrases.get(t));
  }
  const rhoEB = spearman(exact, binary), rhoTruth = spearman(truth, exact), rhoRough = spearman(exact, rough);
  console.log(`      запросов exact ${exactReq}, binary ${binReq} (${(binReq / terms.length).toFixed(1)} на фразу); ` +
    `ρ(exact, binary) ${rhoEB.toFixed(3)}, ρ(exact, rough) ${rhoRough.toFixed(3)}, ρ(истина, exact) ${rhoTruth.toFixed(3)}`);
  assert.equal(sameMin, terms.length, 'в монотонной модели точка появления должна совпасть');
  assert.ok(binReq < exactReq / 2, 'бинарный поиск должен экономить больше половины запросов');
  assert.ok(rhoEB > 0.9);
  assert.ok(rhoTruth > 0.3, 'score должен упорядочивать слова по популярности');
});

// Находка на синтетике, а не требование ТЗ: формула 4.2 растёт с длиной фразы, потому что
// у длинной фразы больше слагаемых, а w_len = (L − i + 1) / L этого не компенсирует.
// Доля от максимума для длины снимает большую часть смещения. Проверка фиксирует, что
// score_raw_norm действительно считается и действительно слабее связан с длиной.
test('score_raw_norm слабее зависит от длины фразы, чем формула 4.2', async () => {
  const store = syntheticStore();
  const terms = [...store.phrases.keys()].filter((p) => p.length >= 8);
  const spec = [], norm = [], len = [], truth = [];
  for (const t of terms) {
    const e = await scorePhrase(t, { mode: 'exact', lookup: lookupOf(store.suggest) });
    spec.push(e.score_raw); norm.push(e.score_raw_norm); len.push(t.length); truth.push(store.phrases.get(t));
  }
  const specLen = spearman(spec, len), normLen = spearman(norm, len), truthLen = spearman(truth, len);
  console.log(`      ρ с длиной: формула 4.2 ${specLen.toFixed(2)}, доля от максимума ${normLen.toFixed(2)}, истина ${truthLen.toFixed(2)}; ` +
    `ρ с истиной: ${spearman(spec, truth).toFixed(2)} против ${spearman(norm, truth).toFixed(2)}`);
  assert.ok(Math.abs(normLen) < Math.abs(specLen));
  assert.ok(norm.every((v) => v >= 0 && v <= 1 + 1e-9));
});

test('кэш: снятые префиксы не запрашиваются повторно', async () => {
  const store = syntheticStore();
  const cache = new Map();
  const peek = (p) => cache.get(p);
  const lookup = async (p) => { const v = store.suggest(p); cache.set(p, v); return { values: v, cached: false }; };
  const first = await scorePhrase('photo editor pro', { mode: 'exact', lookup, peek });
  const second = await scorePhrase('photo editor pro', { mode: 'exact', lookup, peek });
  assert.ok(first.requests > 0);
  assert.equal(second.requests, 0);
  assert.equal(second.score_raw, first.score_raw);
  const offline = await scorePhrase('never seen phrase', { mode: 'cache', lookup, peek });
  assert.equal(offline.score_raw, null, 'без единого снятого префикса сигнала нет, а не ноль');
});

test('перцентильная нормировка: группа и откат на всё гео', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ score_raw: i, cat: 'A' });
  for (let i = 0; i < 5; i++) rows.push({ score_raw: i * 100, cat: 'B' });
  const res = percentileScores(rows, { groupOf: (r) => r.cat, minGroupSize: 30 });
  assert.equal(res.get(rows[0]).score, 0, 'ноль остаётся нулём');
  assert.equal(res.get(rows[39]).group, 'A');
  assert.ok(res.get(rows[39]).score > 95);
  assert.equal(res.get(rows[44]).group, '*', 'маленькая категория сравнивается со всем гео');
});

test('кэш подсказок в базе: пустой ответ запоминается, ошибка — нет', async () => {
  const { play } = await import('../src/lib/play.js');
  const { suggestCache } = await import('../src/lib/kw/suggest-cache.js');
  const { kwDb } = await import('../src/lib/kw/schema.js');
  const answers = { 'pho': ['photo', 'phone'], 'zzz': [] };
  let calls = 0;
  const original = play.suggest;
  play.suggest = async (prefix) => {
    calls++;
    if (prefix === 'err') throw new Error('сеть');
    return answers[prefix] ?? [];
  };
  try {
    const c1 = suggestCache({ geo: 'US', hl: 'en', date: '2026-09-15', ttlDays: 21 });
    assert.deepEqual((await c1.lookup('pho')).values, ['photo', 'phone']);
    assert.deepEqual((await c1.lookup('zzz')).values, []);
    assert.equal((await c1.lookup('err')).values, null);
    assert.deepEqual(c1.stats, { requests: 3, cache_hits: 0, errors: 1, shape_errors: 0, empty: 1 });
    // Новый экземпляр кэша через неделю: успешные ответы берутся из базы, ошибка переспрашивается.
    const c2 = suggestCache({ geo: 'US', hl: 'en', date: '2026-09-22', ttlDays: 21 });
    assert.deepEqual(c2.peek('pho'), ['photo', 'phone']);
    assert.deepEqual(c2.peek('zzz'), []);
    assert.equal(c2.peek('err'), undefined);
    // Через 30 дней кэш устарел.
    const c3 = suggestCache({ geo: 'US', hl: 'en', date: '2026-10-20', ttlDays: 21 });
    assert.equal(c3.peek('pho'), undefined);
    assert.equal(calls, 3);
    const fetched = kwDb().prepare(`SELECT COUNT(*) c FROM raw_suggest_fetch`).get().c;
    assert.equal(fetched, 3);
  } finally {
    play.suggest = original;
  }
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
console.log(failed ? `\nупало: ${failed} из ${tests.length}` : `\nвсе ${tests.length} проверок прошли`);
try {
  (await import('../src/lib/db.js')).db().close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TMP_DB + suffix, { force: true });
} catch { /* временный файл останется в tmp — не страшно */ }
process.exit(failed ? 1 : 0);
