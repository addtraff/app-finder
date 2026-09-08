// K7. Рекламные библиотеки — единственный ПРЯМОЙ признак закупки (B1 дополнения к ТЗ).
//
// Google Ads Transparency отдаёт 302 на не-браузерные запросы, поэтому работа идёт через
// настоящий Chromium с постоянным профилем, headless: false (дома — обычное окно, на VPS — под xvfb).
// Партии по 90 доменов, пауза 1200 мс. Первый 429 — стоп партии, пауза 30 минут, продолжение
// с места. Капча — стоп и алерт, без обхода.
//
// Meta Ad Library: без логина, запрос — ровно два значимых слова названия (поиск работает как AND;
// фраза из четырёх слов не матчит, package id даёт ноль). Результаты парсятся на ссылки
// play.google.com/store/apps/details?id=<package>; все совпавшие с реестром получают ads_found = meta.
// Пустой результат — «не найдено в Meta», НЕ «органика».
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, startRun, finishRun, logEvent } from '../lib/db.js';
import { qv } from './quantiles.js';
import { sleep, log, warn } from '../lib/util.js';

const BATCH = 90;
const PAUSE_MS = 1200;
const PAUSE_AFTER_429_MS = 30 * 60 * 1000;
// Chromium на Windows не запускается с --user-data-dir, содержащим не-ASCII символы,
// а проект лежит в «C:\ленды вайбкод». Профиль держим отдельно, в ASCII-пути.
const PROFILE_DIR = process.env.RADAR_BROWSER_PROFILE ||
  path.join(process.env.LOCALAPPDATA || process.env.HOME || ROOT, 'play-radar', 'browser-profile');

function domainOf(url) {
  if (!url) return null;
  try { return new URL(url.startsWith('http') ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}

// Ровно два значимых слова названия: без артиклей, знаков и хвостов вида «Pro», «Free».
const STOP_WORDS = new Set(['the', 'a', 'an', 'app', 'free', 'pro', 'plus', 'lite', 'and', 'for', 'my', 'your']);
export function metaQuery(title) {
  return String(title || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 2)
    .join(' ');
}

// Каждое гео снимается в свой час UTC (ТЗ 4.6), поэтому «сегодня» для одного гео и
// последний реальный снимок другого — разные даты. Очередь K7 строится по последнему
// снимку ЭТОГО гео, а не по дате запуска: иначе `stage check-ads` без --date всегда
// находит 0 строк, как только полночь UTC пройдена, а гео ещё не обновилось.
export function resolveSnapshotDate(d, geo, date) {
  return d.prepare(
    `SELECT MAX(snapshot_date) m FROM metrics_app_geo WHERE geo=? AND snapshot_date<=?`
  ).get(geo, date)?.m || date;
}

// Очередь (B1): сначала прирост выше p99 при базе от 50K, затем уровень A, затем B по prescore.
export function buildQueue(d, geo, date) {
  const snapDate = resolveSnapshotDate(d, geo, date);
  const p99 = qv(null, geo, 'installs_growth_1d', snapDate, 'p99', { nicheFirst: false });
  return d.prepare(
    `SELECT m.app_id, a.title, a.watch_level, m.installs, m.installs_growth_1d, m.prescore,
            m.copy_score_provisional, m.ads_found,
            (SELECT developer_website FROM raw_app_page p WHERE p.app_id=m.app_id AND p.geo=m.geo ORDER BY p.snapshot_date DESC LIMIT 1) AS site,
            (SELECT developer FROM raw_app_page p WHERE p.app_id=m.app_id AND p.geo=m.geo ORDER BY p.snapshot_date DESC LIMIT 1) AS developer,
            (SELECT MAX(checked_at) FROM raw_ads_meta x WHERE x.app_id=m.app_id) AS meta_checked
       FROM metrics_app_geo m JOIN apps a ON a.app_id=m.app_id
      WHERE m.geo=? AND m.snapshot_date=? AND a.watch_level IN ('A','B')
        AND (m.ads_found='unchecked'
             OR (a.watch_level='A' AND (SELECT MAX(checked_at) FROM raw_ads_meta x WHERE x.app_id=m.app_id) <= date(?, '-14 day'))
             OR (a.watch_level='B' AND (SELECT MAX(checked_at) FROM raw_ads_meta x WHERE x.app_id=m.app_id) <= date(?, '-30 day')))
      ORDER BY
        CASE WHEN m.installs >= 50000 AND m.installs_growth_1d > COALESCE(?, 0.10) THEN 0 ELSE 1 END,
        CASE a.watch_level WHEN 'A' THEN 0 ELSE 1 END,
        COALESCE(m.prescore, -1) DESC`
  ).all(geo, snapDate, date, date, p99);
}

async function loadPlaywright() {
  try { return (await import('playwright')).chromium; }
  catch { return null; }
}

function isRateLimited(html, status) {
  return status === 429 || /too many requests|rate limit/i.test(html.slice(0, 4000));
}
function isCaptcha(html) {
  return /recaptcha|unusual traffic|\/sorry\/index|captcha|checkpoint\/challenge/i.test(html);
}

async function googleTransparency(ctx, domains, date, limit) {
  const d = db();
  const ins = d.prepare(`INSERT OR REPLACE INTO raw_ads_google (developer_domain, checked_at, creatives_found, count, note) VALUES (?,?,?,?,?)`);
  const page = await ctx.newPage();
  let checked = 0, found = 0, i = 0;

  while (i < domains.length && (!limit || checked < limit)) {
    const batch = domains.slice(i, i + BATCH);
    let hitLimit = false;

    for (const domain of batch) {
      if (limit && checked >= limit) break;
      const url = `https://adstransparency.google.com/?region=anywhere&domain=${encodeURIComponent(domain)}`;
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1500); // выдача подгружается скриптом
        const html = await page.content();

        if (isCaptcha(html)) {
          logEvent('k7_captcha', { date, detail: `google, домен ${domain}` });
          warn('капча в Ads Transparency — стоп, обхода нет');
          await page.close();
          return { checked, found, stopped: 'captcha' };
        }
        if (isRateLimited(html, resp && resp.status())) {
          hitLimit = true;
          logEvent('k7_rate_limited', { date, detail: `google, домен ${domain}, пауза 30 мин` });
          warn('429 в Ads Transparency — пауза 30 минут, продолжу с этого домена');
          break;
        }

        // ВНИМАНИЕ: селектор карточек креативов — единственное место, зависящее от вёрстки
        // Ads Transparency. Если Google её сменит, стадия начнёт возвращать 0 вместо ошибки.
        // Проверять глазами при первом запуске и при подозрительно ровных нулях.
        const cards = await page
          .locator('creative-preview, [data-creative-id], a[href*="/advertiser/"][href*="/creative/"]')
          .count().catch(() => 0);
        const advertiser = /advertiser\/AR[0-9A-Za-z_-]+/.test(html);
        const hasAds = cards > 0 || advertiser ? 1 : 0;
        ins.run(domain, date, hasAds, cards, advertiser && !cards ? 'рекламодатель найден, карточки не отрисовались' : null);
        if (hasAds) found++;
        checked++;
      } catch (e) {
        ins.run(domain, date, null, null, `ошибка: ${e.message}`);
      }
      await sleep(PAUSE_MS);
    }

    if (hitLimit) {
      await sleep(PAUSE_AFTER_429_MS);
      continue; // продолжаем с того же места, партия не сдвигается
    }
    i += BATCH;
    if (i < domains.length) log(`  Google Ads Transparency: партия ${Math.ceil(i / BATCH)}, проверено ${checked}`);
  }

  await page.close();
  return { checked, found, stopped: null };
}

async function metaAdLibrary(ctx, apps, date, limit) {
  const d = db();
  const ins = d.prepare(`INSERT OR REPLACE INTO raw_ads_meta (app_id, query, checked_at, found_by_package_id, ad_count, note) VALUES (?,?,?,?,?,?)`);
  const known = d.prepare(`SELECT 1 FROM apps WHERE app_id=?`);
  const page = await ctx.newPage();
  let checked = 0, found = 0;

  for (const app of apps) {
    if (limit && checked >= limit) break;
    const query = metaQuery(app.title);
    if (!query) continue;
    const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&q=${encodeURIComponent(query)}&media_type=all`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      const html = await page.content();

      if (isCaptcha(html)) {
        logEvent('k7_captcha', { date, detail: `meta, запрос "${query}"` });
        warn('капча в Meta Ad Library — стоп');
        await page.close();
        return { checked, found, stopped: 'captcha' };
      }

      // Один запрос подтверждает все package id, которые в нём всплыли.
      const packages = [...html.matchAll(/store\/apps\/details\?id=([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
      const uniq = [...new Set(packages)];
      d.transaction(() => {
        for (const pkg of uniq) {
          if (!known.get(pkg)) continue;
          ins.run(pkg, query, date, 1, uniq.length, 'подтверждён по ссылке на карточку Play');
          d.prepare(`INSERT OR REPLACE INTO organic_labels (app_id, label, evidence, labeled_at, note) VALUES (?,?,?,?,?)`)
            .run(pkg, 'buys', 'meta', date, `запрос "${query}"`);
          found++;
        }
        if (!uniq.includes(app.app_id)) ins.run(app.app_id, query, date, 0, 0, 'не найдено в Meta');
      })();
      checked++;
    } catch (e) {
      ins.run(app.app_id, query, date, null, null, `ошибка: ${e.message}`);
    }
    await sleep(PAUSE_MS);
  }

  await page.close();
  return { checked, found, stopped: null };
}

export async function run({ geo, date, runId, cycle = 'daily', useBrowser = true, headless = false, limit = null }) {
  const d = db();
  startRun(runId, 'check-ads', geo, cycle, date);
  const queue = buildQueue(d, geo, date);

  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'k7-queue.csv'),
    ['app_id,title,meta_query,developer,domain,watch_level,installs,growth_1d,prescore']
      .concat(queue.map((r) => [
        r.app_id, JSON.stringify(r.title || ''), JSON.stringify(metaQuery(r.title)),
        JSON.stringify(r.developer || ''), domainOf(r.site) || '', r.watch_level,
        r.installs ?? '', r.installs_growth_1d ?? '', r.prescore ?? '',
      ].join(','))).join('\n'), 'utf8');

  const chromium = useBrowser ? await loadPlaywright() : null;
  if (!chromium) {
    finishRun(runId, 'check-ads', geo, { status: 'manual', notes: `очередь ${queue.length} -> out/k7-queue.csv; playwright не установлен` });
    log(`  ${geo}: K7 не автоматизирован (playwright не установлен). Очередь ${queue.length} в out/k7-queue.csv`);
    log(`     установить: npm i playwright && npx playwright install chromium`);
    return { queued: queue.length, checked: 0, automated: false };
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    locale: 'en-US',
    viewport: { width: 1360, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let g = { checked: 0, found: 0, stopped: null }, m = { checked: 0, found: 0, stopped: null };
  try {
    const domains = [...new Set(queue.map((r) => domainOf(r.site)).filter(Boolean))];
    g = await googleTransparency(ctx, domains, date, limit);
    if (!g.stopped) m = await metaAdLibrary(ctx, queue, date, limit);
  } finally {
    await ctx.close();
  }

  // Сводим результат в organic_labels: ads_found собирается расчётным слоем из raw_ads_*.
  const stopped = g.stopped || m.stopped;
  finishRun(runId, 'check-ads', geo, {
    status: stopped ? `stopped-${stopped}` : 'ok',
    requests: g.checked + m.checked,
    notes: `google ${g.checked} доменов (реклама у ${g.found}), meta ${m.checked} запросов (подтверждено ${m.found})`,
  });
  log(`  ${geo}: K7 — google ${g.checked} доменов, реклама у ${g.found}; meta ${m.checked} запросов, подтверждено ${m.found}` +
      (stopped ? ` (остановлено: ${stopped})` : ''));
  return { queued: queue.length, checked: g.checked + m.checked, found: g.found + m.found, automated: true, stopped };
}
