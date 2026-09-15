// kw-metrics: колонка «Показы/день» с уровнем доверия (раздел 8).
//
//   none     — у слова нет score (не посчитано): замок;
//   ordinal  — score есть, откалиброванной модели для гео нет: шкала 0–100 без единиц;
//   bucket   — действующая модель со Spearman ≥ spearman_bucket: «1–5К в мес»;
//   interval — бустинг со Spearman ≥ spearman_interval и квантильными моделями: p50 (p10–p90).
//
// Модель применяется только в своём гео: перенос между гео без переобучения запрещён (раздел 10).
// Сезонный множитель Google Trends (S4) умножает оценку, если профиль для слова или категории есть.
import { log } from '../lib/util.js';
import { kwDb, kwConfig } from '../lib/kw/schema.js';
import { percentileScores } from '../lib/kw/popularity.js';
import { isotonicPredict, gbmPredict, bucketIndex, bucketLabel } from '../lib/kw/models.js';
import { featureVector } from '../lib/kw/calibration.js';
import { seasonalProfile } from '../lib/kw/features.js';
import { latestSignals } from './kw-calibrate.js';

export function activeModel(d, geo) {
  const m = d.prepare(`SELECT * FROM kw_models WHERE geo=? AND active=1 ORDER BY trained_at DESC LIMIT 1`).get(geo);
  if (!m) return null;
  return { ...m, params: JSON.parse(m.params) };
}

export async function run({ geo, date }) {
  const d = kwDb();
  const cfg = kwConfig();
  const sigs = [...latestSignals(d, geo, date).values()];
  if (!sigs.length) {
    log(`  ${geo}: сигналов нет — сначала kw-signals`);
    return { rows: 0 };
  }

  // Шкала 0–100 — против текущего словаря целиком, а не того, что был в день расчёта слова.
  const field = cfg.score.normalization === 'max' ? 'score_raw_norm' : 'score_raw';
  const ranks = percentileScores(sigs, { groupOf: (r) => r.category || '—', minGroupSize: cfg.score.min_group_size, field });

  const model = activeModel(d, geo);
  const month = Number(date.slice(5, 7));
  let seasonal = null;
  if (model) {
    const byCat = new Map();
    for (const s of sigs) if (s.category) { if (!byCat.has(s.category)) byCat.set(s.category, []); byCat.get(s.category).push(s.term); }
    seasonal = seasonalProfile(d, geo, byCat);
  }
  const categories = model?.kind === 'gbm' ? new Map(model.params.categories) : null;

  const ins = d.prepare(`INSERT OR REPLACE INTO kw_metrics
    (keyword_id, geo, day, popularity_score, impressions_est, impressions_lo, impressions_hi, confidence_level, bucket, seasonal_mult, model_kind, model_version, calibrated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const counts = { none: 0, ordinal: 0, bucket: 0, interval: 0 };
  d.transaction(() => {
    for (const s of sigs) {
      const score = ranks.get(s)?.score ?? null;
      let est = null, lo = null, hi = null, level = score == null ? 'none' : 'ordinal', mult = null;
      if (model && score != null) {
        mult = seasonal?.own.get(s.term)?.[month] ?? (s.category ? seasonal?.byCategory.get(s.category)?.[month] : null) ?? null;
        const k = mult ?? 1;
        if (model.kind === 'isotonic') {
          const x = s[model.params.field];
          const v = x == null ? null : isotonicPredict(model.params.model, x);
          if (v != null) { est = Math.exp(v) * k; level = 'bucket'; }
        } else if (model.kind === 'gbm') {
          const x = featureVector(s, { position: model.params.reference_position, month, categories });
          const p = model.params.models;
          est = Math.max(0, Math.expm1(gbmPredict(p.p50, x))) * k;
          const a = Math.max(0, Math.expm1(gbmPredict(p.p10, x))) * k;
          const b = Math.max(0, Math.expm1(gbmPredict(p.p90, x))) * k;
          // Квантильные модели учатся независимо и изредка пересекаются — границы упорядочиваются.
          lo = Math.min(a, b, est); hi = Math.max(a, b, est);
          level = model.spearman >= cfg.validation.spearman_interval ? 'interval' : 'bucket';
          if (level === 'bucket') { lo = null; hi = null; }
        }
      }
      counts[level]++;
      ins.run(s.keyword_id, geo, date, score, est, lo, hi, level,
        est == null ? null : bucketLabel(bucketIndex(est * 30, cfg.buckets_month)),
        mult, model?.kind ?? null, model?.model_version ?? null, model?.trained_at ?? null);
    }
  })();
  log(`  ${geo}: метрики ${sigs.length} слов — ${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}` +
      (model ? `; модель ${model.model_version}` : '; откалиброванной модели нет — порядковая шкала'));
  return { rows: sigs.length, counts, model: model?.model_version ?? null };
}
