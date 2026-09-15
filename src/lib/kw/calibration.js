// Подготовка обучающей выборки из Play Console (разделы 2, 3.1, 6, 7).
//
// Цепочка: строки Console (посетители карточки по слову за день) + позиция нашего приложения
// в тот же день (трекер или срез радара) -> CTR(позиция) -> восстановленный объём поиска.
//
// Какое число стоит в числителе обратной формулы. Раздел 7 пишет «показы нашей карточки»,
// но прямая формула там же — установки = показы × CTR × CVR, то есть посетители = показы × CTR.
// Согласованная с ней обратная формула: объём ≈ посетители / CTR(позиция). Её и считаем;
// CTR подгоняется как посетители / показы карточки на позиции (если Console отдаёт показы).
import { daysAgoUTC } from '../util.js';
import { normTerm } from './schema.js';
import { ctrAt } from './models.js';

export function consoleWindow(d, geo, date, windowDays) {
  const from = daysAgoUTC(windowDays - 1, new Date(`${date}T12:00:00Z`));
  const rows = d.prepare(
    `SELECT app_id, geo, lang, term, day, impressions, visitors, unique_clicks, metric_kind, is_censored
       FROM console_search_terms WHERE geo=? AND day BETWEEN ? AND ?`).all(geo, from, date);
  return { from, to: date, rows };
}

// Смешивать acquisitions и unique_clicks нельзя: два разных таргета под одним именем (раздел 2).
export function pickMetricKind(rows, wanted = 'auto') {
  const counts = new Map();
  for (const r of rows) if (!r.is_censored) counts.set(r.metric_kind, (counts.get(r.metric_kind) || 0) + 1);
  if (wanted !== 'auto') return { kind: wanted, counts: Object.fromEntries(counts) };
  const kind = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { kind, counts: Object.fromEntries(counts) };
}

// Позиции приложений по словам: трекер модуля и срезы радара. snapped — (слово, день), по
// которым выдача вообще снималась: без этого «нет позиции» нельзя отличить от «не снимали».
export function positionIndex(d, geo, terms, apps) {
  const pos = new Map();
  const snapped = new Set();
  const termList = JSON.stringify([...new Set(terms.map(normTerm))]);
  const appSet = new Set(apps);
  for (const sql of [
    `SELECT term, snapshot_date AS day, app_id, position FROM kw_track_serp
      WHERE geo=? AND term IN (SELECT value FROM json_each(?))`,
    `SELECT keyword AS term, snapshot_date AS day, app_id, position FROM raw_search
      WHERE geo=? AND keyword IN (SELECT value FROM json_each(?))`,
  ]) {
    for (const r of d.prepare(sql).iterate(geo, termList)) {
      snapped.add(`${r.term}|${r.day}`);
      if (!appSet.has(r.app_id)) continue;
      const key = `${r.app_id}|${r.term}|${r.day}`;
      if (!pos.has(key) || r.position < pos.get(key)) pos.set(key, r.position);
    }
  }
  const dayShift = (day, k) => new Date(Date.parse(`${day}T12:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
  return {
    // Позиция в тот же день; при maxGap > 0 — в ближайший день в пределах окна.
    at(app, term, day, maxGap = 0) {
      for (let k = 0; k <= maxGap; k++) {
        for (const s of k ? [-k, k] : [0]) {
          const p = pos.get(`${app}|${term}|${dayShift(day, s)}`);
          if (p != null) return { position: p, gap: Math.abs(s) };
        }
      }
      return null;
    },
    snappedOn: (term, day) => snapped.has(`${term}|${day}`),
    entries: () => pos,
  };
}

// Цензурирование слева (3.1): приложение в топ-50 по слову, выгрузка за этот день у приложения
// есть, а слова в ней нет — значит ниже порога отсечения. Это не ноль.
export function markCensored(d, geo, window, index) {
  const covered = new Map();   // app|day -> { lang, kind }
  for (const r of window.rows) {
    if (r.is_censored) continue;
    covered.set(`${r.app_id}|${r.day}`, { lang: r.lang, kind: r.metric_kind });
  }
  const present = new Set(window.rows.map((r) => `${r.app_id}|${r.term}|${r.day}`));
  const ins = d.prepare(
    `INSERT OR IGNORE INTO console_search_terms (app_id, geo, lang, term, day, impressions, visitors, unique_clicks, metric_kind, is_censored, source_file, imported_at)
     VALUES (?,?,?,?,?,NULL,NULL,NULL,?,1,'kw-calibrate: в топ-50, в выгрузке нет',?)`);
  let n = 0;
  const now = new Date().toISOString();
  d.transaction(() => {
    for (const [key, p] of index.entries()) {
      if (p > 50) continue;
      const [app, term, day] = key.split('|');
      const cov = covered.get(`${app}|${day}`);
      if (!cov || present.has(key)) continue;
      if (ins.run(app, geo, cov.lang, term, day, cov.kind, now).changes) n++;
    }
  })();
  return n;
}

// Дневные наблюдения восстановленного объёма.
export function reconstruct(rows, index, curve, { kind, maxGap = 0 }) {
  const out = [];
  const skipped = { no_position: 0, no_visitors: 0 };
  for (const r of rows) {
    if (r.is_censored || r.metric_kind !== kind) continue;
    if (!(r.visitors > 0)) { skipped.no_visitors++; continue; }
    const p = index.at(r.app_id, normTerm(r.term), r.day, maxGap);
    if (!p) { skipped.no_position++; continue; }
    out.push({
      app: r.app_id, term: normTerm(r.term), day: r.day, position: p.position,
      visitors: r.visitors, impressions: r.impressions, conversions: r.unique_clicks,
      volume: r.visitors / ctrAt(curve, p.position),
    });
  }
  return { obs: out, skipped };
}

// Среднее за дни с данными по (приложение, слово) внутри части окна.
export function aggregate(obs) {
  const m = new Map();
  for (const o of obs) {
    const key = `${o.app}|${o.term}`;
    const a = m.get(key) || { app: o.app, term: o.term, sum: 0, days: 0, posSum: 0, impressions: 0, months: new Map() };
    a.sum += o.volume; a.days++; a.posSum += o.position; a.impressions += o.impressions || 0;
    const mo = Number(o.day.slice(5, 7));
    a.months.set(mo, (a.months.get(mo) || 0) + 1);
    m.set(key, a);
  }
  return [...m.values()].map((a) => ({
    app: a.app, term: a.term, volume: a.sum / a.days, days: a.days, position: a.posSum / a.days, impressions: a.impressions,
    month: [...a.months].sort((x, y) => y[1] - x[1])[0][0],
  }));
}

// Признаки бустинга. Позиция — для коррекции смещения (раздел 5): при обучении фактическая,
// при применении — reference_position, то есть оценка «как если бы наблюдали с вершины выдачи».
export const FEATURES = [
  'score_raw', 'score_raw_norm', 'min_prefix_len', 'avg_suggest_pos', 'prefix_hit_share',
  'lg_top10_installs', 'lg_top10_reviews', 'title_match_share', 'total_results', 'installs_spread',
  'suggest_geo_count', 'words', 'chars', 'stopword_share', 'is_brand', 'is_translit',
  'kp_volume', 'trends_index', 'asa_popularity', 'category_idx', 'month', 'position',
];

const lg = (v) => (v == null ? null : Math.log10(Number(v) + 1));

export function featureVector(sig, { position, month, categories }) {
  const v = {
    ...sig,
    lg_top10_installs: lg(sig.top10_installs_median),
    lg_top10_reviews: lg(sig.top10_reviews_median),
    category_idx: sig.category != null && categories.has(sig.category) ? categories.get(sig.category) : null,
    month, position,
  };
  return FEATURES.map((f) => (v[f] == null ? null : Number(v[f])));
}
