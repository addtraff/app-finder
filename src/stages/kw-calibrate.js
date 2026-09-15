// kw-calibrate: из попугаев в показы (разделы 6, 7, 9).
//
//   S2 — изотоническая регрессия score -> log(объём), валидация на отложенном периоде
//        (последние holdout_days окна): модель учится на раннем периоде, проверяется на позднем.
//   S3 — квантильный бустинг p10/p50/p90, валидация с исключением приложения целиком
//        (разбиение по приложениям, 6.3), затем финальные модели на всех данных.
//
// Модель включается только по метрике (раздел 9): Spearman ≥ spearman_bucket — бакеты,
// бустинг с Spearman ≥ spearman_interval — интервалы. Не прошедшая порог модель сохраняется
// с active = 0: в отчёте видно, что калибровка была и почему цифр нет.
//
// Изотоника строится по сырому score, а не по перцентилю: перцентиль сдвигается с ростом
// словаря, и вчерашняя модель начала бы давать другие цифры без всякой новой информации.
import { log, warn, daysAgoUTC } from '../lib/util.js';
import { kwDb, kwConfig, normTerm } from '../lib/kw/schema.js';
import {
  consoleWindow, pickMetricKind, positionIndex, markCensored, reconstruct, aggregate, featureVector, FEATURES,
} from '../lib/kw/calibration.js';
import { fitCtrCurve, isotonicFit, isotonicPredict, gbmFit, gbmPredict, validationMetrics } from '../lib/kw/models.js';

const MIN_TEST_TERMS = 10;

export function latestSignals(d, geo, date) {
  return new Map(d.prepare(
    `SELECT k.term, s.* FROM kw_signals s
       JOIN (SELECT keyword_id, MAX(day) md FROM kw_signals WHERE geo=? AND day<=? GROUP BY keyword_id) f
         ON f.keyword_id=s.keyword_id AND f.md=s.day
       JOIN keywords k ON k.keyword_id=s.keyword_id
      WHERE s.geo=?`).all(geo, date, geo).map((r) => [r.term, r]));
}

function monthly(obs) {
  const m = new Map();
  for (const o of obs) {
    const key = `${o.app}|${o.term}|${o.day.slice(0, 7)}`;
    const a = m.get(key) || { app: o.app, term: o.term, month: Number(o.day.slice(5, 7)), sum: 0, days: 0, posSum: 0 };
    a.sum += o.volume; a.days++; a.posSum += o.position;
    m.set(key, a);
  }
  return [...m.values()].map((a) => ({ app: a.app, term: a.term, month: a.month, volume: a.sum / a.days, days: a.days, position: a.posSum / a.days }));
}

export async function run({ geo, date }) {
  const d = kwDb();
  const cfg = kwConfig();
  const cal = cfg.calibration;
  const val = cfg.validation;

  let win = consoleWindow(d, geo, date, cal.window_days);
  if (!win.rows.length) {
    log(`  ${geo}: выгрузки Play Console за ${cal.window_days} дн. нет — калибровать нечем (S0/S1)`);
    return { stage: null };
  }
  const apps = [...new Set(win.rows.map((r) => r.app_id))];
  // Слова — не только из выгрузки: слово, по которому приложение в топ-50, но которое всегда
  // ниже порога Console, в выгрузке не появится ни разу, а именно его и надо цензурировать.
  const tracked = d.prepare(
    `SELECT DISTINCT term FROM kw_track_serp
      WHERE geo=? AND snapshot_date BETWEEN ? AND ? AND app_id IN (SELECT value FROM json_each(?))`)
    .all(geo, win.from, win.to, JSON.stringify(apps)).map((r) => r.term);
  const terms = [...new Set([...win.rows.map((r) => normTerm(r.term)), ...tracked])];
  const index = positionIndex(d, geo, terms, apps);
  const censoredMarked = markCensored(d, geo, win, index);
  if (censoredMarked) win = consoleWindow(d, geo, date, cal.window_days);
  const { kind, counts } = pickMetricKind(win.rows, cal.metric_kind);
  if (Object.keys(counts).length > 1) {
    warn(`  ${geo}: в окне обе метрики Console ${JSON.stringify(counts)} — обучение только на «${kind}», другая не смешивается`);
  }

  // ---- 7: кривая CTR ----
  const ctrRows = [];
  for (const r of win.rows) {
    if (r.is_censored || r.metric_kind !== kind || !(r.impressions > 0) || !(r.visitors > 0)) continue;
    const p = index.at(r.app_id, normTerm(r.term), r.day, cal.position_max_gap_days);
    if (p) ctrRows.push({ position: p.position, impressions: r.impressions, visitors: r.visitors });
  }
  const curve = fitCtrCurve(ctrRows, {
    priorCtr1: cfg.ctr.prior_ctr1, priorAlpha: cfg.ctr.prior_alpha, minRows: cfg.ctr.min_rows_fit, minPositions: cfg.ctr.min_positions_fit,
  });
  d.prepare(`INSERT OR REPLACE INTO kw_ctr_curve (geo, fitted_at, ctr1, alpha, n, positions, source) VALUES (?,?,?,?,?,?,?)`)
    .run(geo, date, curve.ctr1, curve.alpha, curve.n, curve.positions, curve.source);
  log(`  ${geo}: CTR(p) = ${curve.ctr1.toFixed(3)} / p^${curve.alpha.toFixed(2)} (${curve.source === 'fit' ? `подогнано по ${curve.n} наблюдениям` : 'приор — своих наблюдений мало'})`);

  const { obs, skipped } = reconstruct(win.rows, index, curve, { kind, maxGap: cal.position_max_gap_days });
  const sigs = latestSignals(d, geo, date);
  const noSignal = new Set(obs.filter((o) => !sigs.has(o.term)).map((o) => o.term));
  if (noSignal.size) warn(`  ${geo}: у ${noSignal.size} слов из Console нет score — сначала kw-signals`);
  const usable = obs.filter((o) => sigs.has(o.term));
  const common = {
    geo, trained_at: date, window_from: win.from, window_to: win.to, metric_kind: kind,
    n_rows: usable.length, n_terms: new Set(usable.map((o) => o.term)).size, n_apps: new Set(usable.map((o) => o.app)).size,
    apps: JSON.stringify([...new Set(usable.map((o) => o.app))]),
  };
  const baseValidation = { skipped, censored_marked: censoredMarked, metric_counts: counts, no_signal_terms: noSignal.size, ctr: curve };

  const insModel = d.prepare(`INSERT OR REPLACE INTO kw_models (
      model_version, geo, kind, stage, trained_at, window_from, window_to, metric_kind, n_rows, n_terms, n_apps, apps,
      spearman, bucket_hit, sum_ratio, censored_below_share, validation, active, note, params)
    VALUES (@model_version, @geo, @kind, @stage, @trained_at, @window_from, @window_to, @metric_kind, @n_rows, @n_terms, @n_apps, @apps,
      @spearman, @bucket_hit, @sum_ratio, @censored_below_share, @validation, 0, @note, @params)`);

  const censoredRows = win.rows.filter((r) => r.is_censored && r.metric_kind === kind && sigs.has(normTerm(r.term)));
  const edges = cfg.buckets_month;
  const results = [];

  // ---- S2: изотоника, отложенный период ----
  const testFrom = daysAgoUTC(cal.holdout_days - 1, new Date(`${date}T12:00:00Z`));
  const train = aggregate(usable.filter((o) => o.day < testFrom));
  const test = aggregate(usable.filter((o) => o.day >= testFrom));
  const primary = cfg.score.normalization === 'max' ? 'score_raw_norm' : 'score_raw';
  if (train.length >= cal.min_rows_isotonic && test.length >= MIN_TEST_TERMS) {
    const variants = {};
    let chosen = null;
    for (const field of ['score_raw', 'score_raw_norm']) {
      const tr = train.filter((a) => sigs.get(a.term)[field] != null);
      const model = isotonicFit(tr.map((a) => sigs.get(a.term)[field]), tr.map((a) => Math.log(a.volume)), tr.map((a) => a.days));
      const pairs = test.filter((a) => sigs.get(a.term)[field] != null)
        .map((a) => ({ pred: Math.exp(isotonicPredict(model, sigs.get(a.term)[field])), actual: a.volume, app: a.app }));
      // Контроль цензурирования: слово ниже порога должно получить оценку ниже самого слабого
      // слова, которое в выгрузку попало.
      const floor = new Map();
      for (const a of train) floor.set(a.app, Math.min(floor.get(a.app) ?? Infinity, a.volume));
      const cens = censoredRows.filter((r) => r.day >= testFrom && floor.has(r.app_id) && sigs.get(normTerm(r.term))[field] != null);
      const below = cens.length
        ? cens.filter((r) => Math.exp(isotonicPredict(model, sigs.get(normTerm(r.term))[field])) < floor.get(r.app_id)).length / cens.length
        : null;
      variants[field] = { ...validationMetrics(pairs, { edges }), censored_below_share: below, censored_n: cens.length, model };
      if (field === primary) chosen = variants[field];
    }
    const version = `iso-${geo}-${date}`;
    insModel.run({
      ...common, model_version: version, kind: 'isotonic', stage: 'S2',
      spearman: chosen.spearman, bucket_hit: chosen.bucket_hit, sum_ratio: chosen.sum_ratio, censored_below_share: chosen.censored_below_share,
      validation: JSON.stringify({
        ...baseValidation, scheme: `отложенный период с ${testFrom}`, train_terms: train.length, test_terms: test.length,
        variants: Object.fromEntries(Object.entries(variants).map(([f, v]) => [f, { spearman: v.spearman, bucket_hit: v.bucket_hit, sum_ratio: v.sum_ratio, n: v.n, censored_below_share: v.censored_below_share }])),
      }),
      note: null,
      params: JSON.stringify({ field: primary, curve, model: chosen.model }),
    });
    results.push({ version, kind: 'isotonic', spearman: chosen.spearman });
    log(`  ${geo}: S2 изотоника — Spearman ${fmt(chosen.spearman)} на ${chosen.n} словах отложенного периода, ` +
        `бакет ${fmt(chosen.bucket_hit)}, сумма ×${fmt(chosen.sum_ratio)}; вариант score_raw_norm: ${fmt(variants.score_raw_norm.spearman)}`);
  } else {
    log(`  ${geo}: S2 не обучается — слов в раннем периоде ${train.length} (нужно ${cal.min_rows_isotonic}), в отложенном ${test.length} (нужно ${MIN_TEST_TERMS})`);
  }

  // ---- S3: бустинг, разбиение по приложениям ----
  const rows = monthly(usable);
  const appsIn = [...new Set(rows.map((r) => r.app))];
  if (rows.length >= cal.min_rows_gbm && appsIn.length >= cal.min_apps_gbm) {
    const categories = new Map([...new Set([...sigs.values()].map((s) => s.category).filter(Boolean))].sort().map((c, i) => [c, i]));
    const X = rows.map((r) => featureVector(sigs.get(r.term), { position: r.position, month: r.month, categories }));
    const y = rows.map((r) => Math.log1p(r.volume));
    const g = cfg.gbm;
    const opts = { nEstimators: g.n_estimators, learningRate: g.learning_rate, maxDepth: g.max_depth, minLeaf: g.min_leaf, bins: g.bins };
    const pairs = [];
    for (const held of appsIn) {
      const tr = rows.map((r, i) => i).filter((i) => rows[i].app !== held);
      const te = rows.map((r, i) => i).filter((i) => rows[i].app === held);
      const m50 = gbmFit(tr.map((i) => X[i]), tr.map((i) => y[i]), { ...opts, alpha: 0.5 });
      for (const i of te) pairs.push({ pred: Math.expm1(gbmPredict(m50, X[i])), actual: rows[i].volume, app: held });
    }
    const metrics = validationMetrics(pairs, { edges });
    const models = {};
    for (const [name, alpha] of [['p10', 0.1], ['p50', 0.5], ['p90', 0.9]]) models[name] = gbmFit(X, y, { ...opts, alpha });
    const version = `gbm-${geo}-${date}`;
    insModel.run({
      ...common, model_version: version, kind: 'gbm', stage: 'S3',
      spearman: metrics.spearman, bucket_hit: metrics.bucket_hit, sum_ratio: metrics.sum_ratio, censored_below_share: null,
      validation: JSON.stringify({ ...baseValidation, scheme: `исключение приложения целиком, ${appsIn.length} фолдов`, rows: rows.length, ...metrics }),
      note: null,
      params: JSON.stringify({ features: FEATURES, categories: [...categories], reference_position: cal.reference_position, curve, models }),
    });
    results.push({ version, kind: 'gbm', spearman: metrics.spearman });
    log(`  ${geo}: S3 бустинг — Spearman ${fmt(metrics.spearman)} по ${appsIn.length} приложениям, бакет ${fmt(metrics.bucket_hit)}, сумма ×${fmt(metrics.sum_ratio)}`);
  } else {
    log(`  ${geo}: S3 не обучается — строк ${rows.length} (нужно ${cal.min_rows_gbm}), приложений ${appsIn.length} (нужно ${cal.min_apps_gbm})`);
  }

  // Включается лучшая по стадии модель, прошедшая порог; остальные гео не трогаются.
  const passing = results.filter((r) => r.spearman != null && r.spearman >= val.spearman_bucket);
  const pick = passing.find((r) => r.kind === 'gbm') || passing.find((r) => r.kind === 'isotonic') || null;
  if (pick) {
    d.transaction(() => {
      d.prepare(`UPDATE kw_models SET active=0 WHERE geo=?`).run(geo);
      d.prepare(`UPDATE kw_models SET active=1 WHERE model_version=?`).run(pick.version);
    })();
    log(`  ${geo}: включена ${pick.version}`);
  } else if (results.length) {
    for (const r of results) {
      d.prepare(`UPDATE kw_models SET note=? WHERE model_version=?`)
        .run(`Spearman ${fmt(r.spearman)} ниже порога ${val.spearman_bucket} — цифры не показываются`, r.version);
    }
    log(`  ${geo}: ни одна модель не прошла порог Spearman ${val.spearman_bucket}; действующая модель гео не меняется`);
  }
  return { curve, results, active: pick?.version ?? null };
}

const fmt = (v) => (v == null ? '—' : Number(v).toFixed(2));
