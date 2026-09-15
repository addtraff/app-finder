// Таблицы модуля объёма поиска (docs/metodika-kw-volume.md, раздел 11).
//
// Схема живёт отдельно от src/lib/db.js: модуль ничего не пишет в таблицы радара и не
// должен зависеть от того, как радар меняет свои. Общее с радаром — только чтение сырья:
// raw_suggest (кэш префиксов), raw_search и raw_app_page (признаки выдачи), disc_keywords
// (словарь), raw_external_keyword_planner и raw_external_trends (внешние признаки).
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from '../db.js';

const SCHEMA = `
-- Идентификатор фразы общий для всех гео: сама фраза одинакова, различаются сигналы.
CREATE TABLE IF NOT EXISTS keywords (
  keyword_id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT UNIQUE NOT NULL
);

-- Каждое обращение к подсказкам, включая пустой ответ и ошибку. raw_suggest хранит только
-- непустые строки: без этой таблицы префикс без подсказок переспрашивался бы при каждом
-- расчёте, а доля ошибок разбора (алерт дрейфа парсера, раздел 10) была бы не видна.
CREATE TABLE IF NOT EXISTS raw_suggest_fetch (
  snapshot_date TEXT, geo TEXT, hl TEXT, prefix TEXT,
  n INTEGER, ok INTEGER, error TEXT, fetched_at TEXT,
  PRIMARY KEY (snapshot_date, geo, prefix)
);
CREATE INDEX IF NOT EXISTS ix_suggest_value ON raw_suggest(suggestion, geo);
CREATE INDEX IF NOT EXISTS ix_suggest_prefix ON raw_suggest(geo, prefix, snapshot_date);

-- Ground truth из Play Console (раздел 3.1). Колонка unique_clicks хранит «конверсии»
-- в той метрике, что указана в metric_kind: до перехода 2026 года это acquisitions.
-- is_censored = 1 — слово ниже порога отсечения: мы в топ-50 по нему, а в выгрузке его нет.
-- Это «меньше порога», а не ноль, поэтому числа у таких строк пустые.
CREATE TABLE IF NOT EXISTS console_search_terms (
  app_id TEXT, geo TEXT, lang TEXT, term TEXT, day TEXT,
  impressions INTEGER, visitors INTEGER, unique_clicks INTEGER,
  metric_kind TEXT,
  is_censored INTEGER DEFAULT 0,
  source_file TEXT, imported_at TEXT,
  PRIMARY KEY (app_id, geo, lang, term, day, metric_kind)
);
CREATE INDEX IF NOT EXISTS ix_console_geo ON console_search_terms(geo, day);

-- Трекер позиций по словам своих приложений и избранному. Отдельно от raw_search:
-- срезы трекера не должны попадать в ниши, граф похожих и воронку радара.
CREATE TABLE IF NOT EXISTS kw_track_serp (
  snapshot_date TEXT, geo TEXT, term TEXT, position INTEGER, app_id TEXT,
  PRIMARY KEY (snapshot_date, geo, term, position)
);
CREATE INDEX IF NOT EXISTS ix_track_app ON kw_track_serp(app_id, geo, term, snapshot_date);

CREATE TABLE IF NOT EXISTS kw_watch (
  geo TEXT, term TEXT, added_at TEXT, note TEXT,
  PRIMARY KEY (geo, term)
);

CREATE TABLE IF NOT EXISTS raw_external_asa (
  geo TEXT, keyword TEXT, popularity INTEGER, imported_at TEXT,
  PRIMARY KEY (geo, keyword)
);

-- Сигналы (раздел 11) плюс остальные признаки раздела 5 и то, как посчитан score.
-- probes — лестница префиксов: [i, позиция или 0, s|i|a|n] (s — снято, i — выведено
-- по соседним снятым, a — снято и фразы нет, n — не снималось, ниже точки появления).
-- score_raw — формула 4.2; score_raw_norm — она же, делённая на максимум для длины фразы.
-- score — перцентиль того варианта, что указан в config score.normalization.
CREATE TABLE IF NOT EXISTS kw_signals (
  keyword_id INTEGER, geo TEXT, day TEXT,
  score REAL, min_prefix_len INTEGER, avg_suggest_pos REAL,
  kp_volume REAL, trends_index REAL, asa_popularity REAL,
  top10_installs_median REAL, top10_reviews_median REAL,
  title_match_share REAL, total_results INTEGER,
  score_raw REAL, score_raw_norm REAL, prefix_hit_share REAL, score_method TEXT, probes TEXT,
  prefixes_total INTEGER, requests INTEGER,
  installs_spread REAL, suggest_geo_count INTEGER,
  words INTEGER, chars INTEGER, stopword_share REAL, is_brand INTEGER, lang TEXT, is_translit INTEGER,
  category TEXT, score_group TEXT, serp_date TEXT, tracked INTEGER,
  PRIMARY KEY (keyword_id, geo, day)
);
CREATE INDEX IF NOT EXISTS ix_kw_signals_geo ON kw_signals(geo, day);

CREATE TABLE IF NOT EXISTS kw_metrics (
  keyword_id INTEGER, geo TEXT, day TEXT,
  popularity_score REAL, impressions_est REAL, impressions_lo REAL, impressions_hi REAL,
  confidence_level TEXT,
  bucket TEXT, seasonal_mult REAL, model_kind TEXT,
  model_version TEXT, calibrated_at TEXT,
  PRIMARY KEY (keyword_id, geo, day)
);
CREATE INDEX IF NOT EXISTS ix_kw_metrics_geo ON kw_metrics(geo, day);

-- Реестр моделей. Без model_version и calibrated_at нельзя объяснить, почему цифра
-- полгода назад была другой (раздел 11). active = прошла порог и применяется сейчас.
CREATE TABLE IF NOT EXISTS kw_models (
  model_version TEXT PRIMARY KEY, geo TEXT, kind TEXT, stage TEXT,
  trained_at TEXT, window_from TEXT, window_to TEXT, metric_kind TEXT,
  n_rows INTEGER, n_terms INTEGER, n_apps INTEGER, apps TEXT,
  spearman REAL, bucket_hit REAL, sum_ratio REAL, censored_below_share REAL,
  validation TEXT, active INTEGER DEFAULT 0, note TEXT, params TEXT
);

CREATE TABLE IF NOT EXISTS kw_ctr_curve (
  geo TEXT, fitted_at TEXT, ctr1 REAL, alpha REAL, n INTEGER, positions INTEGER, source TEXT,
  PRIMARY KEY (geo, fitted_at)
);

CREATE TABLE IF NOT EXISTS kw_geo_check (
  geo TEXT, checked_at TEXT, hl TEXT, prefix TEXT, expect TEXT, found INTEGER, suggestions TEXT, error TEXT,
  PRIMARY KEY (geo, checked_at)
);

CREATE TABLE IF NOT EXISTS kw_runs (
  run_id TEXT, stage TEXT, geo TEXT, day TEXT, started_at TEXT, finished_at TEXT, status TEXT,
  requests INTEGER, cache_hits INTEGER, errors INTEGER, shape_errors INTEGER, empty INTEGER, notes TEXT,
  PRIMARY KEY (run_id, stage, geo)
);
`;

// Keyword Planner отдаёт диапазоны («1K – 10K»), а таблица радара хранит одно число.
const MIGRATIONS = [
  ['raw_external_keyword_planner', 'range_low', 'INTEGER'],
  ['raw_external_keyword_planner', 'range_high', 'INTEGER'],
];

let ready = false;

export function kwDb() {
  const d = db();
  if (ready) return d;
  d.exec(SCHEMA);
  const has = d.prepare(`SELECT COUNT(*) c FROM pragma_table_info(?) WHERE name = ?`);
  for (const [table, column, type] of MIGRATIONS) {
    if (has.get(table, column).c === 0) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  ready = true;
  return d;
}

let _cfg = null;
export function kwConfig() {
  if (!_cfg) _cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kw-volume.json'), 'utf8'));
  return _cfg;
}

export const normTerm = (s) => String(s ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();

export function keywordId(d, term) {
  const t = normTerm(term);
  d.prepare(`INSERT OR IGNORE INTO keywords (term) VALUES (?)`).run(t);
  return d.prepare(`SELECT keyword_id FROM keywords WHERE term=?`).get(t).keyword_id;
}
