// Отчёт «AppRadar 2» — ТЗ docs/tz-appradar-v2.md, разделы 6–9.
//
// Оформление AppRadar, данные — таблицы методики v2.0 (стадия radar-v2). Отчёт ничего не
// пересчитывает: берёт готовые метрики гео и только сводит их ворлдвайд — выбирает лучшее
// гео приложения и ниши с учётом денег гео с низким весом (решение заказчика №1).
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, DB_PATH } from '../lib/db.js';
import { config, referenceGeo } from '../lib/config.js';
import { quantile, norm, log } from '../lib/util.js';
import { packRows, UNPACK_JS } from '../lib/pack.js';
import { qv, clearQCache } from './quantiles.js';
import { collectCollection } from './dashboard.js';

const one = (d, sql, ...p) => d.prepare(sql).get(...p);
const all = (d, sql, ...p) => d.prepare(sql).all(...p);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Number(Number(v).toPrecision(4)));
// Копилка для роста ниши: одна на всю органику, вторая — только на прошедших воронку.
const bucket = () => ({ apps: 0, installs: 0, raw: 0, interp: 0, ws: [], young: 0, ubt: 0, flags: 0, official: 0 });
const flat = (b, p) => {
  const ws = b.ws.slice().sort((x, y) => x - y);
  return { [p + 'apps']: b.apps, [p + 'installs']: b.installs, [p + 'raw']: Math.round(b.raw),
    [p + 'interp']: r4(b.interp), [p + 'w']: b.apps ? ws[ws.length >> 1] : 0, [p + 'young']: b.young,
    [p + 'ubt']: b.ubt, [p + 'flags']: b.flags, [p + 'official']: b.official };
};
const parse = (s, def = null) => { try { return s == null ? def : JSON.parse(s); } catch { return def; } };

function geoQ(d, geo, date, metric, level) {
  const row = one(d, `SELECT ${level} v FROM niche_quantiles WHERE scope='geo' AND scope_id=? AND metric=? AND snapshot_date=?`, `${geo}:v2`, metric, date);
  return row ? row.v : null;
}

// Жалобы с цитатами, история изменений и справочные страницы («Сбор и планы»). Цитаты и события
// — по приложению, а не по строке гео: одно приложение встречается в десятке гео, данные одни.
const PAIN_LABELS = ['money', 'ads', 'broken', 'crash', 'missing', 'trust'];
const EVENT_KINDS = ['listing_changed', 'installs_spike', 'tracking_sdk_found', 'fraud_gate'];
function collectExtra(d, appRows, leaderIds) {
  const ids = [...new Set(appRows.map((a) => a.app_id).concat([...leaderIds]))];
  const domByApp = new Map(appRows.map((a) => [a.app_id, a.pain_dominant]));
  const ver = one(d, `SELECT classifier_version v FROM review_labels WHERE classifier_version LIKE 'regex%' ORDER BY rowid DESC LIMIT 1`)?.v || 'regex-v1.1';
  // Цитаты: низкие оценки с меткой жалобы, 25–220 символов, сначала — по доминирующей жалобе
  // приложения и с большим числом «полезно». Не больше трёх на приложение.
  const cand = new Map();
  for (const r of all(d,
    `SELECT rv.app_id, rv.text, rv.rating, rv.lang, rv.thumbs_up, l.label
       FROM raw_reviews rv JOIN review_labels l ON l.review_id=rv.review_id AND l.classifier_version=?
      WHERE rv.app_id IN (SELECT value FROM json_each(?)) AND rv.rating<=2
        AND l.label IN (${PAIN_LABELS.map(() => '?').join(',')})
        AND length(rv.text) BETWEEN 25 AND 220`, ver, JSON.stringify(ids), ...PAIN_LABELS)) {
    if (!cand.has(r.app_id)) cand.set(r.app_id, []);
    cand.get(r.app_id).push(r);
  }
  const quotes = {};
  for (const [id, list] of cand) {
    const dom = domByApp.get(id);
    const seen = new Set();
    // Порядок: доминирующая жалоба, затем английские (их читают все), затем по «полезно».
    quotes[id] = list.sort((a, b) => ((b.label === dom) - (a.label === dom)) || ((b.lang === 'en') - (a.lang === 'en')) || ((b.thumbs_up || 0) - (a.thumbs_up || 0)))
      .filter((r) => { const k = r.text.slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 3).map((r) => [r.label, r.rating, r.text.replace(/\s+/g, ' ').trim(), r.lang]);
  }
  // История: смены листинга, скачки установок, найденные трекеры, срабатывания антифрода.
  // Повторы одного вида с тем же текстом в разных гео и днях схлопываются в последний.
  const appEvents = {};
  const evSeen = new Set();
  for (const r of all(d,
    `SELECT app_id, snapshot_date, kind, detail, geo FROM events
      WHERE kind IN (${EVENT_KINDS.map(() => '?').join(',')}) AND app_id IN (SELECT value FROM json_each(?))
      ORDER BY id DESC`, ...EVENT_KINDS, JSON.stringify(ids))) {
    const key = r.app_id + '|' + r.kind + '|' + (r.kind === 'fraud_gate' ? '' : r.detail);
    if (evSeen.has(key)) continue;
    evSeen.add(key);
    const list = appEvents[r.app_id] || (appEvents[r.app_id] = []);
    if (list.length < 8) list.push([r.snapshot_date, r.kind, r.detail, r.geo]);
  }
  return { quotes, appEvents, ref: collectRef(d) };
}

function collectRef(d) {
  // Квантили-пороги v1 по гео — последняя дата каждого гео.
  const quantiles = all(d,
    `SELECT q.geo, q.metric, q.p01, q.p10, q.p25, q.p50, q.p75, q.p90, q.p95, q.p99, q.n, q.snapshot_date AS date
       FROM niche_quantiles q
       JOIN (SELECT scope_id, MAX(snapshot_date) md FROM niche_quantiles WHERE scope='geo' AND scope_id NOT LIKE '%:%' GROUP BY scope_id) l
         ON l.scope_id=q.scope_id AND l.md=q.snapshot_date
      WHERE q.scope='geo'`).map((r) => ({ ...r, p01: r4(r.p01), p10: r4(r.p10), p25: r4(r.p25), p50: r4(r.p50), p75: r4(r.p75), p90: r4(r.p90), p95: r4(r.p95), p99: r4(r.p99) }));
  // Реклама: итоги K7 (Google по домену и по имени) и Meta, проверки по дням.
  const ads = {
    google_status: all(d, `SELECT COALESCE(status,'нет ответа') status, COUNT(DISTINCT developer_domain) n FROM raw_ads_google WHERE developer_domain NOT LIKE 'dev:%' GROUP BY 1 ORDER BY n DESC`),
    google_ok: one(d, `SELECT COUNT(DISTINCT developer_domain) n FROM raw_ads_google WHERE status='ok' AND developer_domain NOT LIKE 'dev:%'`).n,
    google_ads: one(d, `SELECT COUNT(DISTINCT developer_domain) n FROM raw_ads_google WHERE creatives_found>0 AND developer_domain NOT LIKE 'dev:%'`).n,
    byname: all(d, `SELECT status, COUNT(*) n, SUM(creatives_found) ads FROM raw_ads_google WHERE developer_domain LIKE 'dev:%' GROUP BY 1 ORDER BY n DESC`),
    meta_checked: one(d, `SELECT COUNT(DISTINCT app_id) n FROM raw_ads_meta WHERE note LIKE 'meta-v2%'`).n,
    meta_found: one(d, `SELECT COUNT(DISTINCT app_id) n FROM raw_ads_meta WHERE found_by_package_id=1`).n,
    meta_errors: one(d, `SELECT COUNT(*) n FROM raw_ads_meta WHERE note LIKE 'ошибка%'`).n,
    tracking_scanned: one(d, `SELECT COUNT(DISTINCT app_id) n FROM raw_tracking_scan`).n,
    tracking_found: one(d, `SELECT COUNT(DISTINCT app_id) n FROM raw_tracking_scan WHERE found=1`).n,
    by_day: all(d, `SELECT substr(checked_at,1,10) date, COUNT(DISTINCT developer_domain) n, SUM(creatives_found>0) ads FROM raw_ads_google
                     WHERE checked_at >= date('now','-14 day') GROUP BY 1 ORDER BY 1`),
  };
  // Лента событий — последние 250 значимых.
  const feed = all(d,
    `SELECT e.snapshot_date date, e.geo, e.kind, e.detail, e.app_id, a.title FROM events e LEFT JOIN apps a ON a.app_id=e.app_id
      WHERE e.kind IN ('listing_changed','installs_spike','tracking_sdk_found','niche_door_above_p90','day_partial','k7_rate_limited','k7_captcha')
      ORDER BY e.id DESC LIMIT 250`);
  const apk = one(d, `SELECT COUNT(*) n FROM raw_apk`).n;
  const policy = one(d, `SELECT COUNT(*) n FROM organic_labels WHERE label IN ('policy_ok','policy_fail')`).n;
  const calOk = one(d, `SELECT COUNT(*) n FROM metrics_geo_calibration WHERE k_geo IS NOT NULL AND snapshot_date=(SELECT MAX(snapshot_date) FROM metrics_geo_calibration)`).n;
  const firstSnap = one(d, `SELECT MIN(snapshot_date) m FROM raw_app_page`).m;
  const ambiguous = one(d, `SELECT COUNT(*) n FROM raw_ads_google WHERE developer_domain LIKE 'dev:%' AND status='ambiguous'`).n;
  const gaps = [
    { name: 'Разбор APK', why: apk ? `разобрано ${apk} установочных файлов.` : 'не выполняется: установочные файлы пришлось бы скачивать со сторонних сайтов. Поэтому ступень «органика подтверждена» и проверка 3 недостижимы, а SDK атрибуции ищется только по тексту описания и политики.' },
    { name: 'policy_ok — ручной гейт E7', why: policy ? `размечено вручную: ${policy}.` : 'ручная метка «клон переживёт модерацию Play» не поставлена ни одному приложению: проверка 6 у всех «не проверена».' },
    { name: 'Прирост за 30 дней, курс «спрос → установки», ёмкость, проверка 3b', why: `нужно окно ≥ 14 дней в одном гео и 30 органиков для курса. История карточек — с ${firstSnap}; курс посчитан в ${calOk} гео из 30. До этого прирост — предварительный, по карточкам всех гео.` },
    { name: 'Всплески установок без обновления листинга', why: 'нужно 20 дневных точек за 30 дней в гео — копится.' },
    { name: 'Флаг «ниша закрыта», входы за 90 дней', why: 'нужно окно 90 дней истории выдачи.' },
    { name: 'Даты объявлений Meta', why: 'Meta Ad Library вне ЕС показывает только активные объявления без дат: история закупки в Meta — только «найдено когда-либо в наших проверках».' },
    { name: 'Google по имени разработчика', why: `у приложений с сайтом на бесплатном хостинге Google проверяется по имени; одноимённые рекламодатели (больше двух) дают «неоднозначно» — таких ${ambiguous}, в вердикт они не идут.` },
    { name: 'УБТ — ролики в соцсетях', why: 'признак УБТ считается только по упоминаниям в отзывах; сами ролики в TikTok, Shorts и Reels не собираются.' },
    { name: 'Выручка, конверсия, удержание', why: 'Play их не отдаёт: только ручной ввод в калькулятор окупаемости.' },
  ];
  return { quantiles, ads, feed, gaps };
}

export function collect(d) {
  clearQCache();
  const cfg = config();
  const V = cfg.scoring.v2;
  const ref = referenceGeo();
  const refConf = cfg.geos.geos.find((g) => g.geo === ref);
  const moneyOf = (g) => (g.ecpm_rel_us ?? 0) + (g.arpu_rel_us ?? 0);
  const money = Object.fromEntries(cfg.geos.geos.map((g) => [g.geo, moneyOf(refConf) ? moneyOf(g) / moneyOf(refConf) : null]));
  const mvals = Object.values(money);
  const mp10 = quantile(mvals, 0.1), mp90 = quantile(mvals, 0.9);
  const moneyN = Object.fromEntries(Object.entries(money).map(([g, v]) => [g, norm(v, mp10, mp90) ?? 0.5]));
  const pick = (score, geo) => (score == null ? null : score * (1 - V.money_weight + V.money_weight * moneyN[geo]));
  // Лучшее гео для рекомендуемого топа: процентиль у первых мест гео одинаковый (100), поэтому
  // при равенстве решает сырой рекомендуемый скор, как и везде — с поправкой на деньги гео.
  const recOrder = (x, y) => (pick(y.rec_pct, y.geo) - pick(x.rec_pct, x.geo)) || ((pick(y.rec_score, y.geo) ?? -1) - (pick(x.rec_score, x.geo) ?? -1));

  const geos = [], appRows = [], nicheRows = [], keyRows = [], funnel = [];
  const leaderIds = new Set();
  // Отчёт «Интерполяция — топ роста органик прил за 1 месяц»: одна строка на приложение по всем
  // гео и без отсечки строк отчёта — установки у приложения общие для Play. Прирост за окно
  // приводится к 30 дням (× 30 / окно); если есть официальная дельта (окно ≥ 14 дней) — берётся она.
  // Иконки: последняя известная ссылка по каждому приложению. Play отдаёт их в карточке,
  // хранятся ссылки, а не файлы. Пока обход не прошёл после 26.09, карта пустая — в отчёте
  // тогда рисуются буквы, как раньше.
  const iconOf = new Map(all(d,
    `SELECT app_id, icon FROM raw_app_page WHERE icon IS NOT NULL ORDER BY snapshot_date`
  ).map((r) => [r.app_id, r.icon]));

  const growthByApp = new Map();
  // Рост ниши — сумма прироста её органик-приложений. Своей истории у ниши нет: ядро
  // пересобирается каждый день, и стена установок топ-10 скачет на десятки процентов от
  // смены состава, а не от роста. По приложениям история честная, поэтому ниша считается
  // снизу вверх, из тех же строк, что и отчёт по приложениям.
  const nicheGrowthByKey = new Map();
  for (const g of cfg.geos.geos) {
    const date = one(d, `SELECT MAX(snapshot_date) m FROM metrics_app_v2 WHERE geo=?`, g.geo)?.m;
    const base = {
      geo: g.geo, tier: g.tier, currency: g.currency, is_reference: g.geo === ref ? 1 : 0,
      money_ratio: r4(money[g.geo]), money_n: r4(moneyN[g.geo]),
      snapshots: one(d, `SELECT COUNT(DISTINCT snapshot_date) c FROM raw_app_page WHERE geo=?`, g.geo).c,
      keywords_total: one(d, `SELECT COUNT(*) c FROM disc_keywords WHERE geo=?`, g.geo).c,
      discovered: one(d, `SELECT COUNT(*) c FROM disc_apps WHERE geo=?`, g.geo).c,
    };
    if (!date) { geos.push({ ...base, date: null }); continue; }

    // Строка приложения — последняя за report_carry_days: дневной проход обновляет не все
    // карточки, и без переноса приложение выпадало бы из отчёта в день, когда его не сняли.
    // Вердикт воронки — тоже последний: прошедшее раньше, но отсеянное сегодня не переносится.
    const carryFrom = new Date(Date.parse(date) - (V.report_carry_days ?? 7) * 864e5).toISOString().slice(0, 10);
    const niches = all(d, `SELECT * FROM metrics_niche_v2 WHERE geo=? AND snapshot_date=?`, g.geo, date);
    const nicheDate = niches[0]?.niche_date || date;
    const baseNiches = all(d, `SELECT niche_id, weak_share, index_gap_leader, wall_installs, wall_ratings, leader_share, new_share_18m, suggest_score_sum
                                 FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`, g.geo, nicheDate);
    const baseById = new Map(baseNiches.map((n) => [n.niche_id, n]));
    const calib = one(d, `SELECT * FROM metrics_geo_calibration WHERE geo=? AND snapshot_date=?`, g.geo, date) || {};
    const thresholds = {
      weakT: r4(quantile(baseNiches.map((n) => n.weak_share), 2 / 3)),
      gapT: r4(quantile(baseNiches.map((n) => n.index_gap_leader), 2 / 3)),
      updP90: r4(qv(null, g.geo, 'days_since_update', date, 'p90', { nicheFirst: false })),
      asoP25: r4(geoQ(d, g.geo, date, 'aso_share', 'p25')),
      purityP50: r4(geoQ(d, g.geo, date, 'organic_purity', 'p50')),
      purityP75: r4(geoQ(d, g.geo, date, 'organic_purity', 'p75')),
      fdsP75: r4(geoQ(d, g.geo, date, 'free_demand_share', 'p75')),
      freeKeysP75: r4(geoQ(d, g.geo, date, 'free_keys_count', 'p75')),
      doorKeyP25: r4(geoQ(d, g.geo, date, 'door_key', 'p25')),
      ubtP75: r4(geoQ(d, g.geo, date, 'ubt_share_mentioned', 'p75')),
      ubtNicheP75: r4(geoQ(d, g.geo, date, 'ubt_niche_share', 'p75')),
      // Антифрод (карточка приложения, «Достоверность роста»): те же пороги, что у fraud_gate.
      iprP01: r4(qv(null, g.geo, 'installs_per_rating', date, 'p01', { nicheFirst: false })),
      iprP99: r4(qv(null, g.geo, 'installs_per_rating', date, 'p99', { nicheFirst: false })),
      tmplP95: r4(qv(null, g.geo, 'template_review_pct', date, 'p95', { nicheFirst: false })),
    };

    for (const r of all(d,
      `SELECT v.app_id, v.niche_id, v.passed_funnel, v.organic_level, v.installs, v.installs_delta_30d, v.delta_window_days,
              v.delta_preview, v.delta_preview_raw, v.delta_preview_w, v.age_months, v.young, v.ubt_signal, v.ads_check_scope, v.organic_score, v.evidence_coverage,
              v.delta_flat, v.installs_est_ratings, v.ratings_delta_30d, v.ratings_delta_w,
              v.rate_lo_30d, v.rate_hi_30d, v.rate_intervals,
              m.fraud_ok, m.burst_flag, m.installs_per_rating, m.template_review_pct, a.title, a.developer,
              n.concept, n.freedom_pct, n.organic_purity, n.door, n.free_keys_count, n.closed_flag,
              COALESCE(n.quadrant_smooth, n.quadrant) AS quadrant,
              n.young_organic_count, n.time_to_organic
         FROM metrics_app_v2 v
         JOIN metrics_app_geo m ON m.app_id=v.app_id AND m.geo=v.geo AND m.snapshot_date=v.snapshot_date
         JOIN apps a ON a.app_id=v.app_id
         LEFT JOIN metrics_niche_v2 n ON n.niche_id=v.niche_id AND n.geo=v.geo AND n.snapshot_date=v.snapshot_date
        WHERE v.geo=? AND v.snapshot_date=? AND v.organic_level <> 'found'
          AND (v.installs_delta_30d IS NOT NULL OR v.delta_preview IS NOT NULL OR v.installs_est_ratings IS NOT NULL)`, g.geo, date)) {
      const official = r.installs_delta_30d != null;
      const w = official ? r.delta_window_days : r.delta_preview_w;
      if (!w) continue;
      // Счётчик установок стоял на месте: рост меньше ступени Play, измерением это не назвать.
      // Для таких строк остаётся косвенная скорость по числу оценок — она подписана отдельно.
      const measured = official || r.delta_preview != null;
      const flags = (r.fraud_ok === 0 ? 1 : 0) + (r.burst_flag === 1 ? 1 : 0)
        + (r.installs_per_rating != null && ((thresholds.iprP01 != null && r.installs_per_rating < thresholds.iprP01) || (thresholds.iprP99 != null && r.installs_per_rating > thresholds.iprP99)) ? 1 : 0)
        + (r.template_review_pct != null && thresholds.tmplP95 != null && r.template_review_pct > thresholds.tmplP95 ? 1 : 0);
      // «Легко зайти в топ-10 на органике»: в нише уже есть молодые органики (кто-то вошёл без
      // закупки), есть свободные ключи, свобода от 50, чистота не ниже медианы гео, ниша открыта
      // и не в квадранте «Мимо». Это свойство ниши, а не самого приложения.
      const easy = r.young_organic_count >= 1 && r.free_keys_count >= 1 && r.freedom_pct != null && r.freedom_pct >= 50
        && r.organic_purity != null && thresholds.purityP50 != null && r.organic_purity >= thresholds.purityP50
        && !r.closed_flag && r.quadrant !== 'pass' ? 1 : 0;
      // «Топ-5» — та же проверка, но строже: пятое место дороже десятого, поэтому нужна
      // повторяемость входа (молодых органиков от двух, а не один случай), запас свободных
      // ключей, чистота не ниже p75 гео и квадрант «Цель», а не просто «не Мимо».
      const easy5 = easy && r.young_organic_count >= 2 && r.free_keys_count >= 2
        && r.freedom_pct >= 65 && thresholds.purityP75 != null && r.organic_purity >= thresholds.purityP75
        && r.quadrant === 'target' ? 1 : 0;
      // Цифры ниши идут отдельным блоком: строка приложения в отчёте одна на все гео, а ниша в
      // каждом гео своя. Если вход лёгкий хоть где-то, показываются цифры именно того гео —
      // иначе в строке стояла бы метка «лёгкий вход» рядом с числами другого гео.
      const niche = { n_geo: g.geo, n_freedom: r4(r.freedom_pct), n_purity: r4(r.organic_purity),
        n_free_keys: r.free_keys_count, n_quad: r.quadrant,
        // Спрос и обе двери — из того же гео, что и остальные цифры ниши в этой строке.
        n_dem: r4(r.demand_ext), n_dem_cov: r4(r.demand_cov), n_dem_est: r.demand_est ?? 0,
        n_door: r.door, n_door5: r.door5 };
      const row = { app_id: r.app_id, title: r.title, dev: r.developer, concept: r.concept, geo: g.geo, installs: r.installs,
        official: official ? 1 : 0, w, interp: measured ? r4(official ? r.installs_delta_30d : r.delta_preview) : null,
        flat: r.delta_flat === 1 ? 1 : 0, rest: r4(r.installs_est_ratings), rw: r.ratings_delta_w,
        lo: r4(r.rate_lo_30d), hi: r4(r.rate_hi_30d), ivals: r.rate_intervals,
        rrate: r4(r.ratings_delta_30d),
        raw: official ? Math.round((r.installs_delta_30d * w) / 30) : r.delta_preview_raw,
        age: r4(r.age_months), young: r.young, level: r.organic_level, scope: r.ads_check_scope,
        oscore: r4(r.organic_score), ocov: r4(r.evidence_coverage),
        passed: r.passed_funnel ? 1 : 0, ubt: r.ubt_signal === 1 ? 1 : 0, flags };
      if (r.niche_id) {
        const key = g.geo + '|' + r.niche_id;
        let ag = nicheGrowthByKey.get(key);
        if (!ag) { ag = { geo: g.geo, niche_id: r.niche_id, easy, easy5, a: bucket(), p: bucket() }; nicheGrowthByKey.set(key, ag); }
        // Две суммы: по всей органике и только по прошедшим воронку. Без второй верх отчёта
        // занимают ниши, куда затесался гигант: один такой прибавляет сотни миллионов
        // установок в каждом гео, и ниша выглядит растущей, хотя повторить это нечего.
        const add = (b) => {
          b.apps++; b.installs += r.installs || 0; b.raw += row.raw || 0; b.interp += (row.interp != null ? row.interp : (row.rest || 0));
          b.ws.push(w);
          if (r.young) b.young++;
          if (row.ubt) b.ubt++;
          if (row.flags) b.flags++;
          if (official) b.official++;
        };
        add(ag.a);
        if (row.passed) add(ag.p);
      }
      const cur = growthByApp.get(r.app_id);
      if (!cur) { growthByApp.set(r.app_id, { ...row, ...niche, easy, easy5, geos: [g.geo] }); continue; }
      cur.geos.push(g.geo);
      cur.passed = cur.passed || row.passed; cur.ubt = cur.ubt || row.ubt; cur.flags = Math.max(cur.flags, row.flags);
      // Лучшая строка роста: сперва измеренная (счётчик за окно сдвинулся), затем
      // официальная дельта методики, затем окно длиннее. Цифры роста и цифры ниши
      // выбираются независимо: рост — по качеству замера, ниша — по лёгкости входа.
      const rank = (x) => (x.interp != null ? 4 : 0) + (x.official ? 2 : 0);
      if (rank(row) > rank(cur) || (rank(row) === rank(cur) && row.w > cur.w)) Object.assign(cur, row);
      // Цифры ниши идут из самого сильного гео: сперва то, где вход в топ-5, затем в топ-10.
      if (easy5 && !cur.easy5) { cur.easy5 = 1; cur.easy = 1; Object.assign(cur, niche); }
      else if (easy && !cur.easy) { cur.easy = 1; Object.assign(cur, niche); }
      else if (!cur.easy && r.freedom_pct != null && cur.n_freedom == null) Object.assign(cur, niche);
    }

    // Объём спроса по ключам этого гео: в карточке приложения рядом с позицией по ключу
    // теперь видно, сколько этот ключ вообще приносит показов.
    const extKw = new Map(all(d,
      `SELECT keyword, ext_impressions imp, ext_difficulty dif, ext_navigational nav
         FROM metrics_keyword_geo WHERE geo=? AND snapshot_date=? AND ext_impressions IS NOT NULL`,
      g.geo, date).map((r) => [r.keyword, r]));

    const apps = all(d,
      `SELECT v.*, m.prescore, m.score, m.ratings_count, m.monetization_type, m.iap_min_usd, m.iap_max_usd, m.contains_ads,
              m.demand, m.src_ads_pct, m.feasibility, m.monetization_proof, m.policy_ok, m.policy_auto_ok, m.fraud_ok,
              m.days_since_update, m.installs_per_month_lifetime, m.pain_dominant, m.pain_money, m.pain_ads, m.pain_broken,
              m.kw_top10_count, m.kw_top50_count,
              m.installs_per_rating, m.burst_flag, m.template_review_pct, m.review_lang_mismatch, m.polarization,
              m.rating_recent_30d, m.crash_pct,
              a.title, a.developer, a.genre_id, a.first_seen,
              n.concept, n.head_keyword AS niche_head, n.freedom_pct AS niche_freedom, n.quadrant AS niche_quadrant,
              n.door AS niche_door, n.organic_capacity AS niche_capacity, n.ubt_flag AS niche_ubt_flag,
              n.door5 AS niche_door5, n.demand_ext AS niche_dem, n.demand_cov AS niche_dem_cov, n.demand_est AS niche_dem_est
         FROM metrics_app_v2 v
         JOIN metrics_app_geo m ON m.app_id=v.app_id AND m.geo=v.geo AND m.snapshot_date=v.snapshot_date
         JOIN apps a ON a.app_id=v.app_id
         LEFT JOIN metrics_niche_v2 n ON n.niche_id=v.niche_id AND n.geo=v.geo AND n.snapshot_date=v.snapshot_date
        WHERE v.geo=? AND v.passed_funnel=1
          AND v.snapshot_date=(SELECT MAX(x.snapshot_date) FROM metrics_app_v2 x
                                WHERE x.app_id=v.app_id AND x.geo=v.geo AND x.snapshot_date<=? AND x.snapshot_date>=?)
        ORDER BY m.prescore DESC`, g.geo, date, carryFrom);
    // Перенесённые строки получили вердикт воронки в свой день — возможно, по прежнему порогу
    // «слишком крупного» (p95 до 18.09). Порог дня гео применяется к ним заново.
    const bigQ = config().scoring.funnel?.too_big_quantile || 'p75';
    const bigInst = qv(null, g.geo, 'installs', date, bigQ, { nicheFirst: false });
    if (bigInst != null) {
      const fresh = apps.filter((a) => a.snapshot_date === date || a.installs == null || a.installs <= bigInst);
      apps.length = 0;
      apps.push(...fresh);
    }
    // В отчёт идут сильнейшие строки гео: страница ограничена 16 МБ, а хвост по индексу
    // копируемости в решении не участвует. Сколько отброшено — видно на странице «Сбор и планы».
    // Рекомендуемые (первые top_n × 3 по рекомендуемому скору) остаются в отчёте, даже если по
    // индексу копируемости они ниже отсечки: рекомендуемый топ считается по всем строкам гео.
    const cap = process.env.RADAR_REPORT_FULL ? Infinity : (V.report_apps_per_geo || 500);
    const recKeep = new Set(apps.filter((a) => a.rec_pct != null).sort((x, y) => y.rec_pct - x.rec_pct)
      .slice(0, (V.recommended?.top_n || 50) * 3).map((a) => a.app_id));
    const kept = apps.filter((a, i) => i < cap || recKeep.has(a.app_id));
    const trimmed = apps.length - kept.length;
    apps.length = 0;
    apps.push(...kept);

    for (const a of apps) {
      appRows.push({
        geo: g.geo, app_id: a.app_id, title: a.title, developer: a.developer, genre_id: a.genre_id,
        niche_id: a.niche_id, concept: a.concept, niche_head: a.niche_head, niche_freedom: r4(a.niche_freedom),
        first_seen: a.first_seen, icon: iconOf.get(a.app_id) || null,
        niche_quadrant: a.niche_quadrant, niche_door: a.niche_door, niche_capacity: r4(a.niche_capacity),
        // Спрос и дверь в топ-5 берутся у ниши приложения: в списке приложений видно не
        // только само приложение, но и рынок, на котором оно стоит.
        niche_door5: a.niche_door5, niche_dem: r4(a.niche_dem), niche_dem_cov: r4(a.niche_dem_cov), niche_dem_est: a.niche_dem_est ?? 0,
        prescore: r4(a.prescore), installs: a.installs, score: r4(a.score), ratings_count: a.ratings_count,
        age_months: r4(a.age_months), released: a.released, young: a.young,
        delta30: r4(a.installs_delta_30d), delta_w: a.delta_window_days, delta_partial: a.delta_partial,
        dp: r4(a.delta_preview), dp_raw: a.delta_preview_raw, dp_w: a.delta_preview_w, dp_from: a.delta_preview_from,
        row_date: a.snapshot_date,
        level: a.organic_level, ads_scope: a.ads_check_scope, evidence_date: a.evidence_date, evidence_age: a.evidence_age_days, ads_found: a.ads_found,
        g_checked: a.ads_google_checked, g_host: a.ads_google_host, g_creatives: a.ads_google_creatives,
        g_first: a.ads_google_first_seen, g_last: a.ads_google_last_seen, g_active: a.ads_google_active,
        m_checked: a.ads_meta_checked, tracking: a.tracking_names, apk: a.apk_parsed, attribution_sdk: a.attribution_sdk,
        weight: r4(a.search_weight), explained: r4(a.explained), aso_share: r4(a.aso_share), traffic: a.traffic_source,
        spike: r4(a.exogenous_spike_rate),
        checks: parse(a.checks, []), passed: a.passed, failed: a.failed, disq: parse(a.disq, []),
        monetization_type: a.monetization_type, iap_min_usd: r4(a.iap_min_usd), iap_max_usd: r4(a.iap_max_usd), contains_ads: a.contains_ads,
        demand: r4(a.demand), src_ads_pct: r4(a.src_ads_pct), p95src: r4(qv(a.niche_id, g.geo, 'src_ads_pct', date, 'p95')),
        feasibility: r4(a.feasibility), monetization_proof: a.monetization_proof, policy_ok: a.policy_ok, policy_auto_ok: a.policy_auto_ok,
        fraud_ok: a.fraud_ok, days_since_update: r4(a.days_since_update), ipm: r4(a.installs_per_month_lifetime),
        pain_dominant: a.pain_dominant, pain_money: r4(a.pain_money), pain_ads: r4(a.pain_ads), pain_broken: r4(a.pain_broken),
        kw_top10: a.kw_top10_count, kw_top50: a.kw_top50_count,
        kw: parse(a.keywords_json, []).slice(0, 8).map((k) => {
          const e = extKw.get(k.kw);
          return [k.kw, k.pos, r4(k.contrib), e?.imp ?? null, e?.dif ?? null, e?.nav ?? 0];
        }),
        niche_weak: r4(baseById.get(a.niche_id)?.weak_share ?? null), niche_gap: r4(baseById.get(a.niche_id)?.index_gap_leader ?? null),
        ubt: a.ubt_signal, ubt_mentions: a.ubt_mentions, ubt_reviews: a.ubt_reviews, ubt_share: r4(a.ubt_share), ubt_related: a.ubt_related,
        rec_pct: r4(a.rec_pct), rec_score: r4(a.rec_score), rec_parts: parse(a.rec_parts),
        niche_ubt: a.niche_ubt_flag ?? null,
        ipr: r4(a.installs_per_rating), burst: a.burst_flag, tmpl: r4(a.template_review_pct), lang_mis: r4(a.review_lang_mismatch),
        polar: r4(a.polarization), rating30: r4(a.rating_recent_30d), crash: r4(a.crash_pct),
      });
    }

    const painOf = d.prepare(`SELECT pain_dominant, pain_money, pain_ads, pain_broken FROM metrics_app_geo
                                WHERE app_id=? AND geo=? AND snapshot_date<=? ORDER BY snapshot_date DESC LIMIT 1`);
    for (const n of niches) {
      const top = parse(n.head_top10, []);
      // Лидеры — первые три места головного ключа: на что жалуются их пользователи (карточка ниши).
      const leaders = top.slice().sort((x, y) => x.pos - y.pos).slice(0, 3).map((x) => {
        const p = painOf.get(x.app_id, g.geo, date) || {};
        leaderIds.add(x.app_id);
        return [x.app_id, x.title, x.pos, p.pain_dominant ?? null, r4(p.pain_money ?? null), r4(p.pain_ads ?? null), r4(p.pain_broken ?? null), x.level];
      });
      const b = baseById.get(n.niche_id) || {};
      nicheRows.push({
        geo: g.geo, niche_id: n.niche_id, concept: n.concept, head: n.head_keyword, keywords_count: n.keywords_count,
        door: n.door, door_flow: n.door_flow, door_head: n.door_head, door_tail: n.door_tail, door_velocity: r4(n.door_velocity), wall: n.wall_installs,
        door5: n.door5, door_flow5: n.door_flow5,
        free_keys: n.free_keys_count, fds: r4(n.free_demand_share), demand_per_app: r4(n.demand_per_app),
        // Внешний спрос: показов в день по ядровым ключам, без навигационных. dem_est=1 —
        // это оценка по США, а не замер страны; в отчёте такие числа подписаны отдельно.
        dem: r4(n.demand_ext), dem_nav: r4(n.demand_nav), dem_cov: r4(n.demand_cov),
        dif: r4(n.difficulty_ext), dem_est: n.demand_est ?? 0, dem_src: n.demand_src ?? null,
        dem_tr: r4(n.demand_trend), dem_tr_keys: n.demand_trend_keys ?? null, dem_tr_days: n.demand_trend_days ?? null,
        aso_saturation: r4(n.aso_saturation), relevance_gap: r4(n.relevance_gap_pct),
        entry_rate: n.entry_rate_90d, last_entry_days: n.last_entry_days, history_days: n.history_days,
        time_to_door: r4(n.time_to_door_median), turnover_up_new: r4(n.turnover_up_new), turnover_w: n.turnover_window_days,
        hhi: r4(n.hhi_top10), clone_density: r4(n.clone_density),
        components: parse(n.freedom_components, []).map((c) => [c.name, r4(c.raw), r4(c.n), r4(c.w), r4(c.contrib)]), freedom_raw: r4(n.freedom_raw), freedom: r4(n.freedom_pct), closed: n.closed_flag,
        capacity: r4(n.organic_capacity), capacity_lo: r4(n.organic_capacity_lo), capacity_hi: r4(n.organic_capacity_hi),
        money_ratio: r4(n.money_ratio), money_capacity: r4(n.money_capacity),
        purity: r4(n.organic_purity), purity_cov: r4(n.purity_coverage), top10_ads_share: r4(n.top10_ads_share),
        young: n.young_organic_count, young_installs: n.young_organic_installs,
        young_apps: parse(n.young_organic_apps, []).slice(0, 12).map((y) => [y.app_id, y.title, r4(y.age), y.installs, y.level]),
        tto: r4(n.time_to_organic), tto_kind: n.time_to_organic_kind,
        cand: n.candidates_count, cand_organic: n.candidates_organic_count, cand_paid: n.candidates_paid_count,
        monetized: r4(n.monetized_share), pain: parse(n.leaders_pain), leaders,
        top10: top.map((x) => [x.pos, x.app_id, x.title, x.installs, x.age, x.level, x.young, x.passed]),
        rank: r4(n.niche_rank), rank_basis: n.rank_basis, rank_pct: r4(n.rank_pct),
        quadrant: n.quadrant_smooth || n.quadrant, quad_today: n.quadrant, quad_days: n.quadrant_days, quad_seen: n.quadrant_seen,
        freedom_margin: r4(n.freedom_margin), purity_margin: r4(n.purity_margin), tail_clean: n.tail_clean,
        incomplete: parse(n.incomplete, []), partial: n.partial_window,
        leader_share: r4(b.leader_share ?? null), new_share_18m: r4(b.new_share_18m ?? null), weak_share: r4(b.weak_share ?? null),
        index_gap_leader: r4(b.index_gap_leader ?? null),
        ubt_share: r4(n.ubt_share), ubt_apps: n.ubt_apps, ubt: n.ubt_flag,
        rec_pct: r4(n.rec_pct), rec_score: r4(n.rec_score), rec_parts: parse(n.rec_parts),
      });
    }
    for (const k of all(d, `SELECT niche_id, keyword, is_head, suggest_score, door_key, is_free, paid_ctr_share, ads_checked_share, top10_cards
                              FROM metrics_keyword_geo WHERE geo=? AND snapshot_date=?`, g.geo, date)) {
      keyRows.push({ geo: g.geo, niche_id: k.niche_id, keyword: k.keyword, head: k.is_head, sug: r4(k.suggest_score), door_key: k.door_key,
        free: k.is_free, paid: r4(k.paid_ctr_share), checked: r4(k.ads_checked_share), cards: k.top10_cards });
    }

    const allV2 = all(d, `SELECT organic_level, evidence_age_days, age_months FROM metrics_app_v2 WHERE geo=? AND snapshot_date=?`, g.geo, date);
    const screenDate = one(d, `SELECT MAX(snapshot_date) m FROM screen_result WHERE geo=? AND snapshot_date<=?`, g.geo, date)?.m;
    if (screenDate) for (const r of all(d, `SELECT COALESCE(reject_reason,'passed') reason, COUNT(*) n FROM screen_result WHERE geo=? AND snapshot_date=? GROUP BY 1`, g.geo, screenDate)) {
      funnel.push({ geo: g.geo, date: screenDate, reason: r.reason, n: r.n });
    }
    const doors = niches.map((n) => n.door).filter((v) => v != null).sort((a, b) => a - b);
    const share = (arr, f) => (arr.length ? r4(arr.filter(f).length / arr.length) : null);
    geos.push({
      ...base, date, niche_date: nicheDate, ...thresholds,
      k_geo: r4(calib.k_geo ?? null), k_status: calib.status ?? null, k_window: calib.window_days ?? 0, k_obs: calib.n_obs ?? 0,
      niches: niches.length, apps: apps.length, apps_trimmed: trimmed,
      door_median: doors.length ? doors[Math.floor(doors.length / 2)] : null,
      cards_day: one(d, `SELECT COUNT(DISTINCT app_id) c FROM raw_app_page WHERE geo=? AND snapshot_date=?`, g.geo, date).c,
      core_keys: one(d, `SELECT COUNT(*) c FROM keyword_cores WHERE geo=? AND active=1`, g.geo).c,
      history_days: niches.reduce((m, n) => Math.max(m, n.history_days || 0), 0),
      age_cov: share(allV2, (a) => a.age_months != null),
      ads_cov: share(apps, (a) => ['found', 'confirmed', 'no_signs'].includes(a.organic_level)),
      door_cov: share(niches, (n) => n.door != null),
      freedom_cov: share(niches, (n) => n.freedom_pct != null),
      purity_cov: share(niches, (n) => n.organic_purity != null),
      expiring7: allV2.filter((a) => ['no_signs', 'confirmed'].includes(a.organic_level) && a.evidence_age_days != null && a.evidence_age_days > V.evidence_ttl_days - 7).length,
      stale: allV2.filter((a) => a.organic_level === 'stale').length,
    });
  }

  // ---------- ворлдвайд: приложения ----------
  const byApp = new Map();
  for (const a of appRows) {
    if (!byApp.has(a.app_id)) byApp.set(a.app_id, []);
    byApp.get(a.app_id).push(a);
  }
  const worldApps = [];
  for (const [id, rows] of byApp) {
    let best = null, bestScore = -Infinity;
    for (const r of rows) {
      const s = pick(r.prescore, r.geo) ?? -1;
      if (s > bestScore || (s === bestScore && r.geo === ref)) { best = r; bestScore = s; }
    }
    const us = rows.find((r) => r.geo === ref);
    // Для рекомендуемого топа — гео, где рекомендуемый скор выше (он может не совпадать с лучшим по индексу).
    const recBest = rows.filter((r) => r.rec_pct != null).sort(recOrder)[0] || null;
    worldApps.push({ app_id: id, geo: best.geo, geos: rows.map((r) => r.geo).sort().join(','), geos_count: rows.length,
      us_prescore: us ? us.prescore : null, rec_geo: recBest ? recBest.geo : null, rec_pct: recBest ? recBest.rec_pct : null,
      rec_geos: rows.filter((r) => r.rec_pct != null && r.rec_pct >= 90).length,
      ubt_any: rows.some((r) => r.ubt === 1) ? 1 : 0 });
  }

  // ---------- ворлдвайд: ниши по концепту ----------
  const byConcept = new Map();
  for (const n of nicheRows) {
    if (!n.concept) continue;
    if (!byConcept.has(n.concept)) byConcept.set(n.concept, new Map());
    const perGeo = byConcept.get(n.concept);
    const cur = perGeo.get(n.geo);
    if (!cur || (n.rank ?? -1) > (cur.rank ?? -1)) perGeo.set(n.geo, n);
  }
  const worldNiches = [];
  for (const [concept, perGeo] of byConcept) {
    const rows = [...perGeo.values()];
    let best = null, bestScore = -Infinity;
    for (const r of rows) {
      const s = pick(r.rank_pct, r.geo) ?? -1;
      if (s > bestScore || (s === bestScore && r.geo === ref)) { best = r; bestScore = s; }
    }
    const cheapest = rows.filter((r) => r.door != null).sort((a, b) => a.door - b.door)[0] || null;
    const young = new Set();
    for (const r of rows) for (const y of r.young_apps) young.add(y.app_id);
    const us = perGeo.get(ref) || null;
    worldNiches.push({
      concept, geo: best.geo, niche_id: best.niche_id, geos_count: rows.length,
      target_geos: rows.filter((r) => r.quadrant === 'target').length,
      // Спрос темы показывается по США, где он измерен, а не суммируется по странам:
      // в остальных гео это была бы сумма оценок, выданная за измерение.
      dem: us ? us.dem : null, dif: us ? us.dif : null, dem_cov: us ? us.dem_cov : null, dem_est: us ? us.dem_est : 0,
      dem_tr: us ? us.dem_tr : null, dem_tr_days: us ? us.dem_tr_days : null,
      cheapest_geo: cheapest ? cheapest.geo : null, cheapest_door: cheapest ? cheapest.door : null,
      cheapest_door5: cheapest ? cheapest.door5 : null,
      young_unique: young.size, us_niche_id: us ? us.niche_id : null,
      rec_geo: (rows.filter((r) => r.rec_pct != null).sort(recOrder)[0] || {}).geo || null,
      rec_niche_id: (rows.filter((r) => r.rec_pct != null).sort(recOrder)[0] || {}).niche_id || null,
      rec_geos: rows.filter((r) => r.rec_pct != null && r.rec_pct >= 90).length,
      ubt_geos: rows.filter((r) => r.ubt === 1).length,
    });
  }

  // Ниши без темы. Ворлдвайд группирует по теме, и ниша, которой тему не присвоили, не
  // попадала туда вовсе: в США таких девять из 81, по всем гео — 145. Между тем это
  // полноценные ниши со своими дверью, свободой и чистотой, просто собранные из ключей,
  // которые не подтвердили ни одну тему каталога («find my phone», «handwriting practice»).
  // Склеить их между странами не по чему — темы нет, — поэтому каждая идёт своей строкой
  // с пометкой, что она из одного гео.
  for (const n of nicheRows) {
    if (n.concept) continue;
    worldNiches.push({
      concept: null, geo: n.geo, niche_id: n.niche_id, geos_count: 1, no_concept: 1,
      dem: n.dem, dif: n.dif, dem_cov: n.dem_cov, dem_est: n.dem_est, dem_tr: n.dem_tr, dem_tr_days: n.dem_tr_days,
      cheapest_door5: n.door5,
      target_geos: n.quadrant === 'target' ? 1 : 0,
      cheapest_geo: n.door != null ? n.geo : null, cheapest_door: n.door ?? null,
      young_unique: (n.young_apps || []).length, us_niche_id: n.geo === ref ? n.niche_id : null,
      rec_geo: n.rec_pct != null ? n.geo : null, rec_niche_id: n.rec_pct != null ? n.niche_id : null,
      rec_geos: n.rec_pct != null && n.rec_pct >= 90 ? 1 : 0,
      ubt_geos: n.ubt === 1 ? 1 : 0,
    });
  }

  const timeline = all(d, `SELECT snapshot_date AS date, geo, COUNT(DISTINCT app_id) AS cards FROM raw_app_page GROUP BY snapshot_date, geo ORDER BY snapshot_date`);
  const extra = collectExtra(d, appRows, leaderIds);
  const lastDate = geos.map((g) => g.date).filter(Boolean).sort().pop() || null;

  return {
    meta: {
      generated_at: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      date: lastDate, reference_geo: ref,
      db_size_mb: fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size / 1048576) : 0,
      ttl: V.evidence_ttl_days, young_months: V.young_months, min_window: V.min_window_days, full_window: V.full_window_days, carry_days: V.report_carry_days ?? 7,
      entry_window: V.entry_window_days, calib_min: V.calibration_min_obs, money_weight: V.money_weight, purity_min: V.purity_min_checked_share,
      ubt_min_mentions: V.ubt_min_mentions, ubt_min_reviews: V.ubt_min_reviews, ubt_niche_min_apps: V.ubt_niche_min_apps,
      rec: V.recommended,
    },
    geos, apps: appRows, niches: nicheRows, keys: keyRows, worldApps, worldNiches, timeline, funnel,
    growth: [...growthByApp.values()].map((r) => ({ ...r, geos: r.geos.sort().join(','), geos_count: r.geos.length })),
    nicheGrowth: [...nicheGrowthByKey.values()].map((n) => ({
      geo: n.geo, niche_id: n.niche_id, easy: n.easy, easy5: n.easy5, ...flat(n.a, ''), ...flat(n.p, 'p_'),
    })),
    quotes: extra.quotes, appEvents: extra.appEvents, ref: extra.ref,
    collection: collectCollection(d, lastDate),
  };
}

export async function run() {
  const d = db();
  const data = collect(d);
  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'report', 'appradar2.html'), 'utf8');
  const json = JSON.stringify(packRows(data)).replace(/</g, '\\u003c');
  const fragment = tpl.replace('__RADAR_DATA__', () => json).replace('__UNPACK_JS__', () => UNPACK_JS);
  // RADAR_REPORT_FULL=1 — полная версия без отсечки строк, в out/full: для просмотра локально
  // (http://localhost:8777/full/…), в артефакт такой файл не помещается.
  const outDir = path.join(ROOT, 'out', process.env.RADAR_REPORT_FULL ? 'full' : '');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'appradar2-artifact.html'), fragment, 'utf8');
  fs.writeFileSync(path.join(outDir, 'appradar2.html'), `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0">
${fragment}
</body>
</html>`, 'utf8');
  log(`  AppRadar 2: out/appradar2.html (${(fragment.length / 1048576).toFixed(1)} МБ), гео ${data.geos.filter((g) => g.date).length}, ` +
      `строк приложений ${data.apps.length}, уникальных ${data.worldApps.length}, ниш ${data.niches.length}, концептов ${data.worldNiches.length}`);
  return { apps: data.apps.length };
}
