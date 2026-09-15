// Добор данных, которых не хватает четырём отчётам (Play Market Radar, Методика копирования,
// AppRadar, AppRadar 2). Два потока, чтобы не удваивать нагрузку на один сервис:
//
//   node tools/fill-gaps.js play   — Google Play, строго последовательно:
//     1) карточки топ-10 ключей ниш без карточки нигде (enrich-apps --scope core-top);
//     2) отзывы приложений воронки с < 20 отзывами на языках гео (+ разметка жалоб);
//     3) дневной проход по 30 гео, дата — в момент старта каждого гео (cli daily --geo).
//        В нём же пересчитываются ниши, score, radar-v2 и собираются все отчёты.
//
//   node tools/fill-gaps.js ads    — браузер, параллельно с play:
//     K7 и Meta по топ-10 ключей ниш (check-ads --scope core-top). Второй проход — после
//     шага 1 потока play: новые карточки дают новые домены и названия для Meta.
//     Профиль браузера — отдельный (RADAR_BROWSER_PROFILE), чтобы не делить его с check-ads
//     дневного прохода.
//
// Этап можно пропустить: --skip cards,reviews,daily (play) или --skip pass1 (ads).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, ROOT } from '../src/lib/db.js';
import { config, syncRegistry } from '../src/lib/config.js';
import { setRpm, CaptchaStop } from '../src/lib/play.js';
import { todayUTC, log, warn, sleep } from '../src/lib/util.js';
import * as enrichApps from '../src/stages/enrich-apps.js';
import * as enrichReviews from '../src/stages/enrich-reviews.js';
import * as analyzePain from '../src/stages/analyze-pain.js';
import * as checkAds from '../src/stages/check-ads.js';

const mode = process.argv[2];
const skipArg = process.argv.indexOf('--skip');
const skip = new Set(skipArg > 0 ? String(process.argv[skipArg + 1] || '').split(',') : []);
const CARDS_DONE = path.join(ROOT, 'logs', 'fill-gaps-cards.done');

db();
syncRegistry();
for (const [k, v] of Object.entries(config().budget.rpm || {})) setRpm(k, v);
const geos = config().geos.geos.filter((g) => g.active).map((g) => g.geo);
const runId = (geo, stage) => `${todayUTC()}-${geo}-fillgaps-${stage}`;

async function stepCards() {
  let total = 0;
  for (const geo of geos) {
    try {
      const r = await enrichApps.run({ geo, date: todayUTC(), runId: runId(geo, 'cards'), cycle: 'discovery', scope: 'core-top' });
      total += r.done;
    } catch (e) {
      if (e instanceof CaptchaStop) { warn(`СТОП на карточках ${geo}: ${e.message}`); throw e; }
      warn(`карточки ${geo}: ${e.message}`);
    }
    log(`== карточки ${geo} готово, всего ${total}`);
  }
  fs.writeFileSync(CARDS_DONE, new Date().toISOString());
}

async function stepReviews() {
  for (const geo of geos) {
    try {
      await enrichReviews.run({ geo, date: todayUTC(), runId: runId(geo, 'reviews'), cycle: 'daily', scope: 'funnel' });
      await analyzePain.run({ geo, date: todayUTC(), runId: runId(geo, 'pain'), cycle: 'daily' });
    } catch (e) {
      if (e instanceof CaptchaStop) { warn(`СТОП на отзывах ${geo}: ${e.message}`); throw e; }
      warn(`отзывы ${geo}: ${e.message}`);
    }
    log(`== отзывы ${geo} готово`);
  }
}

function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('exit', (code) => resolve(code));
  });
}

async function stepDaily() {
  for (const geo of geos) {
    log(`== дневной проход ${geo} (дата ${todayUTC()})`);
    const code = await runChild(['src/cli.js', 'daily', '--geo', geo]);
    log(`== дневной проход ${geo} завершён, код ${code}`);
  }
}

// --meta-only / --google-only: когда одна из библиотек отказывает, вторую незачем ждать.
const metaOnly = process.argv.includes('--meta-only');
const googleOnly = process.argv.includes('--google-only');

async function adsPass(label) {
  for (const geo of geos) {
    try {
      await checkAds.run({ geo, date: todayUTC(), runId: runId(geo, `ads-${label}`), cycle: 'daily', scope: 'core-top',
        useBrowser: true, skipGoogle: metaOnly, skipMeta: googleOnly });
    } catch (e) {
      warn(`реклама ${geo} (${label}): ${e.message}`);
    }
    log(`== реклама ${geo} (${label}) готово`);
  }
}

if (mode === 'play') {
  if (!skip.has('cards')) await stepCards(); else fs.writeFileSync(CARDS_DONE, new Date().toISOString());
  if (!skip.has('reviews')) await stepReviews();
  if (!skip.has('daily')) await stepDaily();
  log('=== поток play завершён');
} else if (mode === 'ads') {
  if (!skip.has('pass1')) await adsPass('pass1');
  while (!fs.existsSync(CARDS_DONE)) {
    log('  жду окончания добора карточек (logs/fill-gaps-cards.done)…');
    await sleep(10 * 60 * 1000);
  }
  await adsPass('pass2');
  log('=== поток ads завершён');
} else {
  console.log('использование: node tools/fill-gaps.js play|ads [--skip cards,reviews,daily|pass1]');
  process.exit(1);
}
process.exit(0);
