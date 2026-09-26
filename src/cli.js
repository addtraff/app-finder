#!/usr/bin/env node
// K0. Оркестратор. Гео параллельно (на своих VPS), внутри гео — последовательно.
// Обход и обновление по одному гео не пересекаются.
import fs from 'node:fs';
import { db, logEvent } from './lib/db.js';
import { syncRegistry, activeGeos, config } from './lib/config.js';
import { setRpm, stats, CaptchaStop } from './lib/play.js';
import { todayUTC, md5, log, warn } from './lib/util.js';
import { planForDays, dueToday, maturity, pendingWork } from './lib/schedule.js';

import * as collectCharts from './stages/collect-charts.js';
import * as harvestKeywords from './stages/harvest-keywords.js';
import * as keywordSerp from './stages/keyword-serp.js';
import * as enrichApps from './stages/enrich-apps.js';
import * as enrichReviews from './stages/enrich-reviews.js';
import * as enrichDeveloper from './stages/enrich-developer.js';
import * as enrichPermissions from './stages/enrich-permissions.js';
import * as similarGraph from './stages/similar-graph.js';
import * as screen from './stages/screen.js';
import * as nicheDoors from './stages/niche-doors.js';
import * as nicheEntries from './stages/niche-entries.js';
import * as analyzePain from './stages/analyze-pain.js';
import * as quantiles from './stages/quantiles.js';
import * as score from './stages/score.js';
import * as dashboard from './stages/dashboard.js';
import * as exportSheets from './stages/export.js';
import * as checkAds from './stages/check-ads.js';
import * as alerts from './stages/alerts.js';
import * as analyzeApk from './stages/analyze-apk.js';
import * as analyzeTracking from './stages/analyze-tracking.js';
import * as methodologyReport from './stages/methodology-report.js';
import * as appradar from './stages/appradar.js';
import * as radarV2 from './stages/radar-v2.js';
import * as appradar2 from './stages/appradar2.js';
import * as appradar3 from './stages/appradar3.js';
import * as analyzeUbt from './stages/analyze-ubt.js';
import * as predictLog from './stages/predict-log.js';

const STAGES = {
  'collect-charts': collectCharts,
  'harvest-keywords': harvestKeywords,
  'keyword-serp': keywordSerp,
  'enrich-apps': enrichApps,
  'enrich-reviews': enrichReviews,
  'enrich-developer': enrichDeveloper,
  'enrich-permissions': enrichPermissions,
  'similar-graph': similarGraph,
  'screen': screen,
  'niche-doors': nicheDoors,
  'niche-entries': nicheEntries,
  'analyze-pain': analyzePain,
  'quantiles': quantiles,
  'score': score,
  'dashboard': dashboard,
  'export': exportSheets,
  'check-ads': checkAds,
  'alerts': alerts,
  'analyze-apk': analyzeApk,           // ручной путь: реальный разбор скачанного APK
  'analyze-tracking': analyzeTracking, // автоматический: то же самое по тексту, без скачивания
  'methodology': methodologyReport,     // второй отчёт: разрез по слоям методики, вкладками
  'appradar': appradar,                 // третий отчёт: те же данные в оформлении AppRadar
  'radar-v2': radarV2,                  // методика v2.0: свобода, ёмкость, чистота, семь проверок
  'appradar2': appradar2,               // отчёт AppRadar 2 по методике v2.0 (все гео сразу)
  'appradar3': appradar3,               // отчёт AppRadar 3: «стоит ли повторять» (docs/tz-appradar-3.md)
  'analyze-ubt': analyzeUbt,            // признаки УБТ в отзывах: соцсети, видео, блогеры
  'predict-log': predictLog,            // журнал предсказаний: что мы выдали сегодня и что из этого вышло
};

function csvLines(text) {
  const LF = String.fromCharCode(10), CR = String.fromCharCode(13);
  return text.split(LF).map((l) => l.split(CR).join('')).filter(Boolean);
}
function csvCells(line) {
  return line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

function applyRpm() {
  const rpm = config().budget.rpm || {};
  for (const [k, v] of Object.entries(rpm)) setRpm(k, v);
}

// Полный обход по гео: дешёвое раньше дорогого.
const DISCOVERY = [
  ['collect-charts', {}],
  ['harvest-keywords', { withNgrams: false }],
  ['keyword-serp', {}],
  ['enrich-apps', {}],
  ['harvest-keywords', { withNgrams: true }],
  ['keyword-serp', {}],
  ['similar-graph', {}],
  ['quantiles', { scope: 'geo' }],
  ['screen', {}],
  ['enrich-permissions', {}],
  ['screen', {}],
  ['enrich-developer', {}],
  ['niche-doors', {}],
  ['enrich-reviews', {}],
  ['analyze-pain', {}],
  ['analyze-ubt', {}],
  ['analyze-tracking', {}],
  ['score', {}],
  ['quantiles', { scope: 'niche' }],
  ['score', {}],
  ['check-ads', {}],
  // Третий score — после check-ads: иначе находки K7 и Meta попадают в ads_found только
  // на следующие сутки, и отчёт этого дня показывает их как unchecked.
  ['score', {}],
  ['niche-entries', {}],
  ['radar-v2', {}],
  // Отчёты: только AppRadar 2 (решение заказчика 22.09). Play Market Radar, Методика и
  // AppRadar заморожены — стадии dashboard, methodology, appradar запускаются лишь вручную.
  ['appradar2', {}],
  ['export', {}],
  ['alerts', {}],
];

// Лёгкий обход: первый проход по новому гео. Без второго раунда n-грамм и графа похожих —
// они удваивают стоимость, а на пустом гео дают мало.
const LIGHT_DISCOVERY = [
  ['collect-charts', {}],
  ['harvest-keywords', { withNgrams: false }],
  ['keyword-serp', {}],
  ['enrich-apps', {}],
  ['quantiles', { scope: 'geo' }],
  ['screen', {}],
  ['enrich-permissions', {}],
  ['screen', {}],
  ['niche-doors', {}],
  ['enrich-reviews', {}],
  ['analyze-pain', {}],
  ['analyze-ubt', {}],
  ['analyze-tracking', {}],
  ['score', {}],
  ['quantiles', { scope: 'niche' }],
  ['score', {}],
];

// Ежедневное обновление: пересъёмка реестра.
const DAILY = [
  ['enrich-apps', {}],
  ['keyword-serp', {}],
  ['enrich-reviews', {}],
  ['collect-charts', {}],
  ['quantiles', { scope: 'geo' }],
  // Воронка была только в полном обходе, и вердикты старели: отчёты соединяют метрики дня с
  // последним вердиктом не позже этого дня, а для снятых сегодня карточек его просто не было.
  ['screen', {}],
  ['niche-doors', {}],
  ['analyze-pain', {}],
  ['analyze-ubt', {}],
  ['analyze-tracking', {}],
  ['score', {}],
  ['quantiles', { scope: 'niche' }],
  ['score', {}],
  ['check-ads', {}],
  // Третий score — после check-ads: иначе находки K7 и Meta попадают в ads_found только
  // на следующие сутки, и отчёт этого дня показывает их как unchecked.
  ['score', {}],
  ['niche-entries', {}],
  ['radar-v2', {}],
  // Отчёты: только AppRadar 2 (решение заказчика 22.09). Play Market Radar, Методика и
  // AppRadar заморожены — стадии dashboard, methodology, appradar запускаются лишь вручную.
  ['appradar2', {}],
  ['export', {}],
  ['alerts', {}],
];

async function runPipeline(plan, { geo, date, cycle, only = null, force = false }) {
  const runId = `${date}-${geo}-${cycle}-${md5(String(Date.now())).slice(0, 6)}`;
  log(`=== ${cycle} ${geo} ${date}${force ? ' --force' : ''} (run ${runId}) ===`);
  for (const [name, opts] of plan) {
    if (only && name !== only) continue;
    const stage = STAGES[name];
    if (!stage) { warn(`нет стадии ${name}`); continue; }
    log(`-> ${name}`);
    try {
      await stage.run({ geo, date, runId, cycle, force, ...opts });
    } catch (e) {
      if (e instanceof CaptchaStop) {
        logEvent('captcha_stop', { date, geo, detail: e.message });
        warn(`СТОП: ${e.message}`);
        break;
      }
      warn(`стадия ${name} упала: ${e.message}`);
      if (process.env.RADAR_DEBUG) console.error(e);
    }
  }
  log(`=== запросов: ${JSON.stringify(stats())}`);
  return runId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  const date = args.date || todayUTC();
  db();
  syncRegistry();
  applyRpm();

  const geos = args.geo ? String(args.geo).split(',') : activeGeos().map((g) => g.geo);

  switch (cmd) {
    case 'init': {
      log(`база: ${(await import('./lib/db.js')).DB_PATH}`);
      log(`активные гео: ${activeGeos().map((g) => g.geo).join(', ') || '(нет)'}`);
      log('реестр синхронизирован из config/');
      break;
    }

    case 'discover': {
      const plan = args.light ? LIGHT_DISCOVERY : DISCOVERY;
      for (const geo of geos) await runPipeline(plan, { geo, date: args.date || todayUTC(), cycle: 'discovery', only: args.stage || null, force: !!args.force });
      break;
    }

    case 'daily':
      // --force: снимает недельное/трёхдневное/тридцатидневное окно C/D-уровня и берёт
      // всех сразу, а не по расписанию — используется для разового полного прогона.
      // Дата берётся в момент старта каждого гео, а не один раз на весь прогон: проход по
      // 30 гео идёт больше суток, и гео, снятое 20-го, записывалось снимком 15-го — это
      // сдвигало окна 7/14/30 дней и прирост установок.
      for (const geo of geos) await runPipeline(DAILY, { geo, date: args.date || todayUTC(), cycle: 'daily', only: args.stage || null, force: !!args.force });
      break;

    case 'stage': {
      const name = args._[1];
      if (!STAGES[name]) { warn(`неизвестная стадия: ${name}. Есть: ${Object.keys(STAGES).join(', ')}`); process.exit(1); }
      const runId = `${date}-manual-${md5(String(Date.now())).slice(0, 6)}`;
      for (const geo of geos) {
        log(`-> ${name} (${geo})`);
        await STAGES[name].run({
          geo, date, runId, cycle: args.cycle || 'discovery',
          scope: args.scope, limit: args.limit ? Number(args.limit) : null,
          withNgrams: args.ngrams !== 'no' && args.ngrams !== false,
          force: !!args.force, useBrowser: args.browser !== 'no',
          headless: args.headless === true || args.headless === 'yes',
          sequential: args.sequential === true || args.sequential === 'yes',
          domains: args.domains || null, apps: args.apps || null,
          skipMeta: args['skip-meta'] === true || args['skip-meta'] === 'yes',
          skipGoogle: args['skip-google'] === true || args['skip-google'] === 'yes',
          calibrateOnly: args.calibrate === true || args.calibrate === 'yes',
        });
      }
      break;
    }

    // Ручной гейт policy_ok (проверка №6) — по умолчанию НЕ пройден.
    case 'set-policy': {
      const appId = args.app, ok = String(args.ok) === '1';
      db().prepare(`INSERT OR REPLACE INTO organic_labels (app_id, label, evidence, labeled_at, note)
                    VALUES (?,?,'policy',?,?)`).run(appId, ok ? 'policy_ok' : 'policy_fail', date, args.note || null);
      log(`policy_ok(${appId}) = ${ok ? 1 : 0}`);
      break;
    }

    // Внесение результата K7 вручную. Пустой результат = «не найдено», не «органика».
    case 'record-ads': {
      const src = args.source, found = String(args.found) === '1' ? 1 : 0;
      if (src === 'google') {
        db().prepare(`INSERT OR REPLACE INTO raw_ads_google (developer_domain, checked_at, creatives_found, count, note) VALUES (?,?,?,?,?)`)
          .run(args.domain, date, found, args.count ? Number(args.count) : null, args.note || 'вручную');
      } else if (src === 'meta') {
        db().prepare(`INSERT OR REPLACE INTO raw_ads_meta (app_id, query, checked_at, found_by_package_id, ad_count, note) VALUES (?,?,?,?,?,?)`)
          .run(args.app, args.query || null, date, found, args.count ? Number(args.count) : null, args.note || 'вручную');
      } else { warn('--source google|meta'); process.exit(1); }
      if (args.app) {
        db().prepare(`INSERT OR REPLACE INTO organic_labels (app_id, label, evidence, labeled_at, note) VALUES (?,?,?,?,?)`)
          .run(args.app, found ? 'buys' : 'organic', src, date, 'K7');
      }
      log('записано');
      break;
    }

    // Что положено делать сегодня и что стоит в очереди. Отчёт показывает то же самое.
    case 'plan': {
      const due = dueToday(date);
      log(`план на ${date}:`);
      const kinds = {
        daily: 'ежедневное обновление', full_crawl: 'полный обход',
        light_crawl: 'облегчённый обход (D1 + D2 по существующему ядру)',
        k7_a: 'K7 по уровню A', k7_b: 'K7 по уровню B', monthly: 'месячная задача',
      };
      for (const [kind, items] of Object.entries(due)) {
        const what = items.map((i) => i.geo || i.title || '').filter(Boolean).join(', ');
        log(`  ${kinds[kind] || kind}${what ? ': ' + what : ''}`);
      }
      for (const geo of geos) {
        const m = maturity(geo, date);
        if (m.first_date) {
          const next = m.stages.find((s2) => !s2.available);
          log(`  ${geo}: наблюдение ${m.elapsed} дн. (${m.snapshots} снимков)` +
              (next ? `, следующая ступень «${next.title}» — ${next.eta}` : ', все ступени доступны'));
        }
        const pend = pendingWork(geo, date).filter((p2) => p2.count > 0);
        for (const p2 of pend) log(`    осталось: ${p2.title} — ${p2.count}  (${p2.cmd})`);
        if (!pend.length) log(`    осталось: ничего, день закрыт`);
      }
      const week = planForDays(date, 7).slice(1);
      log('ближайшие 7 дней:');
      for (const day of week) {
        const notable = day.items.filter((i) => i.kind !== 'daily')
          .map((i) => `${kinds[i.kind] || i.kind}${i.geo ? ' ' + i.geo : ''}`);
        log(`  ${day.date}: ежедневное обновление${notable.length ? ' + ' + notable.join(', ') : ''}`);
      }
      break;
    }

    // C1 (дополнение): пакетное подтверждение policy_ok через CSV модуля E7.
    // Выгрузка — лист out/export/e7-политики.csv, где policy_auto_ok=1 стоят сверху.
    case 'import-policy': {
      const file = args.file;
      if (!file) { warn('нужен --file <csv>: колонки app_id, policy_ok'); process.exit(1); }
      const text = csvLines(fs.readFileSync(file, 'utf8'));
      const head = text[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
      const iApp = head.indexOf('app_id'), iOk = head.indexOf('policy_ok');
      if (iApp < 0 || iOk < 0) { warn('в CSV нужны колонки app_id и policy_ok'); process.exit(1); }
      const ins = db().prepare(`INSERT OR REPLACE INTO organic_labels (app_id, label, evidence, labeled_at, note) VALUES (?,?,'policy',?,?)`);
      let ok = 0, fail = 0;
      db().transaction(() => {
        for (const line of text.slice(1)) {
          const cells = csvCells(line);
          const appId = cells[iApp], v = cells[iOk];
          if (!appId || v === '') continue;
          const passed = v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'да';
          ins.run(appId, passed ? 'policy_ok' : 'policy_fail', date, 'E7, пакетно');
          passed ? ok++ : fail++;
        }
      })();
      log(`policy_ok проставлен: пройдено ${ok}, отклонено ${fail}. Пересчитайте score.`);
      break;
    }

    // C2: квартальные выгрузки E1 и E2.
    case 'import-planner': {
      if (!args.file) { warn('нужен --file <csv>: колонки keyword, geo, avg_monthly_searches'); process.exit(1); }
      const lines = csvLines(fs.readFileSync(args.file, 'utf8'));
      const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
      const iK = head.indexOf('keyword'), iG = head.indexOf('geo'), iV = head.findIndex((h) => h.includes('search'));
      const ins = db().prepare(`INSERT OR REPLACE INTO raw_external_keyword_planner (geo, keyword, avg_monthly_searches, imported_at) VALUES (?,?,?,?)`);
      let n = 0;
      db().transaction(() => {
        for (const line of lines.slice(1)) {
          const c = csvCells(line);
          if (!c[iK]) continue;
          ins.run((c[iG] || 'US').toUpperCase(), c[iK].toLowerCase(), Number(String(c[iV] || '').replace(/[^0-9]/g, '')) || null, date);
          n++;
        }
      })();
      log(`Keyword Planner: ${n} строк`);
      break;
    }

    case 'import-trends': {
      if (!args.file) { warn('нужен --file <csv>: колонки date, geo, keyword, value'); process.exit(1); }
      const lines = csvLines(fs.readFileSync(args.file, 'utf8'));
      const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
      const iD = head.indexOf('date'), iG = head.indexOf('geo'), iK = head.indexOf('keyword'), iV = head.indexOf('value');
      const ins = db().prepare(`INSERT OR REPLACE INTO raw_external_trends (geo, keyword, point_date, value, imported_at) VALUES (?,?,?,?,?)`);
      let n = 0;
      db().transaction(() => {
        for (const line of lines.slice(1)) {
          const c = csvCells(line);
          if (!c[iK] || !c[iD]) continue;
          ins.run((c[iG] || 'US').toUpperCase(), c[iK].toLowerCase(), c[iD], Number(c[iV]) || null, date);
          n++;
        }
      })();
      log(`Google Trends: ${n} точек`);
      break;
    }

    case 'status': {
      const d = db();
      const q = (sql, ...p) => d.prepare(sql).get(...p);
      log(`приложений в реестре: ${q('SELECT COUNT(*) c FROM apps').c}`);
      log(`  наблюдение A/B: ${q("SELECT COUNT(*) c FROM apps WHERE watch_level IN ('A','B')").c}`);
      log(`  фон C: ${q("SELECT COUNT(*) c FROM apps WHERE watch_level='C'").c}`);
      log(`  отвал D: ${q("SELECT COUNT(*) c FROM apps WHERE watch_level='D'").c}`);
      log(`ключей: ${q('SELECT COUNT(*) c FROM disc_keywords').c}, снимков выдачи: ${q('SELECT COUNT(*) c FROM raw_search').c}`);
      log(`карточек: ${q('SELECT COUNT(*) c FROM raw_app_page').c}, отзывов: ${q('SELECT COUNT(*) c FROM raw_reviews').c}`);
      log(`ниш: ${q('SELECT COUNT(DISTINCT niche_id) c FROM metrics_niche_geo').c}, метрик: ${q('SELECT COUNT(*) c FROM metrics_app_geo').c}`);
      log(`событий: ${q('SELECT COUNT(*) c FROM events').c}`);
      const days = d.prepare(`SELECT snapshot_date, COUNT(*) c FROM raw_app_page GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 7`).all();
      for (const r of days) log(`  ${r.snapshot_date}: ${r.c} карточек`);
      break;
    }

    default:
      console.log(`play-radar — конвейер стадий поверх одной базы SQLite

  node src/cli.js init                          синхронизировать реестр из config/
  node src/cli.js discover [--geo US] [--light] полный обход по гео (--light: первый проход)
  node src/cli.js daily    [--geo US]           ежедневное обновление
  node src/cli.js stage <имя> [--geo US] [--scope geo|niche] [--limit N] [--force]
  node src/cli.js status                        что накоплено в базе
  node src/cli.js plan   [--geo US]             что положено сделать сегодня и что осталось
  node src/cli.js set-policy --app <id> --ok 1  ручной гейт policy_ok (проверка №6)
  node src/cli.js import-policy  --file e7.csv  пакетное подтверждение policy_ok (модуль E7)
  node src/cli.js import-planner --file kp.csv  выгрузка Keyword Planner (E1)
  node src/cli.js import-trends  --file gt.csv  выгрузка Google Trends (E2)
  node src/cli.js stage check-ads --geo US [--limit 90] [--sequential] [--domains a.com,b.com]
  node src/cli.js stage check-ads --geo US --calibrate   снять форму RPC-запроса со страницы
  node src/cli.js record-ads --source meta --app <id> --found 1
  node src/cli.js record-ads --source google --domain example.com --found 0

Стадии: ${Object.keys(STAGES).join(' · ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
