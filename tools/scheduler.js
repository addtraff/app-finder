// Расписание сборов на несколько суток (решение заказчика 18.09: «все сборы, которых не хватает»).
//   K7 по топ-10 ключей ядра — пачками по 10 доменов на гео в 23:30, 07:30 и 15:30:
//     ~900 доменов в сутки, больше Google начинает блокировать по IP;
//   дневной проход по 30 гео — в 03:05 (начало суток по UTC), в 3 параллельных потока;
//   после дневного прохода — Google по имени для новых кандидатов, разметка УБТ, слой v2,
//     английские названия, отчёты для артефактов и полные — в out/full.
//   node tools/scheduler.js [--days=3]
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
const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=3').slice(7));

const at = (dayOffset, hh, mm) => { const t = new Date(); t.setDate(t.getDate() + dayOffset); t.setHours(hh, mm, 0, 0); return t; };
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

const k7 = (tag) => run(`k7-${tag}`, ['src/cli.js', 'stage', 'check-ads', '--geo', ALL.join(','), '--scope', 'core-top', '--limit', '10', '--sequential', 'yes']);

async function reports() {
  await run('post', ['src/cli.js', 'stage', 'analyze-ubt', '--geo', 'GB']);
  await run('post', ['src/cli.js', 'stage', 'radar-v2', '--geo', ALL.join(',')]);
  await run('post', ['tools/restore-en-titles.js']);
  for (const st of ['dashboard', 'methodology', 'appradar', 'appradar2']) await run('post', ['src/cli.js', 'stage', st, '--geo', 'US']);
  for (const st of ['dashboard', 'methodology', 'appradar', 'appradar2']) await run('post', ['src/cli.js', 'stage', st, '--geo', 'US'], { RADAR_REPORT_FULL: '1' });
  fs.writeFileSync(path.join(LOGS, 'reports.done'), stamp());
}

async function daily(tag) {
  await Promise.all(LANES.map((geos, i) => run(`lane${i + 1}-${tag}`, ['src/cli.js', 'daily', '--geo', geos.join(',')],
    { RADAR_BROWSER_PROFILE: path.join(ROOT, 'data', `browser-lane${i + 1}`) })));
  await run(`devname-${tag}`, ['src/cli.js', 'stage', 'check-ads', '--scope', 'dev-name', '--geo', ALL.join(',')]);
  await reports();
}

log(`=== расписание на ${DAYS} сут.`);
const k7Chain = (async () => {
  for (let day = 0; day < DAYS; day++) {
    for (const [hh, mm] of day === 0 ? [[23, 30]] : [[7, 30], [15, 30], [23, 30]]) {
      if (await until(at(day, hh, mm), `K7 ${day}/${hh}:${mm}`) || day > 0) await k7(`${day}-${hh}${mm}`);
    }
  }
})();
const dailyChain = (async () => {
  for (let day = 1; day < DAYS; day++) {
    await until(at(day, 3, 5), `дневной +${day}`);
    const d = at(day, 0, 0);
    await daily(`${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }
})();
await Promise.all([k7Chain, dailyChain]);
log('=== расписание закончено');
