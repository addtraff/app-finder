// Журнал предсказаний — этап 0 ТЗ AppRadar 3 (docs/tz-appradar-3.md).
//
// Зачем он нужен именно сейчас. Главное требование разбора от 23.09 — walk-forward backtest:
// взять срез прошлого, выдать по нему порядок, сравнить с тем, что случилось. Меток «что
// стало через 30 дней» у нас пока нет ни у одного приложения, и раньше 07.10 не будет. Но
// backtest 07.10 состоится только в том случае, если уже сегодня записано, что именно мы
// предсказывали сегодня. Журнал — единственная работа этапа 0, которую можно и нужно делать
// до появления меток; всё остальное без него остаётся непроверяемым.
//
// Почему признаки хранятся копией, а не читаются потом из метрик. Определения метрик
// меняются: за последнюю неделю у нас появились устаревание счётчика, шкала органики,
// импульс по общей базе ключей. Пересчёт задним числом показал бы, что модель видела бы
// СЕГОДНЯШНЕЙ формулой, а проверять надо то, что она видела на самом деле.
//
// Что пишется. Не весь список кандидатов, а голова обеих моделей плюс случайная выборка из
// остальных того же размера. Голова — то, что мы действительно рекомендуем (Precision@K).
// Выборка — база сравнения: без неё «из топа выросли 80 %» ничего не значит, потому что
// неизвестно, сколько выросло бы при случайном выборе. Именно разница между этими двумя
// числами и есть lift, ради которого всё затевается.
//
// Две модели, и обе записываются на одну строку:
//   ar3 — порядок AppRadar 3: сперва меньше риска самообмана, затем импульс ключей, затем
//         меньше признаков закупки. Никаких весов, только сортировка.
//   ar2 — rec_pct из AppRadar 2, готовый процент рекомендации.
// Случайная база сравнения берётся из тех же кандидатов, не попавших в головы.
import { db, startRun, finishRun } from '../lib/db.js';
import { config } from '../lib/config.js';
import { log } from '../lib/util.js';
import { riskFactors } from './appradar3.js';

const MODEL_SET = 'v1';
const HEAD = Number(process.env.PREDICT_HEAD || 150);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Number(Number(v).toPrecision(4)));

// Детерминированная псевдослучайность: выборка сравнения должна воспроизводиться, иначе
// перезапуск за ту же дату дал бы другую базу, и сравнивать стало бы не с чем.
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1e6) / 1e6;
}

function appFeatures(c) {
  return {
    inst: c.installs, age: r4(c.age), young: c.young,
    k10: c.k10, k50: c.k50, k10p: c.k10p, k50p: c.k50p, kwd: c.kwd,
    door: c.door, flow: c.door_flow, freedom: r4(c.freedom), purity: r4(c.purity),
    keys: c.free_keys, quad: c.quad, tto: r4(c.tto),
    pscore: r4(c.oscore == null ? null : 1 - c.oscore), ocov: r4(c.ocov), scope: c.scope,
    interp: r4(c.off_delta ?? c.prev), w: c.off_delta != null ? c.off_w : c.prev_w,
    official: c.off_delta != null ? 1 : 0, est: r4(c.est), flat: c.flat, stale: c.stale,
    revs: c.reviews, ubt: c.ubt, passed: c.passed, failed: c.failed, rec: r4(c.rec_pct),
    lvl: c.lvl,
  };
}

// Порядок AppRadar 3 — тот же, что в отчёте, и по той же функции риска: если сортировка
// в отчёте изменится, изменится и здесь, а версия набора моделей должна вырасти.
function ar3Key(c) {
  const official = c.off_delta != null;
  const risk = riskFactors({
    w: official ? c.off_w : c.prev_w, stale: c.stale, scope: c.scope, ocov: c.ocov,
    age: c.age, reviews: c.reviews, kw50: c.k50,
    flags: (c.fraud_ok === 0 ? 1 : 0) + (c.burst_flag === 1 ? 1 : 0),
  });
  return {
    risk_n: risk.length,
    mom: c.k50 != null && c.k50p != null ? c.k50 - c.k50p : 0,
    pscore: c.oscore == null ? 1 : 1 - c.oscore,
  };
}

function logDate(d, geo, date) {
  return d.prepare(
    `SELECT MAX(snapshot_date) m FROM metrics_app_v2 WHERE geo=? AND snapshot_date<=?`
  ).get(geo, date)?.m || null;
}

// ---------- запись предсказаний ----------
function writeLog(d, date, modelSet = MODEL_SET) {
  const geos = config().geos.geos;
  // Повторный запуск за ту же дату переписывает само предсказание, но не трогает уже
  // записанные исходы: затереть их означало бы потерять единственное, ради чего журнал есть.
  const ins = d.prepare(
    `INSERT INTO predictions
       (pred_date, geo, kind, object_id, model_set, rank_ar3, rank_ar2, score_ar2, in_head, features, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (pred_date, geo, kind, object_id) DO UPDATE SET
       model_set=excluded.model_set, rank_ar3=excluded.rank_ar3, rank_ar2=excluded.rank_ar2,
       score_ar2=excluded.score_ar2, in_head=excluded.in_head, features=excluded.features,
       created_at=excluded.created_at`
  );
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let apps = 0, niches = 0, geosDone = 0;

  for (const g of geos) {
    const dt = logDate(d, g.geo, date);
    if (!dt) continue;

    const cand = d.prepare(
      `SELECT v.app_id, v.installs, v.age_months age, v.young, v.organic_level lvl,
              v.organic_score oscore, v.evidence_coverage ocov, v.ads_check_scope scope,
              v.installs_delta_30d off_delta, v.delta_window_days off_w,
              v.delta_preview prev, v.delta_preview_w prev_w, v.delta_flat flat,
              v.installs_stale_days stale, v.installs_est_ratings est,
              v.kw_top10_cmp k10, v.kw_top50_cmp k50, v.kw_top10_prev k10p, v.kw_top50_prev k50p,
              v.kw_momentum_days kwd, v.ubt_signal ubt, v.passed, v.failed, v.rec_pct,
              m.ratings_count reviews, m.fraud_ok, m.burst_flag,
              n.door, n.door_flow, n.freedom_pct freedom, n.organic_purity purity,
              n.free_keys_count free_keys, n.time_to_organic tto,
              COALESCE(n.quadrant_smooth, n.quadrant) quad
         FROM metrics_app_v2 v
         JOIN metrics_app_geo m ON m.app_id=v.app_id AND m.geo=v.geo AND m.snapshot_date=v.snapshot_date
         LEFT JOIN metrics_niche_v2 n ON n.niche_id=v.niche_id AND n.geo=v.geo AND n.snapshot_date=v.snapshot_date
        WHERE v.geo=? AND v.snapshot_date=? AND v.passed_funnel=1 AND v.organic_level<>'found'`,
      ).all(g.geo, dt);
    if (!cand.length) continue;

    for (const c of cand) c._k = ar3Key(c);
    const byAr3 = [...cand].sort((a, b) => a._k.risk_n - b._k.risk_n || b._k.mom - a._k.mom || a._k.pscore - b._k.pscore);
    const byAr2 = [...cand].filter((c) => c.rec_pct != null).sort((a, b) => b.rec_pct - a.rec_pct);
    const rank3 = new Map(byAr3.map((c, i) => [c.app_id, i + 1]));
    const rank2 = new Map(byAr2.map((c, i) => [c.app_id, i + 1]));

    // Голова: то, что реально попадает людям на глаза хотя бы в одной из двух моделей.
    const head = new Set([...byAr3.slice(0, HEAD), ...byAr2.slice(0, HEAD)].map((c) => c.app_id));
    // База сравнения: столько же случайных из оставшихся, отобранных по фиксированному
    // зерну от даты и гео, чтобы повторный запуск дал ту же выборку.
    const rest = cand.filter((c) => !head.has(c.app_id))
      .sort((a, b) => seeded(dt + g.geo + a.app_id) - seeded(dt + g.geo + b.app_id))
      .slice(0, head.size);

    const write = d.transaction((list, inHead) => {
      for (const c of list) {
        ins.run(dt, g.geo, 'app', c.app_id, modelSet,
          rank3.get(c.app_id) ?? null, rank2.get(c.app_id) ?? null, r4(c.rec_pct), inHead,
          JSON.stringify(appFeatures(c)), now);
      }
    });
    write(cand.filter((c) => head.has(c.app_id)), 1);
    write(rest, 0);
    apps += head.size + rest.length;

    // Ниши пишутся целиком: их на гео меньше сотни, и предсказание здесь другое — не
    // «это приложение вырастет», а «в этой нише появятся молодые органики».
    const nrows = d.prepare(
      `SELECT niche_id, concept, door, door_flow, freedom_pct freedom, organic_purity purity,
              free_keys_count free_keys, COALESCE(quadrant_smooth, quadrant) quad,
              quadrant_days qdays, freedom_margin fmargin, young_organic_count nyoung,
              time_to_organic tto, organic_capacity cap, closed_flag closed
         FROM metrics_niche_v2 WHERE geo=? AND snapshot_date=?`
    ).all(g.geo, dt);
    const byFree = [...nrows].sort((a, b) => (b.freedom || 0) - (a.freedom || 0));
    const nrank = new Map(byFree.map((n, i) => [n.niche_id, i + 1]));
    const writeN = d.transaction((list) => {
      for (const n of list) {
        ins.run(dt, g.geo, 'niche', n.niche_id, modelSet, nrank.get(n.niche_id) ?? null, null, null,
          n.quad === 'target' ? 1 : 0,
          JSON.stringify({
            concept: n.concept, door: n.door, flow: n.door_flow, freedom: r4(n.freedom),
            purity: r4(n.purity), keys: n.free_keys, quad: n.quad, qdays: n.qdays,
            fmargin: r4(n.fmargin), nyoung: n.nyoung, tto: r4(n.tto), cap: r4(n.cap), closed: n.closed,
          }), now);
      }
    });
    writeN(nrows);
    niches += nrows.length;
    geosDone++;
  }
  return { apps, niches, geosDone };
}

// ---------- заполнение исходов ----------
// Исход ищется на ближайшем снимке к T0+H с допуском: снимки бывают не каждый день, и
// требовать точную дату означало бы терять строки на ровном месте.
const TOLERANCE = 5;

function fillOutcomes(d, today, horizon) {
  const col = horizon === 30 ? 'outcome_30' : 'outcome_90';
  const colAt = horizon === 30 ? 'outcome_30_at' : 'outcome_90_at';
  const due = d.prepare(
    `SELECT pred_date, geo, kind, object_id, features FROM predictions
      WHERE ${col} IS NULL AND date(pred_date, '+${horizon} days') <= date(?)`
  ).all(today);
  if (!due.length) return { horizon, filled: 0, missed: 0 };

  const appAt = d.prepare(
    `SELECT v.snapshot_date, v.installs, v.kw_top10_cmp k10, v.kw_top50_cmp k50, v.passed_funnel,
            v.organic_level lvl, m.ratings_count reviews
       FROM metrics_app_v2 v
       LEFT JOIN metrics_app_geo m ON m.app_id=v.app_id AND m.geo=v.geo AND m.snapshot_date=v.snapshot_date
      WHERE v.app_id=? AND v.geo=? AND v.snapshot_date BETWEEN ? AND ?
      ORDER BY ABS(julianday(v.snapshot_date) - julianday(?)) LIMIT 1`
  );
  const nicheAt = d.prepare(
    `SELECT snapshot_date, door, door_flow, freedom_pct freedom, organic_purity purity,
            young_organic_count nyoung, COALESCE(quadrant_smooth, quadrant) quad
       FROM metrics_niche_v2
      WHERE niche_id=? AND geo=? AND snapshot_date BETWEEN ? AND ?
      ORDER BY ABS(julianday(snapshot_date) - julianday(?)) LIMIT 1`
  );
  const up = d.prepare(`UPDATE predictions SET ${col}=?, ${colAt}=? WHERE pred_date=? AND geo=? AND kind=? AND object_id=?`);
  const shift = (iso, days) => new Date(Date.parse(iso) + days * 864e5).toISOString().slice(0, 10);

  let filled = 0, missed = 0;
  const run = d.transaction(() => {
    for (const p of due) {
      const target = shift(p.pred_date, horizon);
      const lo = shift(target, -TOLERANCE), hi = shift(target, TOLERANCE);
      const f0 = JSON.parse(p.features);
      const r = p.kind === 'app'
        ? appAt.get(p.object_id, p.geo, lo, hi, target)
        : nicheAt.get(p.object_id, p.geo, lo, hi, target);
      // Строки нет — приложение или ниша выпали из наблюдения. Это тоже исход, и записать
      // его надо: иначе выпавшие молча исчезнут из проверки и завысят точность.
      if (!r) { up.run(JSON.stringify({ gone: 1 }), target, p.pred_date, p.geo, p.kind, p.object_id); missed++; continue; }
      const out = p.kind === 'app'
        ? {
          d: r.snapshot_date, inst: r.installs, k10: r.k10, k50: r.k50, revs: r.reviews,
          passed: r.passed_funnel, lvl: r.lvl,
          growth: f0.inst > 0 && r.installs != null ? r4(r.installs / f0.inst - 1) : null,
          dk50: f0.k50 != null && r.k50 != null ? r.k50 - f0.k50 : null,
        }
        : {
          d: r.snapshot_date, door: r.door, flow: r.door_flow, freedom: r4(r.freedom),
          purity: r4(r.purity), nyoung: r.nyoung, quad: r.quad,
          dyoung: f0.nyoung != null && r.nyoung != null ? r.nyoung - f0.nyoung : null,
        };
      up.run(JSON.stringify(out), r.snapshot_date, p.pred_date, p.geo, p.kind, p.object_id);
      filled++;
    }
  });
  run();
  return { horizon, filled, missed };
}

// ---------- сводка ----------
function status(d, today) {
  const rows = d.prepare(
    `SELECT pred_date, kind, COUNT(*) n, SUM(in_head) head,
            SUM(CASE WHEN outcome_30 IS NOT NULL THEN 1 ELSE 0 END) o30,
            SUM(CASE WHEN outcome_90 IS NOT NULL THEN 1 ELSE 0 END) o90
       FROM predictions GROUP BY pred_date, kind ORDER BY pred_date, kind`
  ).all();
  if (!rows.length) { log('  журнал предсказаний пуст'); return rows; }
  for (const r of rows) {
    const ready = new Date(Date.parse(r.pred_date) + 30 * 864e5).toISOString().slice(0, 10);
    log(`  ${r.pred_date} ${r.kind}: строк ${r.n} (голова ${r.head}), исходов 30 дн. ${r.o30}, 90 дн. ${r.o90}` +
      (r.o30 ? '' : `, метки созреют ${ready}`));
  }
  const first = rows[0].pred_date;
  log(`  первый backtest возможен ${new Date(Date.parse(first) + 30 * 864e5).toISOString().slice(0, 10)} (30 дней от ${first}), сегодня ${today}`);
  return rows;
}

// Достройка журнала за прошедшие дни. Метрики хранятся с 16.09, поэтому записи можно
// добавить задним числом — и первые тридцатидневные метки созреют 16.10, а не 24.10.
//
// Честная оговорка, ради которой эти строки помечены отдельной версией набора «v1-backfill»:
// признаки берутся из метрик того дня, а метрики того дня считались кодом того дня. Часть
// нынешних признаков (устаревание счётчика, шкала органики, импульс по общей базе ключей)
// там просто пустая. Это близко к «что модель видела», но не то же самое, и смешивать
// достроенные строки с настоящими при проверке нельзя.
export function backfillRange(from, to) {
  const d = db();
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) {
    const date = new Date(t).toISOString().slice(0, 10);
    const res = writeLog(d, date, MODEL_SET + '-backfill');
    log(`  ${date}: приложений ${res.apps}, ниш ${res.niches}, гео ${res.geosDone}`);
    out.push({ date, ...res });
  }
  return out;
}

export async function run({ geo, date, runId, cycle = 'daily', scope = null }) {
  const d = db();
  const today = date;
  if (scope === 'status') { status(d, today); return { status: 1 }; }

  startRun(runId, 'predict-log', geo || 'ALL', cycle, date);
  let res = { apps: 0, niches: 0, geosDone: 0 };
  if (scope !== 'outcome') {
    res = writeLog(d, date);
    log(`  журнал предсказаний: ${res.apps} приложений, ${res.niches} ниш, гео ${res.geosDone}`);
  }
  const o30 = fillOutcomes(d, today, 30);
  const o90 = fillOutcomes(d, today, 90);
  if (o30.filled || o30.missed || o90.filled || o90.missed) {
    log(`  исходы: 30 дн. — записано ${o30.filled}, выпало из наблюдения ${o30.missed}; 90 дн. — ${o90.filled} / ${o90.missed}`);
  }
  finishRun(runId, 'predict-log', geo || 'ALL', { notes: `${res.apps} приложений, ${res.niches} ниш` });
  return { ...res, o30, o90 };
}
