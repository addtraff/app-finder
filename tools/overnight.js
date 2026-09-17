// Ночной ускоренный сбор к первым выводам по дельте и закупке (решение заказчика 17.09).
//   A. сейчас — дневной проход по гео без снимка дня, в 3 параллельных потока;
//   B. 23:00 — пачка K7 по топ-10 ключей ядра (по 10 доменов на гео, последовательно);
//   C. 03:05 (начало суток по UTC), после A — дневной проход по всем 30 гео в 3 потока;
//   D. 09:00, после B — вторая пачка K7;
//   E. после C и D — разметка УБТ, слой v2 по всем гео, английские названия, 4 отчёта.
// Потоки — отдельные процессы: у каждого свой лимитер запросов Play (выдача 20 в минуту на
// поток, 429 у Play — от двух в секунду) и свой профиль браузера для проверки рекламы.
//   node tools/overnight.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = path.join(ROOT, 'logs');
const LOG = path.join(LOGS, 'overnight.log');
const stamp = () => new Date().toLocaleString('sv-SE').replace(' ', 'T');
const log = (m) => fs.appendFileSync(LOG, `${stamp()} ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждать до местного времени hh:mm; если оно уже прошло сегодня и after — ближайшее следующее.
async function until(hh, mm, label) {
  const now = new Date();
  const t = new Date(now); t.setHours(hh, mm, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  log(`${label}: жду до ${t.toLocaleString('sv-SE')}`);
  while (Date.now() < t.getTime()) await sleep(Math.min(60000, t.getTime() - Date.now()));
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

const lanes = (tag, groups) => Promise.all(groups.map((geos, i) => run(`lane${i + 1}-${tag}`, ['src/cli.js', 'daily', '--geo', geos.join(',')],
  { RADAR_BROWSER_PROFILE: path.join(ROOT, 'data', `browser-lane${i + 1}`) })));

const ALL = ['US', 'AU', 'GB', 'CA', 'DE', 'JP', 'FR', 'KR', 'CH', 'NL', 'SE', 'NO', 'DK', 'FI', 'NZ', 'AT', 'BE', 'IE', 'SG', 'AE', 'IL', 'IT', 'ES', 'SA', 'PT', 'BR', 'TW', 'PL', 'MX', 'TR'];
// Крупные гео разнесены по потокам: у GB, CA, DE, JP, FR, KR по 1–1,4 тыс. карточек в день.
const TONIGHT = [['GB', 'JP', 'CH', 'NO', 'FI', 'IE', 'IL'], ['CA', 'FR', 'NL', 'DK', 'NZ', 'SG', 'IT'], ['DE', 'KR', 'SE', 'AT', 'BE', 'AE']];
const TOMORROW = [['US', 'GB', 'JP', 'CH', 'NO', 'FI', 'IE', 'IL', 'SA', 'TW'], ['AU', 'CA', 'FR', 'NL', 'DK', 'NZ', 'SG', 'IT', 'PT', 'PL'], ['DE', 'KR', 'SE', 'AT', 'BE', 'AE', 'ES', 'BR', 'MX', 'TR']];
const k7 = (tag) => run(`k7-${tag}`, ['src/cli.js', 'stage', 'check-ads', '--geo', ALL.join(','), '--scope', 'core-top', '--limit', '10', '--sequential', 'yes'],
  {}); // профиль браузера по умолчанию — тот, с которым K7 уже работал

const skip = new Set((process.argv.find((a) => a.startsWith('--skip=')) || '--skip=').slice(7).split(',').filter(Boolean));
log(`=== старт, пропуск фаз: ${[...skip].join(',') || 'нет'}`);

const phaseA = skip.has('A') ? Promise.resolve() : lanes('0917', TONIGHT);
const phaseB = skip.has('B') ? Promise.resolve() : until(23, 0, 'K7-1').then(() => k7('1'));
const phaseC = phaseA.then(async () => { if (skip.has('C')) return; await until(3, 5, 'дневной 18.09'); await lanes('0918', TOMORROW); });
const phaseD = phaseB.then(async () => { if (skip.has('D')) return; await until(9, 0, 'K7-2'); await k7('2'); });

await Promise.all([phaseC, phaseD]);
log('E: пересчёт и отчёты');
await run('final', ['src/cli.js', 'stage', 'analyze-ubt', '--geo', 'GB']);
await run('final', ['src/cli.js', 'stage', 'radar-v2', '--geo', ALL.join(',')]);
await run('final', ['tools/restore-en-titles.js']);
for (const st of ['dashboard', 'methodology', 'appradar', 'appradar2']) await run('final', ['src/cli.js', 'stage', st, '--geo', 'US']);
fs.writeFileSync(path.join(LOGS, 'overnight.done'), stamp());
log('=== готово');
