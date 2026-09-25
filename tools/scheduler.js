// Расписание сборов на несколько суток (решение заказчика 18.09: «все сборы, которых не хватает»).
//   K7 по топ-10 ключей ядра — пачками по 10 доменов на гео в 07:30, 15:30 и 23:30:
//     ~900 доменов в сутки, больше Google начинает блокировать по IP;
//   дневной проход по 30 гео — в 15:00 (решение заказчика 25.09), в 3 параллельных потока;
//     время меняется ключом --daily-at=ЧЧ:ММ, пересобирать код для этого не нужно;
//   после дневного прохода — Google по имени для новых кандидатов, разметка УБТ, слой v2,
//     английские названия, отчёты для артефактов и полные — в out/full.
//
// Моменты считаются ОДИН раз от даты запуска и дальше не пересчитываются: раньше следующий
// момент брался от времени окончания предыдущего этапа, и проход, закончившийся в 17:01,
// сдвигал следующий на послезавтра — сутки 20.09 так и выпали. Пропускаются только моменты,
// прошедшие ДО запуска расписания: если этап затянулся и перекрыл следующий момент (проход
// 20.09 закончился в 03:23 и съел момент 03:05), просроченный запускается сразу, а не через
// сутки. Запустить этап немедленно — ключ --now=daily,k7.
//   node tools/scheduler.js [--days=3] [--now=daily,k7] [--daily-at=15:00]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = path.join(ROOT, 'logs');
const LOG = path.join(LOGS, 'scheduler.log');
const stamp = () => new Date().toLocaleString('sv-SE').replace(' ', 'T');
const log = (m) => fs.appendFileSync(LOG, `${stamp()} ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${def}`).slice(name.length + 3);
const DAYS = Number(arg('days', 3));
const NOW = new Set(arg('now', '').split(',').filter(Boolean));
// Час дневного прохода. Проход идёт около пятнадцати часов, поэтому старт в 15:00 означает
// окончание под утро — это и есть замысел: отчёты готовы к началу рабочего дня.
const [DH, DM] = arg('daily-at', '15:00').split(':').map(Number);

const START = Date.now();
const BASE = new Date(); BASE.setHours(0, 0, 0, 0);
const at = (dayOffset, hh, mm) => new Date(BASE.getTime() + dayOffset * 86400000 + (hh * 60 + mm) * 60000);
async function until(t, label) {
  if (Date.now() >= t.getTime()) return false;
  log(`${label}: жду до ${t.toLocaleString('sv-SE')}`);
  while (Date.now() < t.getTime()) await sleep(Math.min(60000, t.getTime() - Date.now()));
  return true;
}

function run(name, args, env = {}) {
  return new Promise((resolve) => {
    const out = fs.openSync(path.join(LOGS, `${name}.log`), 'a');
    const t0 = Date.now();
    log(`${name}: старт node ${args.join(' ')}`);
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', out, out], windowsHide: true });
    p.on('exit', (code) => { log(`${name}: выход ${code} за ${Math.round((Date.now() - t0) / 60000)} мин`); resolve(code); });
    p.on('error', (e) => { log(`${name}: ошибка запуска ${e.message}`); resolve(-1); });
  });
}

const ALL = ['US', 'AU', 'GB', 'CA', 'DE', 'JP', 'FR', 'KR', 'CH', 'NL', 'SE', 'NO', 'DK', 'FI', 'NZ', 'AT', 'BE', 'IE', 'SG', 'AE', 'IL', 'IT', 'ES', 'SA', 'PT', 'BR', 'TW', 'PL', 'MX', 'TR'];
const LANES = [['US', 'GB', 'JP', 'CH', 'NO', 'FI', 'IE', 'IL', 'SA', 'TW'], ['AU', 'CA', 'FR', 'NL', 'DK', 'NZ', 'SG', 'IT', 'PT', 'PL'], ['DE', 'KR', 'SE', 'AT', 'BE', 'AE', 'ES', 'BR', 'MX', 'TR']];
const tag = (t) => `${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}`;

const k7 = (t) => run(`k7-${tag(t)}`, ['src/cli.js', 'stage', 'check-ads', '--geo', ALL.join(','), '--scope', 'core-top', '--limit', '10', '--sequential', 'yes']);

async function reports() {
  // Дорогие индексы строятся здесь: конвейер уже свободен, блокировка записи никому не мешает.
  await run('post', ['tools/ensure-indexes.js']);
  await run('post', ['src/cli.js', 'stage', 'analyze-ubt', '--geo', 'GB']);
  await run('post', ['src/cli.js', 'stage', 'radar-v2', '--geo', ALL.join(',')]);
  await run('post', ['tools/restore-en-titles.js']);
  // Журнал предсказаний пишется каждый день и сразу после radar-v2: он фиксирует порядок,
  // который отчёты покажут сегодня. Пропущенный день — дырка в будущем backtest, восполнить
  // её потом нельзя, потому что признаки пересчитаются уже другой формулой.
  await run('post', ['src/cli.js', 'stage', 'predict-log', '--geo', 'US']);
  // Живых отчётов два: AppRadar 2 и AppRadar 3 (создан 23.09). Три старых заморожены.
  await run('post', ['src/cli.js', 'stage', 'appradar2', '--geo', 'US']);
  await run('post', ['src/cli.js', 'stage', 'appradar2', '--geo', 'US'], { RADAR_REPORT_FULL: '1' });
  await run('post', ['src/cli.js', 'stage', 'appradar3', '--geo', 'US']);
  fs.writeFileSync(path.join(LOGS, 'reports.done'), stamp());
}

async function daily(t) {
  await Promise.all(LANES.map((geos, i) => run(`lane${i + 1}-${tag(t)}`, ['src/cli.js', 'daily', '--geo', geos.join(',')],
    { RADAR_BROWSER_PROFILE: path.join(ROOT, 'data', `browser-lane${i + 1}`) })));
  await run(`devname-${tag(t)}`, ['src/cli.js', 'stage', 'check-ads', '--scope', 'dev-name', '--geo', ALL.join(',')]);
  await reports();
}

const times = { daily: [], k7: [] };
for (let day = 0; day < DAYS; day++) {
  times.daily.push(at(day, DH, DM || 0));
  for (const [hh, mm] of [[7, 30], [15, 30], [23, 30]]) times.k7.push(at(day, hh, mm));
}
log(`=== расписание на ${DAYS} сут., сразу: ${[...NOW].join(',') || 'ничего'}`);
log(`дневные: ${times.daily.map((t) => t.toLocaleString('sv-SE')).join(', ')}`);
log(`K7: ${times.k7.map((t) => t.toLocaleString('sv-SE')).join(', ')}`);

const dailyChain = (async () => {
  if (NOW.has('daily')) await daily(new Date());
  for (const t of times.daily) { if (t.getTime() < START) continue; await until(t, 'дневной'); await daily(t); }
})();
const k7Chain = (async () => {
  if (NOW.has('k7')) await k7(new Date());
  for (const t of times.k7) { if (t.getTime() < START) continue; await until(t, 'K7'); await k7(t); }
})();
await Promise.all([dailyChain, k7Chain]);
log('=== расписание закончено');
