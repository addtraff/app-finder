// Единая база радара. Принцип ТЗ: сырьё пишется с датой и НЕ перетирается.
// Любой скоринг пересчитывается задним числом из сырья.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DB_PATH = process.env.RADAR_DB || path.join(ROOT, 'data', 'radar.db');
export { ROOT };

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;
-- Гео обходятся параллельно, а догоняющий прогон может пересечься с суточным.
-- WAL разводит читателей с писателем, но два писателя всё равно сталкиваются:
-- без ожидания второй немедленно падает с SQLITE_BUSY и теряет уже снятые данные.
PRAGMA busy_timeout = 15000;

-- ============ 6.1 Реестр ============
CREATE TABLE IF NOT EXISTS geos (
  geo TEXT PRIMARY KEY, hl TEXT, review_langs TEXT, currency TEXT, tier INTEGER,
  active INTEGER DEFAULT 0, vps_host TEXT,
  proxy_required_search INTEGER, proxy_required_suggest INTEGER,
  start_hour_utc INTEGER, ecpm_rel_us REAL, arpu_rel_us REAL, econ_source TEXT, econ_updated TEXT
);

CREATE TABLE IF NOT EXISTS seed_keywords (
  geo TEXT, keyword TEXT, lang TEXT, intent_type TEXT, weight REAL DEFAULT 1, concept TEXT,
  PRIMARY KEY (geo, keyword)
);
CREATE TABLE IF NOT EXISTS seed_apps (
  app_id TEXT, geo TEXT, note TEXT, PRIMARY KEY (app_id, geo)
);
CREATE TABLE IF NOT EXISTS seed_categories (
  geo TEXT, category TEXT, PRIMARY KEY (geo, category)
);

-- Реестр приложений. status/watch_level меняются событиями, строки не удаляются.
CREATE TABLE IF NOT EXISTS apps (
  app_id TEXT PRIMARY KEY,
  niche_id TEXT,
  watch_level TEXT,                        -- A | B | C | D; NULL = обнаружено, но ещё не проходило воронку
  status TEXT DEFAULT 'discovered',        -- discovered | short_list | watched | background | rejected
  reject_reason TEXT,
  first_seen TEXT, first_seen_geo TEXT,
  installs_source_geo TEXT DEFAULT 'US',
  title TEXT, developer TEXT, developer_id TEXT, genre_id TEXT
);

CREATE TABLE IF NOT EXISTS keyword_cores (
  niche_id TEXT, geo TEXT, keyword TEXT, intent_type TEXT,
  is_head INTEGER DEFAULT 0, active INTEGER DEFAULT 1, core_version TEXT,
  PRIMARY KEY (niche_id, geo, keyword)
);
CREATE TABLE IF NOT EXISTS niches (
  niche_id TEXT, geo TEXT, name TEXT, head_keyword TEXT, concept TEXT,
  label_manual TEXT, core_version TEXT, created_at TEXT,
  PRIMARY KEY (niche_id, geo)
);
CREATE TABLE IF NOT EXISTS fx_rates (
  snapshot_date TEXT, currency TEXT, rate_to_usd REAL, source TEXT,
  PRIMARY KEY (snapshot_date, currency)
);
CREATE TABLE IF NOT EXISTS blocklist (
  kind TEXT, value TEXT, note TEXT, PRIMARY KEY (kind, value)
);
CREATE TABLE IF NOT EXISTS institution_domains (
  pattern TEXT PRIMARY KEY, kind TEXT, note TEXT
);

-- ============ 6.2 Сырые снимки ============
CREATE TABLE IF NOT EXISTS raw_app_page (
  app_id TEXT, geo TEXT, hl TEXT, snapshot_date TEXT, run_id TEXT, cycle TEXT,
  title TEXT, summary TEXT, description TEXT, description_len INTEGER,
  max_installs INTEGER, min_installs INTEGER, installs_text TEXT, installs_country TEXT,
  score REAL, ratings_count INTEGER, reviews_count INTEGER, histogram TEXT,
  price REAL, currency TEXT, free INTEGER, available INTEGER,
  offers_iap INTEGER, iap_range TEXT, iap_min_usd REAL, iap_max_usd REAL, contains_ads INTEGER,
  size_text TEXT, size_mb REAL, android_version TEXT,
  released TEXT, updated_ts INTEGER, version TEXT,
  genre TEXT, genre_id TEXT, content_rating TEXT, badges TEXT,
  screenshots_count INTEGER, video_present INTEGER,
  developer TEXT, developer_id TEXT, developer_email TEXT, developer_website TEXT,
  developer_address TEXT, developer_legal_name TEXT, privacy_policy TEXT,
  permissions TEXT, similar TEXT, listing_hash TEXT, title_hash TEXT, short_desc_hash TEXT, raw_json TEXT,
  PRIMARY KEY (app_id, geo, hl, snapshot_date)
);
CREATE INDEX IF NOT EXISTS ix_app_page_date ON raw_app_page(snapshot_date, geo);
-- Частичный индекс по разрешениям живёт не здесь, а в tools/ensure-indexes.js. Причина:
-- построение индекса на таблице в 554 000 строк держит блокировку записи секунд двадцать,
-- а схема выполняется при КАЖДОМ открытии базы — то есть первый же процесс, запущенный
-- во время сбора, уронил бы полосу по SQLITE_BUSY (ожидание записи у нас 15 секунд).
-- Индекс строится отдельным шагом, когда конвейер свободен.

CREATE TABLE IF NOT EXISTS raw_search (
  snapshot_date TEXT, geo TEXT, keyword TEXT, position INTEGER, app_id TEXT, run_id TEXT,
  PRIMARY KEY (snapshot_date, geo, keyword, position)
);
CREATE INDEX IF NOT EXISTS ix_search_app ON raw_search(app_id, geo, snapshot_date);
CREATE INDEX IF NOT EXISTS ix_search_kw ON raw_search(geo, keyword, snapshot_date);

CREATE TABLE IF NOT EXISTS raw_suggest (
  snapshot_date TEXT, geo TEXT, prefix TEXT, position INTEGER, suggestion TEXT,
  PRIMARY KEY (snapshot_date, geo, prefix, position)
);

CREATE TABLE IF NOT EXISTS raw_reviews (
  review_id TEXT PRIMARY KEY, app_id TEXT, geo TEXT, lang TEXT,
  review_date TEXT, rating INTEGER, text TEXT, version TEXT,
  thumbs_up INTEGER, reply_present INTEGER, fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_rev_app ON raw_reviews(app_id, review_date);

CREATE TABLE IF NOT EXISTS raw_developer (
  developer_id TEXT, snapshot_date TEXT, legal_name TEXT, address TEXT, address_norm TEXT,
  email TEXT, website TEXT, domain TEXT, apps_count INTEGER, apps_json TEXT,
  update_interval_median REAL, is_factory INTEGER,
  PRIMARY KEY (developer_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS raw_charts (
  snapshot_date TEXT, geo TEXT, collection TEXT, category TEXT, position INTEGER, app_id TEXT,
  PRIMARY KEY (snapshot_date, geo, collection, category, position)
);

CREATE TABLE IF NOT EXISTS raw_similar (
  snapshot_date TEXT, geo TEXT, app_id TEXT, similar_app_id TEXT, position INTEGER,
  PRIMARY KEY (snapshot_date, geo, app_id, similar_app_id)
);

-- K7: рекламные библиотеки. Пусто = "не проверено", не "органика".
-- Единица запроса — домен рекламодателя, а не приложение: у одного разработчика
-- шесть приложений это один запрос. Успешно проверенный домен не переспрашивается,
-- строки с ошибкой (status <> 'ok') остаются в очереди.
CREATE TABLE IF NOT EXISTS raw_ads_google (
  developer_domain TEXT, checked_at TEXT, creatives_found INTEGER, count INTEGER, note TEXT,
  status TEXT, advertiser_id TEXT, raw_json TEXT,
  PRIMARY KEY (developer_domain, checked_at)
);

-- Ответ RPC разбирается целиком: все скалярные поля с их путями, как есть.
-- Ключи у Google числовые и недокументированные — здесь ничего не интерпретируется,
-- разметка делается офлайн по накопленным данным.
CREATE TABLE IF NOT EXISTS raw_ads_google_field (
  developer_domain TEXT, checked_at TEXT, path TEXT, value TEXT,
  PRIMARY KEY (developer_domain, checked_at, path)
);
CREATE TABLE IF NOT EXISTS raw_ads_meta (
  app_id TEXT, query TEXT, checked_at TEXT, found_by_package_id INTEGER, ad_count INTEGER, note TEXT,
  PRIMARY KEY (app_id, checked_at)
);

-- E4: разбор APK по именам пакетов классов. Декомпиляция в объём не входит.
-- Необязательный ручной путь (нужно скачать APK) — по умолчанию заменён на
-- raw_tracking_scan ниже, который ищет то же самое (трекеры атрибуции) без скачивания.
CREATE TABLE IF NOT EXISTS raw_apk (
  app_id TEXT, version TEXT, checked_at TEXT, file_name TEXT,
  attribution_sdk INTEGER, attribution_list TEXT,
  paywall_sdk TEXT, compute_location TEXT, ad_sdks TEXT,
  size_mb_apk REAL, locales_apk INTEGER, locales_apk_list TEXT,
  iap_products_count INTEGER, has_annual_tier INTEGER, note TEXT,
  PRIMARY KEY (app_id, version)
);

-- Замена ручного разбора APK: поиск SDK атрибуции по имени в тексте описания, privacy
-- policy и Data Safety — без скачивания файла. Улика слабее прямого чтения байткода
-- (текст может упоминать трекер как "может использоваться", не как факт интеграции),
-- поэтому found=1 трактуется как прямая улика (organic=0), а found=0 НЕ считается
-- подтверждённым отсутствием — в отличие от found=0 в raw_apk.
CREATE TABLE IF NOT EXISTS raw_tracking_scan (
  app_id TEXT, checked_at TEXT,
  found INTEGER, matched_names TEXT, matched_in TEXT,   -- matched_in: description,privacy_policy
  privacy_policy_url TEXT, privacy_fetch_ok INTEGER, privacy_fetch_status INTEGER,
  datasafety_ad_id_shared INTEGER, datasafety_purposes TEXT, note TEXT,
  PRIMARY KEY (app_id, checked_at)
);

-- E1 / E2: ручные квартальные выгрузки.
CREATE TABLE IF NOT EXISTS raw_external_keyword_planner (
  geo TEXT, keyword TEXT, avg_monthly_searches INTEGER, imported_at TEXT,
  PRIMARY KEY (geo, keyword)
);
-- Снимки внешнего спроса по датам: та же выгрузка, но с историей.
--
-- Зачем отдельная таблица. В raw_external_keyword_planner ключ первичный — (гео, слово),
-- то есть там живёт одно, последнее значение: так его читает kw/features.js, и ломать это
-- незачем. А рост и падение спроса видны только между снимками, поэтому каждый импорт
-- дополнительно ложится сюда своей датой.
--
-- Важно, чего здесь НЕ будет. Первая выгрузка Asodesk (24.09, США) истории спроса не
-- содержит: 90 колонок с датами в ней — это позиции чужого приложения, к которому привязан
-- аккаунт, а спрос дан одним числом на сегодня. Значит, первый тренд появится со второй
-- выгрузкой, и до тех пор поле роста честно пустует.
CREATE TABLE IF NOT EXISTS raw_external_keyword_hist (
  geo TEXT, keyword TEXT, snapshot_date TEXT, source TEXT,
  daily_impressions REAL, difficulty INTEGER, apps_ranked INTEGER, brand_app TEXT,
  imported_at TEXT,
  PRIMARY KEY (geo, keyword, snapshot_date, source)
);
CREATE INDEX IF NOT EXISTS ix_ext_kw_hist ON raw_external_keyword_hist(geo, snapshot_date);
CREATE TABLE IF NOT EXISTS raw_external_trends (
  geo TEXT, keyword TEXT, point_date TEXT, value REAL, imported_at TEXT,
  PRIMARY KEY (geo, keyword, point_date)
);

-- ============ 6.3 Таблицы обхода ============
CREATE TABLE IF NOT EXISTS disc_keywords (
  geo TEXT, keyword TEXT, lang TEXT, source TEXT, depth INTEGER,
  intent_type TEXT, is_brand INTEGER DEFAULT 0, dead INTEGER DEFAULT 0,
  suggest_score REAL DEFAULT 0, suggest_depth INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1, first_seen TEXT, concept TEXT,
  PRIMARY KEY (geo, keyword)
);
CREATE TABLE IF NOT EXISTS disc_apps (
  app_id TEXT, geo TEXT, first_seen_via TEXT, discovery_paths_count INTEGER DEFAULT 1,
  geo_paths_count INTEGER DEFAULT 1, first_seen TEXT,
  PRIMARY KEY (app_id, geo)
);
CREATE TABLE IF NOT EXISTS disc_app_keyword (
  geo TEXT, keyword TEXT, app_id TEXT, best_position INTEGER, snapshot_date TEXT,
  PRIMARY KEY (geo, keyword, app_id)
);
CREATE TABLE IF NOT EXISTS disc_similar_edges (
  geo TEXT, src TEXT, dst TEXT, depth INTEGER, PRIMARY KEY (geo, src, dst)
);
CREATE TABLE IF NOT EXISTS developer_clusters (
  cluster_id TEXT, key_type TEXT, key_value TEXT, developer_id TEXT, is_factory INTEGER,
  PRIMARY KEY (key_type, key_value, developer_id)
);
CREATE TABLE IF NOT EXISTS screen_result (
  app_id TEXT, geo TEXT, snapshot_date TEXT,
  stage_reached INTEGER, reject_reason TEXT, prescore REAL, niche_id TEXT, detail TEXT,
  PRIMARY KEY (app_id, geo, snapshot_date)
);

-- ============ 6.4 Расчётные таблицы ============
CREATE TABLE IF NOT EXISTS metrics_app_geo (
  app_id TEXT, geo TEXT, snapshot_date TEXT, niche_id TEXT, watch_level TEXT,
  -- день 0 (score/descr отмечены в column_class)
  installs INTEGER, ratings_count INTEGER, score REAL,
  installs_per_rating REAL, age_months REAL, days_since_update REAL, target_sdk_risk INTEGER,
  size_mb REAL, screenshots_count INTEGER, video_present INTEGER, description_len INTEGER,
  localized_geo_count INTEGER, localized_hl_list TEXT, localization_quality REAL,
  available_in_geo INTEGER, localized_here INTEGER,
  installs_source_geo TEXT, installs_consistency INTEGER,
  iap_min_usd REAL, iap_max_usd REAL, contains_ads INTEGER, monetization_type TEXT,
  monetization_proof REAL, permissions_risky INTEGER, policy_risk_category INTEGER,
  content_rating TEXT, head_kw_in_title INTEGER, installs_per_month_lifetime REAL,
  kw_top10_count INTEGER, kw_top50_count INTEGER, index_breadth REAL, index_gap REAL,
  polarization REAL, wom_index REAL, suggest_depth INTEGER, portfolio_size INTEGER,
  -- день 1
  installs_delta_1d INTEGER, installs_growth_1d REAL, ratings_delta_24h INTEGER,
  listing_changed INTEGER, new_reviews_24h INTEGER, rank_best INTEGER, rank_delta_24h REAL,
  -- день 7
  installs_growth_7d REAL, ratings_per_day_7d REAL, burst_flag INTEGER,
  spearman_rank_installs REAL, rank_volatility REAL,
  -- день 14 (отзывы)
  reviews_labeled INTEGER, growth REAL, growth_conf REAL, growth_s REAL,
  pain_money REAL, pain_ads REAL, pain_broken REAL, pain_missing REAL, pain_trust REAL,
  pain_dominant TEXT, pain_fit REAL, src_ads_pct REAL, src_ugc_pct REAL, src_store_pct REAL,
  crash_pct REAL, repeat_use_pct REAL, rating_recent_30d REAL, template_review_pct REAL,
  review_lang_mismatch REAL, missing_language_pct REAL, fraud_ok INTEGER,
  -- день 30
  installs_growth_30d REAL, organic REAL, ads_found TEXT, attribution_sdk INTEGER,
  policy_ok INTEGER, policy_auto_ok INTEGER, verification_level TEXT,
  paywall_sdk TEXT, compute_location TEXT, ad_sdks TEXT, size_mb_apk REAL, locales_apk INTEGER,
  iap_products_count INTEGER, has_annual_tier INTEGER,
  -- скор
  demand REAL, fake REAL, weakness REAL, openness REAL, feasibility REAL,
  policy_penalty REAL, prescore REAL, copy_score_gp REAL, copy_score_provisional REAL, geo_multiplier REAL,
  PRIMARY KEY (app_id, geo, snapshot_date)
);
CREATE INDEX IF NOT EXISTS ix_mag_date ON metrics_app_geo(snapshot_date, geo);

CREATE TABLE IF NOT EXISTS metrics_niche_geo (
  niche_id TEXT, geo TEXT, snapshot_date TEXT,
  name TEXT, head_keyword TEXT, keywords_count INTEGER, apps_count INTEGER,
  door INTEGER, best_door INTEGER, wall_installs INTEGER, wall_ratings INTEGER,
  demand_installs INTEGER, weak_share REAL, new_share_18m REAL, leader_share REAL,
  exact_in_title REAL, jaccard_top5_median REAL, relevance_gap_pct REAL,
  generic_demand_share REAL, suggest_score_sum REAL, top10_turnover_30d REAL,
  index_gap_leader REAL, top_apps TEXT, concept TEXT,
  top10_turnover_7d REAL, top10_turnover_14d REAL, partial_window INTEGER,
  PRIMARY KEY (niche_id, geo, snapshot_date)
);

CREATE TABLE IF NOT EXISTS metrics_geo_arbitrage (
  niche_id TEXT, geo TEXT, snapshot_date TEXT,
  wall_ratio REAL, door_ratio REAL, demand_ratio REAL, money_ratio REAL, geo_arbitrage REAL,
  PRIMARY KEY (niche_id, geo, snapshot_date)
);

-- ============ Методика v2.0 (ТЗ AppRadar 2, раздел 5) ============
-- Отдельные таблицы, а не колонки metrics_niche_geo / metrics_app_geo: niche-doors и score
-- перезаписывают свои строки целиком (INSERT OR REPLACE с явным списком колонок), и новые
-- поля обнулялись бы при каждом их пересчёте. Пишет только стадия radar-v2.
CREATE TABLE IF NOT EXISTS metrics_keyword_geo (
  geo TEXT, snapshot_date TEXT, niche_id TEXT, keyword TEXT, is_head INTEGER,
  suggest_score REAL, serp_date TEXT, top10_cards INTEGER, door_key INTEGER, door_app_id TEXT,
  is_free INTEGER, paid_in_top10 INTEGER, paid_ctr_share REAL, ads_checked_share REAL,
  PRIMARY KEY (geo, snapshot_date, niche_id, keyword)
);
CREATE TABLE IF NOT EXISTS metrics_niche_v2 (
  niche_id TEXT, geo TEXT, snapshot_date TEXT, niche_date TEXT, concept TEXT, head_keyword TEXT,
  keywords_count INTEGER, door INTEGER, wall_installs INTEGER,
  free_keys_count INTEGER, free_demand_share REAL, door_head INTEGER, door_tail INTEGER, door_velocity REAL,
  demand_per_app REAL, aso_saturation REAL, relevance_gap_pct REAL,
  entry_rate_90d INTEGER, last_entry_days INTEGER, history_days INTEGER, time_to_door_median REAL,
  turnover_up_new REAL, turnover_window_days INTEGER, hhi_top10 REAL, clone_density REAL,
  freedom_components TEXT, freedom_raw REAL, freedom_pct REAL, closed_flag INTEGER,
  organic_capacity REAL, organic_capacity_lo REAL, organic_capacity_hi REAL,
  money_ratio REAL, money_capacity REAL,
  organic_purity REAL, purity_coverage REAL, top10_ads_share REAL,
  young_organic_count INTEGER, young_organic_installs INTEGER, young_organic_apps TEXT,
  time_to_organic REAL, time_to_organic_kind TEXT,
  candidates_count INTEGER, candidates_organic_count INTEGER, candidates_paid_count INTEGER,
  monetized_share REAL, leaders_pain TEXT, head_top10 TEXT,
  niche_rank REAL, rank_basis TEXT, rank_pct REAL, quadrant TEXT, tail_clean INTEGER,
  incomplete TEXT, partial_window INTEGER,
  PRIMARY KEY (niche_id, geo, snapshot_date)
);
CREATE TABLE IF NOT EXISTS metrics_app_v2 (
  app_id TEXT, geo TEXT, snapshot_date TEXT, niche_id TEXT, passed_funnel INTEGER,
  released TEXT, age_months REAL, young INTEGER,
  organic_level TEXT, evidence_date TEXT, evidence_age_days INTEGER,
  ads_found TEXT, ads_google INTEGER, ads_google_checked TEXT, ads_google_host TEXT, ads_google_creatives INTEGER,
  ads_google_first_seen TEXT, ads_google_last_seen TEXT, ads_google_active INTEGER,
  ads_meta INTEGER, ads_meta_checked TEXT, ads_ever_found INTEGER,
  attribution_sdk INTEGER, tracking_names TEXT, apk_parsed INTEGER,
  installs INTEGER, installs_delta_30d REAL, delta_window_days INTEGER, delta_partial INTEGER,
  search_weight REAL, explained REAL, aso_share REAL, traffic_source TEXT, exogenous_spike_rate REAL,
  keywords_json TEXT,
  checks TEXT, check_notes TEXT, passed INTEGER, failed INTEGER, unknown INTEGER, disq TEXT,
  PRIMARY KEY (app_id, geo, snapshot_date)
);
-- До какой строки raw_reviews дошёл классификатор данной версии: разметка УБТ не пишет
-- метку «ничего не найдено» на каждый из миллиона отзывов, а продолжает с водяного знака.
CREATE TABLE IF NOT EXISTS label_progress (
  classifier_version TEXT PRIMARY KEY, max_rowid INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS metrics_geo_calibration (
  geo TEXT, snapshot_date TEXT, k_geo REAL, k_p25 REAL, k_p75 REAL, n_obs INTEGER,
  n_candidates INTEGER, window_days INTEGER, status TEXT,
  PRIMARY KEY (geo, snapshot_date)
);

CREATE TABLE IF NOT EXISTS review_labels (
  review_id TEXT, label TEXT, classifier_version TEXT,
  PRIMARY KEY (review_id, label, classifier_version)
);

-- Источник ВСЕХ порогов. Абсолютные числа в конфиге запрещены (принцип 9).
CREATE TABLE IF NOT EXISTS niche_quantiles (
  scope TEXT, scope_id TEXT, geo TEXT, metric TEXT, snapshot_date TEXT,
  p01 REAL, p10 REAL, p25 REAL, p50 REAL, p75 REAL, p90 REAL, p95 REAL, p99 REAL, n INTEGER,
  PRIMARY KEY (scope, scope_id, geo, metric, snapshot_date)
);

CREATE TABLE IF NOT EXISTS organic_labels (
  app_id TEXT, label TEXT, evidence TEXT, labeled_at TEXT, note TEXT,
  PRIMARY KEY (app_id, evidence, labeled_at)
);
CREATE TABLE IF NOT EXISTS feature_validation (
  feature TEXT, snapshot_date TEXT, n_buys INTEGER, n_organic INTEGER,
  separation REAL, in_score INTEGER,
  PRIMARY KEY (feature, snapshot_date)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT, geo TEXT, app_id TEXT, niche_id TEXT,
  kind TEXT, detail TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_date ON events(snapshot_date, kind);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT, stage TEXT, geo TEXT, cycle TEXT, snapshot_date TEXT,
  started_at TEXT, finished_at TEXT, status TEXT,
  requests INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, empty_pct REAL, notes TEXT,
  PRIMARY KEY (run_id, stage, geo)
);

-- Классификация колонок: score (входит в скор) / descr (описательная).
CREATE TABLE IF NOT EXISTS column_class (
  table_name TEXT, column_name TEXT, class TEXT, note TEXT,
  PRIMARY KEY (table_name, column_name)
);

-- Журнал предсказаний (этап 0 ТЗ AppRadar 3). Без него проверить модель нечем: чтобы
-- сказать «наш порядок лучше случайного», нужно иметь записанным, ЧТО именно мы выдали
-- в прошлом и на каких признаках, а не пересчитывать задним числом сегодняшней формулой.
-- Именно поэтому признаки хранятся копией на момент T0, а не читаются потом из метрик:
-- определения метрик меняются, и пересчёт показал бы не то, что модель видела.
--
-- Пишется не весь список кандидатов, а голова обеих моделей (то, что мы действительно
-- рекомендуем) плюс случайная выборка из остальных того же размера. Голова нужна для
-- Precision@K, выборка — как база сравнения: без неё «80 % из топа выросли» ничего не
-- значит, потому что неизвестно, сколько выросло бы при случайном выборе.
CREATE TABLE IF NOT EXISTS predictions (
  pred_date TEXT, geo TEXT, kind TEXT, object_id TEXT,
  model_set TEXT,                    -- версия набора моделей; порядок меняется — версия растёт
  rank_ar3 INTEGER, rank_ar2 INTEGER, score_ar2 REAL,
  -- Для приложений: 1 — голова модели, 0 — случайная выборка сравнения.
  -- Для ниш смысл другой и записан здесь же: 1 — квадрант «Цель», то есть само предсказание
  -- «в этой нише появятся молодые органики»; выборки сравнения у ниш нет, они пишутся все.
  in_head INTEGER,
  features TEXT,                     -- признаки на T0, как их видела модель
  created_at TEXT,
  outcome_30 TEXT, outcome_30_at TEXT,
  outcome_90 TEXT, outcome_90_at TEXT,
  PRIMARY KEY (pred_date, geo, kind, object_id)
);
CREATE INDEX IF NOT EXISTS ix_pred_due ON predictions(pred_date, kind);

-- Правило последнего полного дня (K0).
CREATE TABLE IF NOT EXISTS day_status (
  geo TEXT, snapshot_date TEXT, rows_today INTEGER, rows_prev INTEGER,
  partial INTEGER, suspect INTEGER, PRIMARY KEY (geo, snapshot_date)
);
`;

// CREATE TABLE IF NOT EXISTS не добавляет колонки в уже созданную базу,
// поэтому новые поля доезжают отдельным идемпотентным шагом.
const MIGRATIONS = [
  // Внешние объёмы: Asodesk даёт дневные показы, сложность 0–100, число ранжирующихся
  // приложений и бренд, который держит запрос. Последнее особенно важно: запрос с брендом
  // и сложностью под сотню — навигационный, и в спрос ниши он идти не должен.
  ['raw_external_keyword_planner', 'competition', 'TEXT'],
  ['raw_external_keyword_planner', 'competition_index', 'INTEGER'],
  ['raw_external_keyword_planner', 'source', 'TEXT'],
  ['raw_external_keyword_planner', 'daily_impressions', 'REAL'],
  ['raw_external_keyword_planner', 'apps_ranked', 'INTEGER'],
  ['raw_external_keyword_planner', 'brand_app', 'TEXT'],
  ['raw_external_keyword_planner', 'measured_at', 'TEXT'],
  // Спрос ниши в настоящих единицах: сумма показов по ядровым ключам, без навигационных.
  // demand_est=1 означает «оценка по США», а не замер этой страны.
  ['metrics_niche_v2', 'demand_ext', 'REAL'],
  ['metrics_niche_v2', 'demand_nav', 'REAL'],
  ['metrics_niche_v2', 'demand_cov', 'REAL'],
  ['metrics_niche_v2', 'difficulty_ext', 'REAL'],
  ['metrics_niche_v2', 'demand_src', 'TEXT'],
  ['metrics_niche_v2', 'demand_est', 'INTEGER'],
  ['metrics_keyword_geo', 'ext_impressions', 'REAL'],
  ['metrics_keyword_geo', 'ext_difficulty', 'INTEGER'],
  ['metrics_keyword_geo', 'ext_brand_app', 'TEXT'],
  ['metrics_keyword_geo', 'ext_navigational', 'INTEGER'],
  ['seed_keywords', 'concept', 'TEXT'],
  ['disc_keywords', 'concept', 'TEXT'],
  ['niches', 'concept', 'TEXT'],
  ['metrics_niche_geo', 'concept', 'TEXT'],
  // Дополнение к ТЗ v2.1
  ['raw_app_page', 'title_hash', 'TEXT'],              // A1
  ['raw_app_page', 'short_desc_hash', 'TEXT'],         // A1
  ['metrics_app_geo', 'localized_geo_count', 'INTEGER'],
  ['metrics_app_geo', 'localized_hl_list', 'TEXT'],
  ['metrics_app_geo', 'installs_source_geo', 'TEXT'],  // A2
  ['metrics_app_geo', 'installs_consistency', 'INTEGER'],
  ['metrics_app_geo', 'policy_auto_ok', 'INTEGER'],    // C1
  ['metrics_app_geo', 'paywall_sdk', 'TEXT'],          // B2
  ['metrics_app_geo', 'compute_location', 'TEXT'],
  ['metrics_app_geo', 'ad_sdks', 'TEXT'],
  ['metrics_app_geo', 'size_mb_apk', 'REAL'],
  ['metrics_app_geo', 'locales_apk', 'INTEGER'],
  ['metrics_app_geo', 'iap_products_count', 'INTEGER'],
  ['metrics_app_geo', 'has_annual_tier', 'INTEGER'],
  ['metrics_niche_geo', 'top10_turnover_7d', 'REAL'],  // C3
  ['metrics_niche_geo', 'top10_turnover_14d', 'REAL'],
  ['metrics_niche_geo', 'partial_window', 'INTEGER'],
  ['raw_ads_google', 'status', 'TEXT'],
  ['raw_ads_google', 'advertiser_id', 'TEXT'],
  ['raw_ads_google', 'raw_json', 'TEXT'],
  // ТЗ AppRadar 2 v2.2: УБТ по отзывам и рекомендуемый топ
  ['metrics_keyword_geo', 'paid_ctr_share', 'REAL'],
  ['metrics_app_v2', 'ubt_mentions', 'INTEGER'],
  ['metrics_app_v2', 'ubt_reviews', 'INTEGER'],
  ['metrics_app_v2', 'ubt_share', 'REAL'],
  ['metrics_app_v2', 'ubt_signal', 'INTEGER'],
  ['metrics_app_v2', 'ubt_related', 'INTEGER'],
  ['metrics_app_v2', 'rec_score', 'REAL'],
  ['metrics_app_v2', 'rec_pct', 'REAL'],
  ['metrics_app_v2', 'rec_parts', 'TEXT'],
  ['metrics_niche_v2', 'ubt_share', 'REAL'],
  ['metrics_niche_v2', 'ubt_apps', 'INTEGER'],
  ['metrics_niche_v2', 'ubt_flag', 'INTEGER'],
  ['metrics_niche_v2', 'rec_score', 'REAL'],
  ['metrics_niche_v2', 'rec_pct', 'REAL'],
  ['metrics_niche_v2', 'rec_parts', 'TEXT'],
  // Предварительная дельта: окно любой длины, установки из карточек всех гео
  ['metrics_app_v2', 'delta_preview', 'REAL'],
  ['metrics_app_v2', 'delta_preview_raw', 'INTEGER'],
  ['metrics_app_v2', 'delta_preview_w', 'INTEGER'],
  ['metrics_app_v2', 'delta_preview_from', 'TEXT'],
  // Сглаженная метка квадранта: та, что держалась в большинстве последних 7 снимков, и
  // сколько дней из скольких она держалась. Плюс запас до границы: ниша со свободой 75,2
  // и ниша со свободой 92 попадают в один квадрант, но это разные ставки.
  ['metrics_niche_v2', 'quadrant_smooth', 'TEXT'],
  ['metrics_niche_v2', 'quadrant_days', 'INTEGER'],
  ['metrics_niche_v2', 'quadrant_seen', 'INTEGER'],
  ['metrics_niche_v2', 'freedom_margin', 'REAL'],
  ['metrics_niche_v2', 'purity_margin', 'REAL'],
  // Дверь в потоке: сколько установок в день у самого слабого из топ-10. Нынешняя дверь —
  // запас за всё время жизни, а пятилетнее приложение с 500 тыс. установок и трёхмесячное
  // со 100 тыс. — разные соперники: у первого может быть 100 установок в день, у второго
  // 3 000. Считается по приросту оценок: счётчик установок обновляется пачками.
  ['metrics_niche_geo', 'door_flow', 'INTEGER'],
  ['metrics_niche_v2', 'door_flow', 'INTEGER'],
  // Вес улик органики 0…1 и покрытие проверок. Не вероятность: пока нет backtest, называть
  // это вероятностью было бы оформлением догадки. Бинарное «признаков закупки нет»
  // одинаково звучит и когда проверены обе библиотеки с трекером, и когда проверен домен.
  ['metrics_app_v2', 'organic_score', 'REAL'],
  ['metrics_app_v2', 'evidence_coverage', 'REAL'],
  // Когда Play последний раз обновлял счётчик установок и сколько дней назад это было.
  // Число точное, но обновляется пачками — серия неизменных значений длится в медиане 3 дня.
  ['metrics_app_v2', 'installs_as_of', 'TEXT'],
  ['metrics_app_v2', 'installs_stale_days', 'INTEGER'],
  // Разброс собственной скорости: минимальный и максимальный прирост за 30 дней по
  // интервалам между обновлениями счётчика. Честное основание для диапазона на длинном
  // горизонте вместо умножения нынешней скорости на три.
  ['metrics_app_v2', 'rate_lo_30d', 'REAL'],
  ['metrics_app_v2', 'rate_hi_30d', 'REAL'],
  ['metrics_app_v2', 'rate_intervals', 'INTEGER'],
  // Momentum ключей: охват топ-10 и топ-50 неделю назад, посчитанный по тем же ключам,
  // что снимаются сейчас. Список наблюдаемых ключей растёт, и без общей базы сравнение
  // показывало бы рост охвата там, где вырос наш собственный список.
  ['metrics_app_v2', 'kw_top10_cmp', 'INTEGER'],
  ['metrics_app_v2', 'kw_top50_cmp', 'INTEGER'],
  ['metrics_app_v2', 'kw_top10_prev', 'INTEGER'],
  ['metrics_app_v2', 'kw_top50_prev', 'INTEGER'],
  ['metrics_app_v2', 'kw_momentum_days', 'INTEGER'],
  ['metrics_app_v2', 'kw_momentum_base', 'INTEGER'],
  // Счётчик установок не сдвинулся за окно: рост меньше одной ступени Play, а не ноль.
  ['metrics_app_v2', 'delta_flat', 'INTEGER'],
  // Скорость по числу оценок: они меняются втрое чаще счётчика установок и дают разрешение
  // там, где он молчит. installs_est_ratings — перевод в установки через «установок на оценку».
  ['metrics_app_v2', 'ratings_delta_30d', 'REAL'],
  ['metrics_app_v2', 'ratings_delta_raw', 'INTEGER'],
  ['metrics_app_v2', 'ratings_delta_w', 'INTEGER'],
  ['metrics_app_v2', 'installs_per_rating_now', 'REAL'],
  ['metrics_app_v2', 'installs_est_ratings', 'REAL'],
  // Полнота проверки рекламы: 'domain+name' | 'domain' | 'name' | NULL. «Признаков закупки
  // нет» по одному домену — слабее, чем по домену и имени: у кампаний на установку
  // приложения посадочного домена нет вообще, рекламодатель опознаётся по имени.
  ['metrics_app_v2', 'ads_check_scope', 'TEXT'],
  // Концепт подсказки подтверждён выдачей (niche-doors): 1 — да, 0 — чужая тема, NULL — не проверялся
  ['disc_keywords', 'concept_ok', 'INTEGER'],
];

function migrate(d) {
  const has = d.prepare(`SELECT COUNT(*) c FROM pragma_table_info(?) WHERE name = ?`);
  for (const [table, column, type] of MIGRATIONS) {
    if (has.get(table, column).c === 0) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

let _db = null;

export function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  // В базу одновременно пишут несколько процессов (сбор, K7/Meta, пересчёт). Транзакция
  // better-sqlite3 по умолчанию DEFERRED: если внутри сначала чтение, а потом запись,
  // а между ними успел записать другой процесс, повышение блокировки в WAL падает с
  // SQLITE_BUSY сразу — busy_timeout в этом случае не применяется вовсе. Так падал score
  // (чтение metrics_niche_geo -> запись metrics_geo_arbitrage), тот же шаблон есть в Meta
  // и в отзывах. IMMEDIATE берёт блокировку на запись в начале и ждёт её по busy_timeout.
  const deferredTx = _db.transaction.bind(_db);
  _db.transaction = (fn) => {
    const t = deferredTx(fn);
    const run = (...args) => t.immediate(...args);
    run.deferred = t.deferred;
    run.immediate = t.immediate;
    run.exclusive = t.exclusive;
    return run;
  };
  _db.exec(SCHEMA);
  migrate(_db);
  return _db;
}

export function tx(fn) {
  return db().transaction(fn);
}

export function logEvent(kind, { date, geo = null, appId = null, nicheId = null, detail = null } = {}) {
  db().prepare(
    `INSERT INTO events (snapshot_date, geo, app_id, niche_id, kind, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(date, geo, appId, nicheId, kind, detail == null ? null : String(detail), new Date().toISOString());
}

export function startRun(runId, stage, geo, cycle, date) {
  db().prepare(
    `INSERT OR REPLACE INTO runs (run_id, stage, geo, cycle, snapshot_date, started_at, status)
     VALUES (?,?,?,?,?,?, 'running')`
  ).run(runId, stage, geo, cycle, date, new Date().toISOString());
}

export function finishRun(runId, stage, geo, { status = 'ok', requests = 0, errors = 0, emptyPct = null, notes = null } = {}) {
  db().prepare(
    `UPDATE runs SET finished_at=?, status=?, requests=?, errors=?, empty_pct=?, notes=?
     WHERE run_id=? AND stage=? AND geo=?`
  ).run(new Date().toISOString(), status, requests, errors, emptyPct, notes, runId, stage, geo);
}
