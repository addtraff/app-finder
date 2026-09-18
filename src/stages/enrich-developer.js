// K6 / D4. Портфель, юрлицо, адрес, домен. Склейка разработчиков по адресу и по домену.
// Фабрика: 15+ приложений при медиане дней с апдейта > 100, либо совпадение адреса/домена с помеченной.
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, primaryHl } from '../lib/config.js';
import { median, md5, log } from '../lib/util.js';

function normAddress(a) {
  if (!a) return null;
  return String(a).toLowerCase()
    .replace(/[\n\r]+/g, ' ')
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street|str|st|road|rd|avenue|ave|suite|ste|floor|fl|apt|unit|building|bldg)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}
function domainOf(url) {
  if (!url) return null;
  try { return new URL(url.startsWith('http') ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}

// Слишком общие адреса не склеивают: стоп-лист против ложной склейки честных разработчиков.
const GENERIC_ADDRESS = [/^\s*$/, /^n\/?a$/i, /^-+$/];

export async function run({ geo, date, runId, cycle = 'discovery', scope = null }) {
  const d = db();
  startRun(runId, 'enrich-developer', geo, cycle, date);
  const hl = primaryHl(geo);
  const budget = config().budget.discovery;

  // --scope funnel: разработчики прошедших воронку по последнему вердикту гео, без снимка за
  // неделю и без лимита — обычный отбор (уровни A–C, 100 на гео) кандидатов почти не покрывал.
  const devs = scope === 'funnel'
    ? d.prepare(
      `SELECT p.developer_id, MIN(p.developer_legal_name) AS legal, MIN(p.developer_address) AS addr,
              MIN(p.developer_email) AS email, MIN(p.developer_website) AS site, COUNT(DISTINCT p.app_id) AS seen_apps
         FROM raw_app_page p
        WHERE p.geo=? AND p.developer_id IS NOT NULL
          AND p.app_id IN (SELECT s.app_id FROM screen_result s WHERE s.geo=? AND s.reject_reason IS NULL
                             AND s.snapshot_date=(SELECT MAX(snapshot_date) FROM screen_result WHERE geo=?))
          AND NOT EXISTS (SELECT 1 FROM raw_developer rd WHERE rd.developer_id=p.developer_id AND rd.snapshot_date > date(?, '-7 day'))
        GROUP BY p.developer_id
        ORDER BY seen_apps DESC`
    ).all(geo, geo, geo, date)
    : d.prepare(
      `SELECT p.developer_id, MIN(p.developer_legal_name) AS legal, MIN(p.developer_address) AS addr,
              MIN(p.developer_email) AS email, MIN(p.developer_website) AS site, COUNT(DISTINCT p.app_id) AS seen_apps
         FROM raw_app_page p
         JOIN apps a ON a.app_id = p.app_id
        WHERE p.geo=? AND p.developer_id IS NOT NULL AND a.watch_level IN ('A','B','C')
          AND NOT EXISTS (SELECT 1 FROM raw_developer rd WHERE rd.developer_id=p.developer_id AND rd.snapshot_date=?)
        GROUP BY p.developer_id
        ORDER BY seen_apps DESC
        LIMIT ?`
    ).all(geo, date, budget.max_developers);

  const ins = d.prepare(`INSERT OR REPLACE INTO raw_developer
    (developer_id, snapshot_date, legal_name, address, address_norm, email, website, domain,
     apps_count, apps_json, update_interval_median, is_factory)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insCluster = d.prepare(`INSERT OR REPLACE INTO developer_clusters (cluster_id, key_type, key_value, developer_id, is_factory) VALUES (?,?,?,?,?)`);

  let done = 0, errors = 0, factories = 0;
  for (const dev of devs) {
    let portfolio = [];
    try {
      portfolio = await play.developer(dev.developer_id, geo, hl, budget.developer_max_apps);
    } catch (e) {
      errors++;
      log(`  разработчик ${dev.developer_id}: ${e.message}`);
    }
    const appsCount = Math.max(portfolio.length, dev.seen_apps);

    // Медиана дней с апдейта по тем приложениям портфеля, чьи карточки у нас есть.
    const ids = portfolio.map((a) => a.appId);
    let gaps = [];
    if (ids.length) {
      const rows = d.prepare(
        `SELECT app_id, MAX(updated_ts) AS ts FROM raw_app_page WHERE app_id IN (${ids.map(() => '?').join(',')}) GROUP BY app_id`
      ).all(...ids);
      gaps = rows.map((r) => (r.ts ? (Date.now() - r.ts) / 86400000 : null)).filter((v) => v != null);
    }
    const medGap = gaps.length >= 3 ? median(gaps) : null;

    const addrNorm = normAddress(dev.addr);
    const domain = domainOf(dev.site);
    const isFactory = appsCount >= 15 && medGap != null && medGap > 100 ? 1 : 0;

    d.transaction(() => {
      ins.run(dev.developer_id, date, dev.legal, dev.addr, addrNorm, dev.email, dev.site, domain,
        appsCount, JSON.stringify(portfolio.map((a) => ({ appId: a.appId, title: a.title }))), medGap, isFactory);
      if (addrNorm && !GENERIC_ADDRESS.some((re) => re.test(addrNorm)) && addrNorm.length > 12) {
        insCluster.run(`addr-${md5(addrNorm).slice(0, 10)}`, 'address', addrNorm, dev.developer_id, isFactory);
      }
      if (domain) insCluster.run(`dom-${md5(domain).slice(0, 10)}`, 'domain', domain, dev.developer_id, isFactory);
    })();
    if (isFactory) factories++;
    done++;
  }

  // Фабричность распространяется по кластеру: если хоть один разработчик по адресу/домену — фабрика.
  d.exec(`UPDATE developer_clusters SET is_factory = 1
          WHERE cluster_id IN (SELECT cluster_id FROM developer_clusters WHERE is_factory = 1)`);

  finishRun(runId, 'enrich-developer', geo, { requests: done, errors, notes: `${done} разработчиков, фабрик ${factories}` });
  log(`  ${geo}: разработчиков ${done}, помечено фабриками ${factories}`);
  return { done, factories, errors };
}
