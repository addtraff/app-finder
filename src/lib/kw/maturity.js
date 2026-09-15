// Стадии зрелости S0–S4 по гео (раздел 9). Переход — только по метрике валидации и по данным,
// которые реально есть в базе, а не по календарю.
import { daysBetween } from '../util.js';
import { kwConfig } from './schema.js';

export const STAGES = [
  { id: 'S0', title: 'Замок', what: 'Колонка отключена, работают позиции и выдача' },
  { id: 'S1', title: 'Порядковая шкала', what: 'Score 0–100 из подсказок, без единиц' },
  { id: 'S2', title: 'Первая калибровка', what: 'Изотоника по одному приложению, бакеты' },
  { id: 'S3', title: 'Модель', what: '3–5 приложений, бустинг, интервалы' },
  { id: 'S4', title: 'Поддержка', what: 'Сезонность, переобучение, дрейф, CTR' },
];

export function geoMaturity(d, geo, date) {
  const cfg = kwConfig();
  const one = (sql, ...p) => d.prepare(sql).get(...p);
  const signals = one(`SELECT COUNT(DISTINCT keyword_id) c, MAX(day) last FROM kw_signals WHERE geo=?`, geo);
  const consoleRows = one(`SELECT COUNT(*) c, COUNT(DISTINCT app_id) apps, MIN(day) first, MAX(day) last FROM console_search_terms WHERE geo=? AND is_censored=0`, geo);
  const active = one(`SELECT model_version, kind, spearman, trained_at FROM kw_models WHERE geo=? AND active=1 ORDER BY trained_at DESC LIMIT 1`, geo);
  const lastModel = one(`SELECT model_version, kind, spearman, trained_at, note FROM kw_models WHERE geo=? ORDER BY trained_at DESC, kind DESC LIMIT 1`, geo);
  const ctr = one(`SELECT fitted_at, source FROM kw_ctr_curve WHERE geo=? ORDER BY fitted_at DESC LIMIT 1`, geo);
  const trends = one(`SELECT COUNT(DISTINCT keyword) c FROM raw_external_trends WHERE geo=?`, geo).c;
  const planner = one(`SELECT COUNT(*) c FROM raw_external_keyword_planner WHERE geo=?`, geo).c;
  const asa = one(`SELECT COUNT(*) c FROM raw_external_asa WHERE geo=?`, geo).c;

  let stage = 'S0';
  if (signals.c > 0) stage = 'S1';
  if (active?.kind === 'isotonic') stage = 'S2';
  if (active?.kind === 'gbm') stage = 'S3';
  const modelAge = active ? daysBetween(active.trained_at, date) : null;
  const ctrAge = ctr ? daysBetween(ctr.fitted_at, date) : null;
  const s4 = stage === 'S3' && trends > 0 && modelAge <= cfg.health.model_max_age_days
    && ctr?.source === 'fit' && ctrAge <= cfg.ctr.refit_days;
  if (s4) stage = 'S4';

  // Что нужно для следующей ступени — словами, с указанием, откуда взять данные.
  const next = {
    S0: 'Посчитать score: node src/kw.js run --geo ' + geo,
    S1: consoleRows.c
      ? `Выгрузка Console есть (${consoleRows.c} строк) — калибровка не прошла порог Spearman ${cfg.validation.spearman_bucket} или данных мало: node src/kw.js calibrate --geo ${geo}`
      : 'Нужна выгрузка Play Console → Search terms хотя бы по одному приложению за 90 дней (доступ к Console)',
    S2: `Нужны данные 3–5 приложений разной силы (${consoleRows.apps || 0} сейчас) и от ${cfg.calibration.min_rows_gbm} строк; желательно Keyword Planner (${planner} слов) и Trends (${trends})`,
    S3: 'Нужны сезонные профили Google Trends, свежая модель (не старше ' + cfg.health.model_max_age_days + ' дн.) и подогнанная кривая CTR',
    S4: 'Ежемесячное переобучение и пересчёт CTR раз в квартал',
  }[stage];

  return {
    geo, stage, next,
    signals: signals.c, signals_last: signals.last,
    console_rows: consoleRows.c, console_apps: consoleRows.apps, console_first: consoleRows.first, console_last: consoleRows.last,
    active_model: active || null, last_model: lastModel || null, model_age_days: modelAge,
    ctr: ctr || null, ctr_age_days: ctrAge, trends_terms: trends, planner_terms: planner, asa_terms: asa,
  };
}
