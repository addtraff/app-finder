// E4, часть B2 дополнения к ТЗ: разбор APK по именам пакетов классов.
// Скачивание APK — вручную (уровень A, десяток файлов в неделю): файл кладётся в apk-import/
// с именем <package>_<version>.apk. Скрипт перечисляет имена пакетов классов из dex и ищет
// префиксы атрибуции, пейволла, вычисления и рекламы.
//
// Граница: перечисление имён пакетов — анализ состава. Декомпиляция кода, извлечение ассетов
// и обученных моделей в объём не входят и здесь не делаются.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, startRun, finishRun, logEvent } from '../lib/db.js';
import { listEntries, readEntry } from '../lib/zip.js';
import { log, warn } from '../lib/util.js';

const IMPORT_DIR = path.join(ROOT, 'apk-import');

function prefixes() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'apk-prefixes.json'), 'utf8'));
}

// В dex имена классов лежат как дескрипторы: Lcom/appsflyer/... ;
const descriptor = (pkg) => 'L' + pkg.replace(/\./g, '/') + '/';

function scanDex(dexBuf, cfg) {
  const text = dexBuf.toString('latin1');
  const hit = (group) => Object.entries(cfg[group])
    .filter(([pkg]) => text.includes(descriptor(pkg)))
    .map(([, name]) => name);

  const attribution = hit('attribution');
  const paywall = hit('paywall');
  const offline = hit('compute_offline');
  const ads = hit('ads');

  // Внешние эндпоинты: хосты из строк, за вычетом инфраструктурных.
  const hosts = new Set();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]{4,80})/gi)) {
    const host = m[1].toLowerCase().replace(/^www\./, '');
    if (!host.includes('.')) continue;
    if (cfg.infra_hosts.some((h) => host === h || host.endsWith('.' + h))) continue;
    hosts.add(host);
  }
  return { attribution, paywall, offline, ads, hosts: [...hosts] };
}

// res/values-de/, res/values-pt-rBR/ -> локали
function localesOf(entries) {
  const set = new Set();
  for (const e of entries) {
    const m = e.name.match(/^res\/values-([a-z]{2}(?:-r[A-Z]{2})?)\//);
    if (m) set.add(m[1]);
  }
  return [...set].sort();
}

export function analyzeFile(filePath, cfg) {
  const base = path.basename(filePath).replace(/\.apk$/i, '');
  const sep = base.lastIndexOf('_');
  const appId = sep > 0 ? base.slice(0, sep) : base;
  const version = sep > 0 ? base.slice(sep + 1) : null;

  const { buf, entries } = listEntries(filePath);
  const dexEntries = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  if (!dexEntries.length) throw new Error('в архиве нет classes.dex');

  const agg = { attribution: new Set(), paywall: new Set(), offline: new Set(), ads: new Set(), hosts: new Set() };
  for (const e of dexEntries) {
    const r = scanDex(readEntry(buf, e), cfg);
    for (const k of ['attribution', 'paywall', 'offline', 'ads']) r[k].forEach((v) => agg[k].add(v));
    r.hosts.forEach((v) => agg.hosts.add(v));
  }

  const locales = localesOf(entries);
  const computeLocation = agg.offline.size ? 'offline' : (agg.hosts.size ? 'api' : null);

  return {
    app_id: appId,
    version,
    file_name: path.basename(filePath),
    attribution_sdk: agg.attribution.size ? 1 : 0,
    attribution_list: [...agg.attribution].join(', ') || null,
    paywall_sdk: [...agg.paywall].join(', ') || null,
    compute_location: computeLocation,
    ad_sdks: [...agg.ads].join(', ') || null,
    size_mb_apk: fs.statSync(filePath).size / 1048576,
    locales_apk: locales.length || null,
    locales_apk_list: locales.join(',') || null,
    // iap_products_count и has_annual_tier — по-прежнему вручную из строк пейволла
    // или карточки продуктов; до заполнения работает прокси iap_max_usd >= 20 $.
    iap_products_count: null,
    has_annual_tier: null,
    note: agg.hosts.size ? `внешних хостов: ${agg.hosts.size}` : null,
  };
}

export async function run({ geo, date, runId, cycle = 'discovery' }) {
  const d = db();
  startRun(runId, 'analyze-apk', geo, cycle, date);
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  const files = fs.readdirSync(IMPORT_DIR).filter((f) => f.toLowerCase().endsWith('.apk'));

  if (!files.length) {
    finishRun(runId, 'analyze-apk', geo, { status: 'skipped', notes: 'в apk-import/ нет файлов' });
    log(`  APK: в apk-import/ нет файлов. Положите <package>_<version>.apk — уровень A, десяток в неделю.`);
    return { files: 0 };
  }

  const cfg = prefixes();
  const ins = d.prepare(`INSERT OR REPLACE INTO raw_apk
    (app_id, version, checked_at, file_name, attribution_sdk, attribution_list, paywall_sdk,
     compute_location, ad_sdks, size_mb_apk, locales_apk, locales_apk_list,
     iap_products_count, has_annual_tier, note)
    VALUES (@app_id,@version,@checked_at,@file_name,@attribution_sdk,@attribution_list,@paywall_sdk,
     @compute_location,@ad_sdks,@size_mb_apk,@locales_apk,@locales_apk_list,
     @iap_products_count,@has_annual_tier,@note)`);
  const insLabel = d.prepare(`INSERT OR REPLACE INTO organic_labels (app_id, label, evidence, labeled_at, note) VALUES (?,?,?,?,?)`);

  let done = 0, buys = 0, errors = 0;
  for (const f of files) {
    try {
      const r = analyzeFile(path.join(IMPORT_DIR, f), cfg);
      r.checked_at = date;
      d.transaction(() => {
        ins.run(r);
        // SDK атрибуции — прямой признак закупки: органическому одиночке трекер не нужен.
        insLabel.run(r.app_id, r.attribution_sdk ? 'buys' : 'organic', 'apk', date,
          r.attribution_sdk ? `атрибуция: ${r.attribution_list}` : 'SDK атрибуции не найден');
      })();
      if (r.attribution_sdk) {
        buys++;
        logEvent('apk_attribution_sdk', { date, appId: r.app_id, detail: r.attribution_list });
      }
      log(`  ${r.app_id} ${r.version || ''}: атрибуция ${r.attribution_list || 'нет'} · пейволл ${r.paywall_sdk || 'нет'} · ` +
          `вычисление ${r.compute_location || '—'} · реклама ${r.ad_sdks || 'нет'} · локалей ${r.locales_apk ?? '—'} · ${r.size_mb_apk.toFixed(1)} МБ`);
      done++;
    } catch (e) {
      errors++;
      warn(`APK ${f}: ${e.message}`);
    }
  }

  finishRun(runId, 'analyze-apk', geo, { requests: 0, errors, notes: `${done} файлов, атрибуция найдена у ${buys}` });
  log(`  APK: разобрано ${done}, с SDK атрибуции ${buys}, ошибок ${errors}`);
  return { files: done, buys, errors };
}
