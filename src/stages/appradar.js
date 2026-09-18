// Третий отчёт — «AppRadar»: те же данные радара в оформлении дизайна из архива пользователя
// (тёмное меню слева, светлое поле с карточками, топ на копирование, раздел отчётов).
//
// Выборка приложений не дублируется: берётся collect() отчёта по методике — те же шесть
// проверок, те же даты гео, то же соединение с воронкой. Здесь добавляется только то, чего
// там нет, но что просят разделы дизайна: категории Play, ядро ключей, конкуренты ниши
// по выдаче, статистика рекламных библиотек и ход сбора по дням.
//
// Чего в дизайне было, а здесь нет — выручки (Play её не отдаёт) и кривых динамики (истории
// меньше недели). Колонки роста остаются пустыми, а не заполняются правдоподобными числами.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from '../lib/db.js';
import { config } from '../lib/config.js';
import { log } from '../lib/util.js';
import { packRows, UNPACK_JS } from '../lib/pack.js';
import { collect as collectMethodology } from './methodology-report.js';
import { META_DETECTOR } from './check-ads.js';
import { collectCollection } from './dashboard.js';

const one = (d, sql, ...p) => d.prepare(sql).get(...p);
const all = (d, sql, ...p) => d.prepare(sql).all(...p);

// Поля строки приложения, которые реально рисует отчёт. Отчёт по методике несёт ~70 полей
// на строку; здесь меньше половины — вес страницы примерно вдвое ниже.
const APP_FIELDS = [
  'app_id', 'title', 'developer', 'watch_level', 'niche_id', 'niche_head', 'niche_door',
  'prescore', 'checks', 'passed', 'failed', 'unknown',
  'installs', 'score', 'ratings_count', 'age_months', 'days_since_update',
  'demand', 'weakness', 'feasibility', 'organic', 'index_gap', 'kw_top10_count', 'kw_top50_count',
  'monetization_type', 'iap_min_usd', 'iap_max_usd', 'contains_ads',
  'ads_found', 'attribution_sdk', 'tracking_matched', 'verification_level', 'policy_auto_ok', 'fraud_ok',
  'pain_dominant', 'pain_fit', 'pain_money', 'pain_ads', 'pain_broken',
  'rating_recent_30d', 'crash_pct', 'polarization', 'localized_geo_count',
];

function pick(row, fields) {
  const out = {};
  for (const f of fields) out[f] = row[f] ?? null;
  return out;
}

function collectExtras(d, geo, date, nicheHeads) {
  // Категория и рост — из карточки и метрик того же дня, что и строка приложения.
  const extra = new Map(all(d,
    `SELECT m.app_id, p.genre_id, m.installs_growth_1d, m.installs_growth_7d, m.installs_growth_30d
       FROM metrics_app_geo m
       LEFT JOIN raw_app_page p ON p.app_id=m.app_id AND p.geo=m.geo AND p.snapshot_date=m.snapshot_date
      WHERE m.geo=? AND m.snapshot_date=?
      GROUP BY m.app_id`, geo, date).map((r) => [r.app_id, r]));

  const keywords = all(d,
    `SELECT k.keyword, k.source, k.suggest_score, k.suggest_depth, k.depth, k.is_brand, k.concept,
            (SELECT COUNT(*) FROM disc_app_keyword ak WHERE ak.geo=k.geo AND ak.keyword=k.keyword) AS apps
       FROM disc_keywords k
      WHERE k.geo=? AND k.dead=0
      ORDER BY k.suggest_score DESC, apps DESC LIMIT 250`, geo);

  // Конкуренты ниши — верх выдачи по её головному ключу в последнем снятом срезе.
  const competitors = nicheHeads.length ? all(d,
    `SELECT r.keyword, r.position, r.app_id, a.title, a.developer, a.watch_level,
            p.max_installs AS installs, p.score, p.genre_id
       FROM raw_search r
       JOIN (SELECT keyword, MAX(snapshot_date) md FROM raw_search WHERE geo=? GROUP BY keyword) f
         ON f.keyword=r.keyword AND f.md=r.snapshot_date
       JOIN apps a ON a.app_id=r.app_id
       LEFT JOIN raw_app_page p ON p.app_id=r.app_id AND p.geo=r.geo
            AND p.snapshot_date=(SELECT MAX(p2.snapshot_date) FROM raw_app_page p2 WHERE p2.app_id=r.app_id AND p2.geo=r.geo)
      WHERE r.geo=? AND r.position<=10 AND r.keyword IN (SELECT value FROM json_each(?))
      GROUP BY r.keyword, r.position
      ORDER BY r.keyword, r.position`, geo, geo, JSON.stringify(nicheHeads)) : [];

  return { extra, keywords, competitors };
}

export function collect(d, selectedGeo, date) {
  const base = collectMethodology(d, selectedGeo, date);
  const cfg = config();

  const geoData = {};
  for (const [geo, gd] of Object.entries(base.geoData)) {
    const heads = [...new Set(gd.niches.map((n) => n.head_keyword).filter(Boolean))];
    const { extra, keywords, competitors } = collectExtras(d, geo, gd.date, heads);
    geoData[geo] = {
      date: gd.date,
      apps: gd.apps.map((a) => {
        const x = extra.get(a.app_id) || {};
        return {
          ...pick(a, APP_FIELDS),
          genre_id: x.genre_id ?? null,
          growth_1d: x.installs_growth_1d ?? null,
          growth_7d: x.installs_growth_7d ?? null,
          growth_30d: x.installs_growth_30d ?? null,
        };
      }),
      niches: gd.niches,
      funnel: gd.funnel,
      keywords,
      competitors,
    };
  }

  // Рекламные библиотеки. Отрицательный результат Meta считается только от актуального
  // детектора — ровно так же, как в score, иначе отчёт и метрики разошлись бы.
  const google = {
    by_status: all(d, `SELECT COALESCE(status,'нет ответа') AS status, COUNT(*) AS count
                         FROM raw_ads_google GROUP BY status ORDER BY count DESC`),
    domains: one(d, `SELECT COUNT(DISTINCT developer_domain) c FROM raw_ads_google`).c,
    domains_ok: one(d, `SELECT COUNT(DISTINCT developer_domain) c FROM raw_ads_google WHERE status='ok'`).c,
    domains_with_ads: one(d, `SELECT COUNT(DISTINCT developer_domain) c FROM raw_ads_google WHERE creatives_found>0`).c,
    last_checked: one(d, `SELECT MAX(checked_at) m FROM raw_ads_google`).m,
  };
  const meta = {
    detector: META_DETECTOR,
    apps_checked: one(d, `SELECT COUNT(DISTINCT app_id) c FROM raw_ads_meta WHERE note LIKE ?`, `${META_DETECTOR}%`).c,
    apps_confirmed: one(d, `SELECT COUNT(DISTINCT app_id) c FROM raw_ads_meta WHERE found_by_package_id=1`).c,
    errors: one(d, `SELECT COUNT(*) c FROM raw_ads_meta WHERE note LIKE 'ошибка%'`).c,
    last_checked: one(d, `SELECT MAX(checked_at) m FROM raw_ads_meta`).m,
  };

  // Ход сбора: сколько карточек снято в каждый день по каждому гео — единственный
  // настоящий временной ряд, который у радара уже есть.
  const timeline = all(d,
    `SELECT snapshot_date AS date, geo, COUNT(DISTINCT app_id) AS cards
       FROM raw_app_page GROUP BY snapshot_date, geo ORDER BY snapshot_date`);

  const geos = cfg.geos.geos.map((g) => ({
    geo: g.geo, currency: g.currency, tier: g.tier, hl: g.hl.join(', '),
    ecpm_rel_us: g.ecpm_rel_us, arpu_rel_us: g.arpu_rel_us,
    is_reference: g.geo === base.meta.reference_geo ? 1 : 0,
    date: base.geoData[g.geo]?.date || null,
    snapshots: one(d, `SELECT COUNT(DISTINCT snapshot_date) c FROM raw_app_page WHERE geo=?`, g.geo).c,
    keywords_total: one(d, `SELECT COUNT(*) c FROM disc_keywords WHERE geo=?`, g.geo).c,
    discovered: one(d, `SELECT COUNT(*) c FROM disc_apps WHERE geo=?`, g.geo).c,
  }));

  return {
    meta: { ...base.meta },
    counts: base.counts,
    geos,
    geoData,
    globalFinalists: base.globalFinalists.map((r) => ({
      app_id: r.app_id, title: r.title, developer: r.developer, geos_count: r.geos_count,
      geos_list: r.geos_list, best_geo: r.best_geo, prescore: r.prescore, checks: r.checks,
      passed: r.passed, failed: r.failed, unknown: r.unknown, installs: r.installs, score: r.score,
      niche_head: r.niche_head, niche_door: r.niche_door, ads_found: r.ads_found,
      tracking_matched: r.tracking_matched, monetization_type: r.monetization_type,
      verification_level: r.verification_level,
    })),
    crossGeo: base.crossGeo,
    ads: { google, meta },
    timeline,
    // Страница «Сбор и планы» — те же данные, что разделы «Состояние сбора» и «План на месяц»
    // в Play Market Radar.
    collection: collectCollection(d, date),
  };
}

export async function run({ geo, date }) {
  const d = db();
  const data = collect(d, geo, date);

  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'report', 'appradar.html'), 'utf8');
  const json = JSON.stringify(packRows(data)).replace(/</g, '\\u003c');
  const fragment = tpl.replace('__RADAR_DATA__', () => json).replace('__UNPACK_JS__', () => UNPACK_JS);

  // RADAR_REPORT_FULL=1 — полная версия без отсечки строк, в out/full: для просмотра локально
  // (http://localhost:8777/full/…), в артефакт такой файл не помещается.
  const outDir = path.join(ROOT, 'out', process.env.RADAR_REPORT_FULL ? 'full' : '');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'appradar-artifact.html'), fragment, 'utf8');
  fs.writeFileSync(path.join(outDir, 'appradar.html'), `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0">
${fragment}
</body>
</html>`, 'utf8');

  const apps = Object.values(data.geoData).reduce((a, g) => a + g.apps.length, 0);
  log(`  AppRadar: out/appradar.html (${(fragment.length / 1024).toFixed(0)} КБ), гео ${Object.keys(data.geoData).length}, приложений ${apps}`);
  return { apps };
}
