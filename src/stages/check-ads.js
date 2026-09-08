// K7. Google Ads Transparency + Meta Ad Library — единственный ПРЯМОЙ признак закупки.
//
// Узкое место здесь не лимиты, а транспорт. Ads Transparency отдаёт 302 на любой
// не-браузерный клиент, и куки это не лечит: Google смотрит не на сессию, а на клиента.
// Поэтому запрос идёт не навигацией, а внутренним RPC ИЗНУТРИ страницы — обычный fetch
// в контексте вкладки, уже прошедшей проверку клиента. Как только запросы идут изнутри,
// лимиты оказываются щадящими.
//
// Единица запроса — домен рекламодателя, а не приложение: у одного разработчика шесть
// приложений это один запрос, а не шесть. Домен берётся из dev_website, если пусто — из
// хоста privacy policy; хостинги-пустышки (wixsite, blogspot, генераторы политик) отсеиваются.
//
// Темп подобран замерами, не на глаз:
//   700–750 мс -> 429 после ~114 доменов
//   850 мс     -> 110 из 110 чисто
//   1200 мс    -> 0 ошибок за 8 дней и ~2400 проверок   <- рабочий, вдвое ниже потолка
// Партия — 90 доменов в сутки (~2 минуты), остальные сутки эндпоинт не трогаем.
//
// Быстрый режим: скрытая браузерная панель замораживает setTimeout, но не fetch, поэтому
// партия гонится параллельными окнами по 14 доменов внутри одного awaited-вызова. Потолок
// параллельности 14–16: на 17–18 Google мгновенно возвращает 429. Лечится тривиально —
// выкинуть ошибочные и догнать последовательно с паузой 900 мс.
//
// 429 здесь МЯГКИЙ: не бан, не капча, не блок по IP. Снимается в пределах той же сессии —
// следующий же запрос после отброса проблемных проходит нормально. Поэтому не ждём вообще,
// а доделываем партию и повторяем упавшие. Ждать 30 минут, как делалось раньше, не нужно.
//
// Строки с ошибкой остаются в очереди и переспрашиваются; успешно проверенный домен
// не переспрашивается никогда.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, startRun, finishRun, logEvent } from '../lib/db.js';
import { qv } from './quantiles.js';
import { sleep, log, warn } from '../lib/util.js';

const PROFILE_DIR = process.env.RADAR_BROWSER_PROFILE ||
  path.join(process.env.LOCALAPPDATA || process.env.HOME || ROOT, 'play-radar', 'browser-profile');

function cfg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ads-transparency.json'), 'utf8'));
}

export function hostOf(url) {
  if (!url) return null;
  try {
    const h = new URL(String(url).startsWith('http') ? url : `http://${url}`).hostname.toLowerCase();
    return h.replace(/^www\./, '') || null;
  } catch { return null; }
}

function isBlacklisted(host, blacklist) {
  if (!host) return true;
  return blacklist.some((b) => host === b || host.endsWith('.' + b));
}

// Ровно два значимых слова названия: поиск Meta работает как AND, фраза из четырёх слов
// не матчит, package id даёт ноль.
const STOP_WORDS = new Set(['the', 'a', 'an', 'app', 'free', 'pro', 'plus', 'lite', 'and', 'for', 'my', 'your']);
export function metaQuery(title) {
  return String(title || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 2)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Очередь доменов: по ценности решения, а не по алфавиту.
//   1 — именной список (--domains / --apps): конкретные конкуренты нужны сегодня
//   2 — кандидаты, прошедшие воронку, по убыванию prescore («вердикт build»)
//   3 — приложения из ниш под наблюдением (уровни A/B)
//   4 — хвост: остальные с установками выше порога
// Успешно проверенные домены (status='ok') исключаются навсегда.
// ---------------------------------------------------------------------------
export function buildDomainQueue(d, geo, date, { domains = null, apps = null } = {}) {
  const c = cfg();
  const snapDate = d.prepare(
    `SELECT MAX(snapshot_date) m FROM metrics_app_geo WHERE geo=? AND snapshot_date<=?`
  ).get(geo, date)?.m || date;

  const done = new Set(d.prepare(
    `SELECT DISTINCT developer_domain FROM raw_ads_google WHERE status='ok'`
  ).all().map((r) => r.developer_domain));

  const named = new Set((apps || '').split(',').map((s) => s.trim()).filter(Boolean));
  const namedDomains = new Set((domains || '').split(',').map((s) => hostOf(s.trim())).filter(Boolean));

  // Приложение -> домен, с ценностью решения и признаками для приоритета.
  const byDomain = new Map();
  let noDomain = 0, blacklisted = 0, alreadyDone = 0;
  for (const r of d.prepare(
    `SELECT m.app_id, a.title, a.watch_level, m.installs, m.prescore, m.installs_growth_1d,
            s.reject_reason,
            (SELECT p.developer_website FROM raw_app_page p
              WHERE p.app_id=m.app_id AND p.geo=m.geo ORDER BY p.snapshot_date DESC LIMIT 1) AS site,
            (SELECT p.privacy_policy FROM raw_app_page p
              WHERE p.app_id=m.app_id AND p.geo=m.geo ORDER BY p.snapshot_date DESC LIMIT 1) AS privacy,
            (SELECT p.developer FROM raw_app_page p
              WHERE p.app_id=m.app_id AND p.geo=m.geo ORDER BY p.snapshot_date DESC LIMIT 1) AS developer
       FROM metrics_app_geo m
       JOIN apps a ON a.app_id=m.app_id
       LEFT JOIN screen_result s ON s.app_id=m.app_id AND s.geo=m.geo AND s.snapshot_date=m.snapshot_date
      WHERE m.geo=? AND m.snapshot_date=?`
  ).all(geo, snapDate)) {
    // dev_website, если пусто — privacy_url
    const host = hostOf(r.site) || hostOf(r.privacy);
    if (!host) { noDomain++; continue; }              // ни сайта, ни политики — проверять нечего
    if (isBlacklisted(host, c.blacklist_hosts)) { blacklisted++; continue; }
    if (done.has(host)) { alreadyDone++; continue; }  // успешно проверенные не переспрашиваем

    if (!byDomain.has(host)) {
      byDomain.set(host, {
        domain: host, apps: [], developer: r.developer,
        best_prescore: null, max_installs: 0, passed: 0, watched: 0, named: 0,
      });
    }
    const rec = byDomain.get(host);
    rec.apps.push({ app_id: r.app_id, title: r.title });
    if (r.prescore != null && (rec.best_prescore == null || r.prescore > rec.best_prescore)) rec.best_prescore = r.prescore;
    if (r.installs != null && r.installs > rec.max_installs) rec.max_installs = r.installs;
    if (!r.reject_reason) rec.passed = 1;
    if (['A', 'B'].includes(r.watch_level)) rec.watched = 1;
    if (named.has(r.app_id) || namedDomains.has(host)) rec.named = 1;
  }

  const tier = (r) => {
    if (r.named) return 0;                                   // именной список
    if (r.passed && r.best_prescore != null) return 1;        // кандидаты, прошедшие воронку
    if (r.watched) return 2;                                  // ниши под наблюдением
    if (r.max_installs >= c.min_installs_tail) return 3;      // хвост по установкам
    return 4;
  };

  const queue = [...byDomain.values()]
    .map((r) => ({ ...r, tier: tier(r) }))
    .filter((r) => r.tier <= 3)
    .sort((a, b) => (a.tier - b.tier)
      || ((b.best_prescore ?? -1) - (a.best_prescore ?? -1))
      || (b.max_installs - a.max_installs));
  queue.skipped = { noDomain, blacklisted, alreadyDone };
  return queue;
}

// Обратная совместимость: отчёты просят очередь в разрезе приложений.
export function buildQueue(d, geo, date) {
  const domains = buildDomainQueue(d, geo, date);
  const out = [];
  for (const dm of domains) {
    for (const a of dm.apps) {
      out.push({
        app_id: a.app_id, title: a.title, watch_level: null,
        installs: dm.max_installs, installs_growth_1d: null,
        prescore: dm.best_prescore, copy_score_provisional: null,
        ads_found: 'unchecked', site: dm.domain, developer: dm.developer,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Разбор ответа: снимаем ВСЕ скалярные поля с их путями. Ключи у Google числовые и
// недокументированные, поэтому здесь ничего не интерпретируется — размечаем офлайн.
// ---------------------------------------------------------------------------
export function flattenScalars(value, prefix = '', out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenScalars(v, prefix ? `${prefix}.${i}` : String(i), out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flattenScalars(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push({ path: prefix, value: String(value) });
  }
  return out;
}

// Идентификатор рекламодателя (AR…) — единственное, что опознаём по форме, а не по позиции.
function findAdvertiserId(raw) {
  const m = String(raw || '').match(/\bAR[0-9A-Za-z_-]{8,}\b/);
  return m ? m[0] : null;
}
// Число креативов: считаем по идентификаторам креативов (CR…), не угадывая индексы.
function countCreatives(raw) {
  const set = new Set(String(raw || '').match(/\bCR[0-9A-Za-z_-]{8,}\b/g) || []);
  return set.size;
}

// ---------------------------------------------------------------------------
// Запрос выполняется ИЗНУТРИ страницы. Возвращает по домену: status/raw/ok.
// Параллель — окнами: window доменов внутри одного awaited-вызова.
// ---------------------------------------------------------------------------
async function fetchInPage(page, domains, c) {
  return page.evaluate(async ({ domains, rpcUrl, payloadTemplate, limit }) => {
    async function one(domain) {
      const body = payloadTemplate
        .replace(/\{\{DOMAIN\}\}/g, domain)
        .replace(/\{\{LIMIT\}\}/g, String(limit));
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: 'f.req=' + encodeURIComponent(body),
        });
        const text = await res.text();
        if (res.status === 429) return { domain, status: '429', http: 429, text: text.slice(0, 500) };
        if (res.status === 302 || res.redirected) return { domain, status: '302', http: res.status, text: '' };
        if (!res.ok) return { domain, status: 'http_' + res.status, http: res.status, text: text.slice(0, 500) };
        return { domain, status: 'ok', http: res.status, text: text };
      } catch (e) {
        return { domain, status: 'fetch_failed', http: null, text: String(e && e.message || e) };
      }
    }
    return Promise.all(domains.map(one));
  }, { domains, rpcUrl: c.rpc_url, payloadTemplate: c.payload_template, limit: c.creatives_limit });
}

function saveResult(d, r, date) {
  const insRow = d.prepare(`INSERT OR REPLACE INTO raw_ads_google
    (developer_domain, checked_at, creatives_found, count, note, status, advertiser_id, raw_json)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insField = d.prepare(`INSERT OR REPLACE INTO raw_ads_google_field
    (developer_domain, checked_at, path, value) VALUES (?,?,?,?)`);

  if (r.status !== 'ok') {
    insRow.run(r.domain, date, null, null, r.text ? String(r.text).slice(0, 300) : null, r.status, null, null);
    return { found: 0, ok: false };
  }

  // Google префиксует ответ )]}' — снимаем до разбора.
  const cleaned = String(r.text).replace(/^\)\]\}'[^\n]*\n?/, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(cleaned); } catch { parsed = null; }

  const advertiser = findAdvertiserId(r.text);
  const count = countCreatives(r.text);
  const found = count > 0 || !!advertiser ? 1 : 0;

  d.transaction(() => {
    insRow.run(r.domain, date, found, count, parsed ? null : 'ответ не разобрался как JSON, сохранён сырым',
      'ok', advertiser, String(r.text).slice(0, 200000));
    if (parsed) {
      for (const f of flattenScalars(parsed).slice(0, 4000)) {
        insField.run(r.domain, date, f.path, f.value.slice(0, 500));
      }
    }
  })();
  return { found, ok: true };
}

async function googleTransparency(page, queue, date, c, opts) {
  const d = db();
  const total = queue.length;
  let checked = 0, found = 0, failed = [];

  if (opts.sequential) {
    for (const item of queue) {
      const [r] = await fetchInPage(page, [item.domain], c);
      const res = saveResult(d, r, date);
      if (res.ok) { checked++; found += res.found; } else failed.push(item);
      await sleep(c.pause_ms);
      if (checked % 20 === 0 && checked) log(`  Ads Transparency: ${checked}/${total}`);
    }
  } else {
    // Окна по 14: потолок параллельности, выше — мгновенный 429.
    for (let i = 0; i < queue.length; i += c.parallel_window) {
      const window = queue.slice(i, i + c.parallel_window);
      const results = await fetchInPage(page, window.map((w) => w.domain), c);
      for (const r of results) {
        const res = saveResult(d, r, date);
        if (res.ok) { checked++; found += res.found; }
        else failed.push(window.find((w) => w.domain === r.domain));
      }
      log(`  Ads Transparency: окно ${Math.ceil((i + window.length) / c.parallel_window)}, ` +
          `проверено ${checked}/${total}, ошибок ${failed.length}`);
    }
  }

  // 429 мягкий: не ждём, а догоняем упавшие последовательно с паузой.
  const retry = failed.filter(Boolean);
  failed = [];
  if (retry.length) {
    log(`  догоняю ${retry.length} упавших последовательно, пауза ${c.retry_pause_ms} мс`);
    for (const item of retry) {
      const [r] = await fetchInPage(page, [item.domain], c);
      const res = saveResult(d, r, date);
      if (res.ok) { checked++; found += res.found; } else failed.push({ domain: item.domain, status: r.status });
      await sleep(c.retry_pause_ms);
    }
  }

  // 302 означает, что запрос ушёл мимо браузерного контекста — это наш баг, а не лимит.
  const leaked = failed.filter((f) => f.status === '302').length;
  if (leaked) {
    logEvent('k7_transport_leak', { date, detail: `${leaked} запросов ушли мимо браузерного контекста (302)` });
    warn(`${leaked} запросов получили 302 — они ушли мимо браузерного контекста, это баг транспорта, не лимит`);
  }
  return { checked, found, failed };
}

async function metaAdLibrary(page, apps, date, c, limit) {
  const d = db();
  const ins = d.prepare(`INSERT OR REPLACE INTO raw_ads_meta
    (app_id, query, checked_at, found_by_package_id, ad_count, note) VALUES (?,?,?,?,?,?)`);
  const known = d.prepare(`SELECT 1 FROM apps WHERE app_id=?`);
  let checked = 0, found = 0;

  for (const app of apps) {
    if (limit && checked >= limit) break;
    const query = metaQuery(app.title);
    if (!query) continue;
    const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&q=${encodeURIComponent(query)}&media_type=all`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      // Капчу определяем по факту редиректа на checkpoint или по видимой форме,
      // а не по подстроке в HTML: у Facebook слово captcha встречается в JS-бандле
      // на любой странице, и раньше это давало ложный стоп на первом же запросе.
      const landedOn = page.url();
      const challenged = /\/checkpoint\//.test(landedOn) ||
        (await page.locator('form[action*="checkpoint"], input[name="captcha_response"]').count().catch(() => 0)) > 0;
      if (challenged) {
        logEvent('k7_captcha', { date, detail: `meta, запрос "${query}", url ${landedOn}` });
        warn('капча в Meta Ad Library — стоп');
        return { checked, found, stopped: 'captcha' };
      }
      const html = await page.content();
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
    await sleep(c.pause_ms);
  }
  return { checked, found, stopped: null };
}

async function loadPlaywright() {
  try { return (await import('playwright')).chromium; }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Калибровка формы запроса. Номера полей в proto у Google не документированы и
// меняются, угадывать их бессмысленно: 400 «Trouble converting f.req to
// SearchCreativesRequest» — ровно про это. Но сама страница шлёт нужный запрос,
// когда домен вводят в её интерфейс. Поэтому мы не угадываем, а перехватываем
// настоящий запрос и сохраняем его как шаблон, подставив {{DOMAIN}}.
// ---------------------------------------------------------------------------
async function calibrate(page, probeDomain, date) {
  const captured = [];
  const onRequest = (req) => {
    const url = req.url();
    if (!url.includes('/anji/_/rpc/')) return;
    if (req.method() !== 'POST') return;
    captured.push({ url, body: req.postData() || '' });
  };
  page.on('request', onRequest);

  log(`  калибровка: открываю страницу по домену ${probeDomain} и слушаю её собственные RPC`);
  await page.goto(`https://adstransparency.google.com/?region=anywhere&domain=${encodeURIComponent(probeDomain)}`,
    { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(8000); // выдача подгружается скриптом, запросы идут не сразу
  page.off('request', onRequest);

  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ads-transparency-calibration.json'),
    JSON.stringify({ probe_domain: probeDomain, captured_at: date, requests: captured }, null, 2), 'utf8');

  log(`  калибровка: перехвачено ${captured.length} RPC-запросов -> out/ads-transparency-calibration.json`);
  for (const r of captured) {
    log(`     ${r.url.split('/anji/_/rpc/')[1] || r.url} · ${r.body.length} байт`);
  }

  // Ищем запрос, в теле которого встречается проверочный домен: это и есть поиск.
  const hit = captured.find((r) => r.body && decodeURIComponent(r.body).includes(probeDomain));
  if (!hit) {
    warn('калибровка: запрос с доменом в теле не найден. Возможно, страница ищет по идентификатору ' +
         'рекламодателя, а не по домену — посмотрите out/ads-transparency-calibration.json.');
    return null;
  }

  // Тело приходит как f.req=<urlencoded json>. Достаём JSON и параметризуем домен.
  const raw = hit.body.startsWith('f.req=') ? decodeURIComponent(hit.body.slice(6)) : decodeURIComponent(hit.body);
  const template = raw.split(probeDomain).join('{{DOMAIN}}');

  const cfgPath = path.join(ROOT, 'config', 'ads-transparency.json');
  const conf = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  conf.rpc_url = hit.url.split('?')[0];
  conf.payload_template = template;
  conf._calibrated_at = date;
  conf._calibrated_from = probeDomain;
  fs.writeFileSync(cfgPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');

  log(`  калибровка: форма запроса сохранена в config/ads-transparency.json`);
  log(`     эндпоинт: ${conf.rpc_url}`);
  log(`     шаблон:   ${template.slice(0, 200)}${template.length > 200 ? '…' : ''}`);
  return conf;
}

export async function run({ geo, date, runId, cycle = 'daily', useBrowser = true, headless = false,
                            limit = null, sequential = false, domains = null, apps = null,
                            skipMeta = false, calibrateOnly = false }) {
  const d = db();
  startRun(runId, 'check-ads', geo, cycle, date);
  let c = cfg();
  const batch = limit ? Number(limit) : c.batch_per_day;

  const full = buildDomainQueue(d, geo, date, { domains, apps });
  const skipped = full.skipped || {};
  const queue = full.slice(0, batch);
  log(`  ${geo}: доменов доступно ${full.length}, берём ${queue.length}; пропущено — ` +
      `без домена ${skipped.noDomain || 0}, хостинги-пустышки ${skipped.blacklisted || 0}, ` +
      `уже проверено ${skipped.alreadyDone || 0}`);
  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'k7-queue.csv'),
    ['domain,tier,apps,developer,best_prescore,max_installs']
      .concat(queue.map((r) => [
        r.domain, r.tier, r.apps.length, JSON.stringify(r.developer || ''),
        r.best_prescore ?? '', r.max_installs ?? '',
      ].join(','))).join('\n'), 'utf8');

  if (!queue.length) {
    finishRun(runId, 'check-ads', geo, { status: 'ok', notes: 'очередь пуста: все домены уже проверены' });
    log(`  ${geo}: очередь K7 пуста — все домены со статусом ok уже проверены`);
    return { queued: 0, checked: 0 };
  }

  const chromium = useBrowser ? await loadPlaywright() : null;
  if (!chromium) {
    finishRun(runId, 'check-ads', geo, { status: 'manual', notes: `очередь ${queue.length} -> out/k7-queue.csv; playwright не установлен` });
    log(`  ${geo}: playwright не установлен. Очередь ${queue.length} доменов в out/k7-queue.csv`);
    return { queued: queue.length, checked: 0, automated: false };
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless, locale: 'en-US', viewport: { width: 1280, height: 860 },
  });

  let g = { checked: 0, found: 0, failed: [] }, m = { checked: 0, found: 0, stopped: null };
  try {
    const page = await ctx.newPage();

    // Форма запроса не угадывается: если она ещё не откалибрована или прошлый прогон
    // получил 400, снимаем настоящий запрос с самой страницы.
    const needCalibration = calibrateOnly || !c._calibrated_at ||
      d.prepare(`SELECT COUNT(*) c FROM raw_ads_google WHERE status LIKE 'http_4%'`).get().c > 0;
    if (needCalibration) {
      const probe = queue[0] ? queue[0].domain : 'canva.com';
      const updated = await calibrate(page, probe, date);
      if (updated) c = updated;
      else if (!c._calibrated_at) {
        finishRun(runId, 'check-ads', geo, { status: 'calibration-failed', notes: 'форму запроса снять не удалось' });
        warn('форму запроса снять не удалось — смотрите out/ads-transparency-calibration.json');
        await page.close();
        return { queued: queue.length, checked: 0, calibrated: false };
      }
      if (calibrateOnly) {
        finishRun(runId, 'check-ads', geo, { status: 'ok', notes: 'калибровка выполнена' });
        await page.close();
        return { queued: queue.length, checked: 0, calibrated: true };
      }
      // После калибровки старые 400 больше не мешают очереди.
      d.prepare(`DELETE FROM raw_ads_google WHERE status LIKE 'http_4%'`).run();
    }

    // Транспорт: стоим НА странице Ads Transparency, дальше все запросы идут её же
    // fetch-ом. Прямой HTTP отсюда исключён по построению.
    if (page.url().indexOf('adstransparency.google.com') < 0) {
      await page.goto('https://adstransparency.google.com/?region=anywhere', {
        waitUntil: 'domcontentloaded', timeout: 45000,
      });
      await page.waitForTimeout(2000);
    }

    log(`  ${geo}: K7 — ${queue.length} доменов, режим ${sequential ? 'последовательный ' + c.pause_ms + ' мс' : 'окнами по ' + c.parallel_window}`);
    g = await googleTransparency(page, queue, date, c, { sequential });

    if (!skipMeta) {
      const metaApps = queue.flatMap((q) => q.apps).slice(0, batch);
      m = await metaAdLibrary(page, metaApps, date, c, batch);
    }
    await page.close();
  } finally {
    await ctx.close();
  }

  finishRun(runId, 'check-ads', geo, {
    status: m.stopped ? `stopped-${m.stopped}` : 'ok',
    requests: g.checked + m.checked,
    errors: g.failed.length,
    notes: `google ${g.checked} доменов (реклама у ${g.found}, не удалось ${g.failed.length}), ` +
           `meta ${m.checked} запросов (подтверждено ${m.found})`,
  });
  log(`  ${geo}: K7 — google ${g.checked} доменов, реклама у ${g.found}, не удалось ${g.failed.length}; ` +
      `meta ${m.checked} запросов, подтверждено ${m.found}`);
  return { queued: queue.length, checked: g.checked + m.checked, found: g.found + m.found, failed: g.failed.length };
}
