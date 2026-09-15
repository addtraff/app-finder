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

test('изотоническая регрессия: PAV сливает нарушения порядка и не ломает монотонность', async () => {
  const { isotonicFit, isotonicPredict } = await import('../src/lib/kw/models.js');
  const m = isotonicFit([1, 2, 3, 4, 5], [1, 3, 2, 4, 4]);
  assert.deepEqual(m.blocks.map((b) => b[2]), [1, 2.5, 4]);
  assert.equal(isotonicPredict(m, 0), 1);
  assert.equal(isotonicPredict(m, 2.5), 2.5);
  assert.equal(isotonicPredict(m, 9), 4);
  const r = rng(3);
  const xs = [], ys = [];
  for (let i = 0; i < 300; i++) { const x = r() * 100; xs.push(x); ys.push(Math.log1p(x * 5) + (r() - 0.5)); }
  const big = isotonicFit(xs, ys);
  let prev = -Infinity;
  for (let x = 0; x <= 100; x += 0.5) {
    const v = isotonicPredict(big, x);
    assert.ok(v >= prev - 1e-12, `немонотонно в ${x}`);
    prev = v;
  }
});

test('квантильный бустинг: p50 ранжирует, p10–p90 накрывают большую часть отложенных точек', async () => {
  const { gbmFit, gbmPredict } = await import('../src/lib/kw/models.js');
  const r = rng(11);
  const gen = (n) => {
    const X = [], y = [];
    for (let i = 0; i < n; i++) {
      const a = r() * 10, b = r() * 5, noise = r() < 0.1 ? null : r();
      const e = (r() + r() + r() - 1.5) * 1.2;   // шум с конечной дисперсией
      X.push([a, b, noise]);
      y.push(0.8 * a + Math.sin(b) * 2 + e);
    }
    return { X, y };
  };
  const train = gen(1500), test = gen(600);
  const cfg = { nEstimators: 150, learningRate: 0.1, maxDepth: 3, minLeaf: 20, bins: 32 };
  const t0 = Date.now();
  const p50 = gbmFit(train.X, train.y, { ...cfg, alpha: 0.5 });
  const p10 = gbmFit(train.X, train.y, { ...cfg, alpha: 0.1 });
  const p90 = gbmFit(train.X, train.y, { ...cfg, alpha: 0.9 });
  const ms = Date.now() - t0;
  const pred = test.X.map((x) => gbmPredict(p50, x));
  let covered = 0;
  test.X.forEach((x, i) => { if (test.y[i] >= gbmPredict(p10, x) && test.y[i] <= gbmPredict(p90, x)) covered++; });
  const rho = spearman(pred, test.y), cover = covered / test.y.length;
  console.log(`      ρ p50 ${rho.toFixed(3)}, покрытие p10–p90 ${(cover * 100).toFixed(1)} %, обучение трёх моделей ${ms} мс`);
  assert.ok(rho > 0.85);
  // На отложенных точках квантильные модели обычно недокрывают номинальные 80 %: деревья подстраиваются под обучение.
  assert.ok(cover > 0.65 && cover < 0.9);
  // JSON-круг: модель хранится в kw_models.params и должна предсказывать так же.
  const restored = JSON.parse(JSON.stringify(p50));
  assert.equal(gbmPredict(restored, test.X[0]), pred[0]);
});

test('кривая CTR: подгонка восстанавливает CTR₁ и α, при нехватке данных — приор', async () => {
  const { fitCtrCurve, ctrAt, bucketIndex, bucketLabel, validationMetrics } = await import('../src/lib/kw/models.js');
  const r = rng(5);
  const rows = [];
  for (let k = 0; k < 400; k++) {
    const position = 1 + Math.floor(r() * 20), impressions = 200 + Math.floor(r() * 2000);
    const ctr = 0.27 / Math.pow(position, 0.85) * (0.9 + r() * 0.2);
    rows.push({ position, impressions, visitors: Math.max(1, Math.round(impressions * ctr)) });
  }
  const fit = fitCtrCurve(rows);
  assert.equal(fit.source, 'fit');
  assert.ok(Math.abs(fit.ctr1 - 0.27) < 0.03, `CTR₁ ${fit.ctr1}`);
  assert.ok(Math.abs(fit.alpha - 0.85) < 0.08, `α ${fit.alpha}`);
  assert.ok(Math.abs(ctrAt(fit, 1) - fit.ctr1) < 1e-12);
  const prior = fitCtrCurve(rows.slice(0, 10));
  assert.equal(prior.source, 'prior');
  assert.equal(prior.ctr1, 0.28);
  assert.equal(bucketIndex(99), 0);
  assert.equal(bucketIndex(100), 1);
  assert.equal(bucketIndex(4999), 3);
  assert.equal(bucketIndex(250000), 6);
  assert.equal(bucketLabel(3), '1–5К в мес');
  const v = validationMetrics([
    { pred: 10, actual: 12, app: 'a' }, { pred: 20, actual: 25, app: 'a' }, { pred: 30, actual: 28, app: 'b' },
    { pred: 40, actual: 55, app: 'b' }, { pred: 50, actual: 60, app: 'b' },
  ]);
  assert.equal(v.spearman, 1);
  assert.equal(v.n, 5);
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

// Сквозная проверка калибровки: синтетическая выгрузка Console четырёх приложений разной силы,
// позиции в трекере, слова ниже порога. Истинный объём известен, поэтому видно, восстанавливает
// ли цепочка CTR -> объём -> модель порядок слов и включаются ли модели по порогам.
test('калибровка: CTR, цензурирование, S2 и S3 на синтетической выгрузке Console', async () => {
  const { kwDb, keywordId } = await import('../src/lib/kw/schema.js');
  const calibrate = await import('../src/stages/kw-calibrate.js');
  const metrics = await import('../src/stages/kw-metrics.js');
  const d = kwDb();
  const r = rng(21);
  const gauss = () => (r() + r() + r() - 1.5) / 0.5;
  const terms = [];
  for (let i = 0; i < 400; i++) {
    const volume = Math.exp(1 + r() * 5.5);                 // истинные поиски в день: ~3–650
    const term = `synthetic term ${i}`;
    terms.push({ term, volume });
    d.prepare(`INSERT OR REPLACE INTO kw_signals (keyword_id, geo, day, score_raw, score_raw_norm, min_prefix_len, avg_suggest_pos,
        prefix_hit_share, top10_installs_median, words, chars, is_brand, is_translit, category, score_method, tracked)
      VALUES (?, 'US', '2026-09-01', ?, ?, ?, ?, ?, ?, 3, ?, 0, 0, 'TOOLS', 'binary', 1)`)
      .run(keywordId(d, term), Math.max(0.01, Math.log(volume) + gauss() * 0.6), Math.max(0.001, (Math.log(volume) + gauss() * 0.6) / 8),
        Math.max(3, Math.round(12 - Math.log(volume))), 1 + r() * 4, r(), Math.round(volume * 1e3 * (0.5 + r())), term.length);
  }
  const apps = [['com.test.strong', 1, 5], ['com.test.mid', 6, 10], ['com.test.weak', 16, 20], ['com.test.tail', 36, 15]];
  const insConsole = d.prepare(`INSERT INTO console_search_terms (app_id, geo, lang, term, day, impressions, visitors, unique_clicks, metric_kind, is_censored)
    VALUES (?, 'US', 'en', ?, ?, ?, ?, ?, 'acquisitions', 0)`);
  const insSerp = d.prepare(`INSERT OR REPLACE INTO kw_track_serp (snapshot_date, geo, term, position, app_id) VALUES (?, 'US', ?, ?, ?)`);
  let below = 0;
  d.transaction(() => {
    for (let day = 0; day < 90; day++) {
      const date = new Date(Date.parse('2026-06-18T12:00:00Z') + day * 86400000).toISOString().slice(0, 10);
      terms.forEach((t, i) => {
        apps.forEach(([app, base, span], a) => {
          if ((i * 7 + a * 13) % 10 >= 7) return;                 // приложение ранжируется по 70 % слов
          const position = base + ((i + a) % span);
          insSerp.run(date, t.term, position, app);
          const searches = t.volume * (0.8 + 0.4 * r());
          const visitors = Math.round(searches * 0.27 / Math.pow(position, 0.85) * (0.9 + 0.2 * r()));
          if (visitors < 2) { below++; return; }                 // порог отсечения Console
          insConsole.run(app, t.term, date, Math.round(searches), visitors, Math.round(visitors * 0.3));
        });
      });
    }
  })();
  const t0 = Date.now();
  const res = await calibrate.run({ geo: 'US', date: '2026-09-15' });
  const ms = Date.now() - t0;
  const models = d.prepare(`SELECT model_version, kind, spearman, bucket_hit, sum_ratio, censored_below_share, active, validation FROM kw_models WHERE geo='US'`).all();
  const iso = models.find((m) => m.kind === 'isotonic'), gbm = models.find((m) => m.kind === 'gbm');
  const censored = d.prepare(`SELECT COUNT(*) c FROM console_search_terms WHERE is_censored=1`).get().c;
  console.log(`      CTR ${res.curve.ctr1.toFixed(3)}/p^${res.curve.alpha.toFixed(2)} (${res.curve.source}), цензурировано ${censored} из ${below} ниже порога; ` +
    `S2 ρ ${iso?.spearman?.toFixed(3)}, бакет ${iso?.bucket_hit?.toFixed(2)}, ниже порога ${iso?.censored_below_share?.toFixed(2)}; ` +
    `S3 ρ ${gbm?.spearman?.toFixed(3)}, бакет ${gbm?.bucket_hit?.toFixed(2)}, сумма ×${gbm?.sum_ratio?.toFixed(2)}; ${ms} мс`);
  assert.equal(res.curve.source, 'fit');
  assert.ok(Math.abs(res.curve.ctr1 - 0.27) < 0.04 && Math.abs(res.curve.alpha - 0.85) < 0.1);
  assert.equal(censored, below, 'каждое слово ниже порога, где приложение в топ-50, — цензурированное');
  assert.ok(iso && iso.spearman > 0.6, 'S2 должна пройти порог на синтетике с сильным сигналом');
  assert.ok(gbm && gbm.spearman > 0.7, 'S3 должна пройти порог интервала');
  assert.equal(gbm.active, 1, 'включается модель старшей стадии');
  assert.equal(iso.active, 0);

  const out = await metrics.run({ geo: 'US', date: '2026-09-15' });
  assert.ok(out.counts.interval > 350, JSON.stringify(out.counts));
  const bad = d.prepare(`SELECT COUNT(*) c FROM kw_metrics WHERE confidence_level='interval' AND NOT (impressions_lo <= impressions_est AND impressions_est <= impressions_hi)`).get().c;
  assert.equal(bad, 0, 'p10 ≤ p50 ≤ p90');
  const est = d.prepare(`SELECT k.term, m.impressions_est FROM kw_metrics m JOIN keywords k USING(keyword_id) WHERE m.geo='US'`).all();
  const truth = new Map(terms.map((t) => [t.term, t.volume]));
  const rho = spearman(est.map((e) => e.impressions_est), est.map((e) => truth.get(e.term)));
  console.log(`      применение: ρ(оценка, истина) ${rho.toFixed(3)} по ${est.length} словам, уровни ${JSON.stringify(out.counts)}`);
  assert.ok(rho > 0.7);
});

test('импорт выгрузок: Console в UTF-16 с табуляцией, Keyword Planner, Trends, ASA', async () => {
  const { kwDb } = await import('../src/lib/kw/schema.js');
  const { importConsole, importPlanner, importTrends, importAsa, parseDay, countryCode, parseCsv } = await import('../src/lib/kw/imports.js');
  const d = kwDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-import-'));
  try {
    assert.equal(parseDay('Sep 3, 2026'), '2026-09-03');
    assert.equal(parseDay('03.09.2026'), '2026-09-03');
    assert.equal(parseDay('20260903'), '2026-09-03');
    assert.equal(countryCode('United States'), 'US');
    assert.equal(countryCode('Германия'), 'DE');
    assert.deepEqual(parseCsv('a,"b, c",d\n1,"x ""y""",3'), [['a', 'b, c', 'd'], ['1', 'x "y"', '3']]);

    const tsv = ['Date\tPackage name\tCountry / region\tSearch term\tStore listing visitors\tStore listing acquisitions\tUnique clicks',
      '2026-09-01\tcom.test.io\tUnited States\tPhoto Editor\t1,204\t310\t350',
      '2026-09-01\tcom.test.io\tUnited States\tOther\t9000\t10\t12',
      '2026-09-02\tcom.test.io\tDE\tfoto bearbeiten\t88\t20\t22'].join('\r\n');
    const f1 = path.join(dir, 'terms.csv');
    fs.writeFileSync(f1, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(tsv, 'utf16le')]));
    const res = importConsole(d, f1, { date: '2026-09-15' });
    assert.equal(res.rows, 2);
    assert.equal(res.skipped_aggregate, 1);
    assert.deepEqual(res.kinds, ['unique_clicks', 'acquisitions']);
    const row = d.prepare(`SELECT * FROM console_search_terms WHERE app_id='com.test.io' AND term='photo editor' AND metric_kind='acquisitions'`).get();
    assert.equal(row.geo, 'US');
    assert.equal(row.visitors, 1204);
    assert.equal(row.unique_clicks, 310);

    const f2 = path.join(dir, 'kp.csv');
    fs.writeFileSync(f2, 'Keyword Stats 2026-09-15\nKeyword,Currency,Avg. monthly searches\nphoto editor,USD,10K – 100K\npdf reader,USD,1K – 10K\n');
    assert.equal(importPlanner(d, f2, { geo: 'US' }).rows, 2);
    assert.equal(d.prepare(`SELECT range_high FROM raw_external_keyword_planner WHERE geo='US' AND keyword='photo editor'`).get().range_high, 100000);

    const f3 = path.join(dir, 'multiTimeline.csv');
    fs.writeFileSync(f3, 'Category: All categories\n\nWeek,photo editor: (United States),pdf reader: (United States)\n2026-08-30,80,<1\n2026-09-06,100,3\n');
    assert.equal(importTrends(d, f3, { geo: 'US' }).points, 4);

    const f4 = path.join(dir, 'asa.csv');
    fs.writeFileSync(f4, 'Keyword,Popularity,Country\nphoto editor,62,US\n');
    assert.equal(importAsa(d, f4, {}).rows, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
