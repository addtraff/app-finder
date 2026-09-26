#!/usr/bin/env node
// Состояние системы одной командой: node tools/health.js
//
// Появилось после 26.09, когда дневной обход оборвался, задача Windows отчиталась кодом
// прерывания, и узнать об этом можно было только глазами по логам. Проверка отвечает на
// вопросы, которые до сих пор приходилось задавать вручную: прошёл ли обход, не висит ли
// мёртвый процесс, не занято ли гео, не разъехались ли даты между стадиями, влезает ли
// отчёт в свой лимит.
//
// Код возврата: 0 — всё хорошо, 1 — есть красное. Годится для задачи планировщика и для
// проверки перед публикацией отчёта.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from '../src/lib/db.js';
import { codeVersion } from '../src/lib/cycles.js';

const d = db();
const now = Date.now();
const problems = [];
const warnings = [];
const ok = [];

const hours = (iso) => (iso ? (now - Date.parse(iso)) / 3600e3 : null);
const fmtAge = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} мин.` : h < 48 ? `${h.toFixed(1)} ч.` : `${Math.round(h / 24)} дн.`);
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---------- 1. Обходы ----------
const geos = d.prepare(`SELECT DISTINCT geo FROM keyword_cores WHERE active=1 ORDER BY geo`).all().map((r) => r.geo);
const last = new Map(d.prepare(
  `SELECT geo, status, started_at, finished_at, stages_ok, stages_failed, notes FROM cycles c
    WHERE cycle='daily' AND started_at=(SELECT MAX(started_at) FROM cycles x WHERE x.geo=c.geo AND x.cycle='daily')`
).all().map((r) => [r.geo, r]));

const never = geos.filter((g) => !last.has(g));
const failed = [...last.values()].filter((r) => r.status === 'failed' || r.status === 'interrupted');
const stale = [...last.values()].filter((r) => r.status === 'ok' && hours(r.finished_at) > 36);

if (never.length === geos.length) {
  warnings.push(`учёт обходов пуст: ни одного прохода не записано. Это нормально ровно один раз — до первого обхода после 27.09.`);
} else if (never.length) {
  warnings.push(`нет записи об обходе по гео: ${never.join(', ')}`);
}
if (failed.length) problems.push(`обход не дошёл до конца по гео: ${failed.map((r) => `${r.geo} (${r.status}, стадий упало ${r.stages_failed})`).join(', ')}`);
if (stale.length) problems.push(`последний успешный обход старше 36 часов: ${stale.map((r) => `${r.geo} — ${fmtAge(hours(r.finished_at))} назад`).join(', ')}`);
if (last.size && !failed.length && !stale.length) {
  const freshest = [...last.values()].sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || ''))[0];
  ok.push(`обходы закрыты штатно, свежайший — ${freshest.geo} ${fmtAge(hours(freshest.finished_at))} назад`);
}

// ---------- 2. Висящие процессы ----------
const running = d.prepare(`SELECT * FROM cycles WHERE status='running'`).all();
const zombies = running.filter((r) => !alive(r.pid));
const live = running.filter((r) => alive(r.pid));
if (zombies.length) problems.push(`обходов записано работающими, но процессов нет: ${zombies.length} (будут помечены прерванными при следующем запуске cli)`);
const head = codeVersion();
const oldCode = live.filter((r) => head && r.code_version && r.code_version !== head);
if (oldCode.length) warnings.push(`работают обходы со старым кодом: ${oldCode.map((r) => `${r.geo} (${r.code_version}, сейчас ${head})`).join(', ')} — их результат перезапишет свежий пересчёт`);
if (live.length) ok.push(`сейчас идут обходы: ${live.map((r) => r.geo).join(', ')}`);

const orphanRuns = d.prepare(`SELECT COUNT(*) n FROM runs WHERE finished_at IS NULL AND started_at < datetime('now','-6 hour')`).get().n;
if (orphanRuns) warnings.push(`стадий без отметки о завершении старше 6 часов: ${orphanRuns}`);

// ---------- 3. Блокировки ----------
for (const l of d.prepare(`SELECT * FROM locks`).all()) {
  const a = alive(l.pid);
  const h = hours(l.heartbeat_at || l.acquired_at);
  if (!a) warnings.push(`блокировка ${l.name} осталась от мёртвого процесса pid ${l.pid} — снимется автоматически при следующем запуске`);
  else if (h > 6) warnings.push(`блокировка ${l.name} держится ${fmtAge(h)} процессом pid ${l.pid}`);
  else ok.push(`блокировка ${l.name}: ${l.cycle || 'процесс'} pid ${l.pid}, ${fmtAge(h)}`);
}

// ---------- 4. Согласованность дат между стадиями ----------
// Тихая ошибка 26.09: niche-doors помечает строку сегодняшним числом, а radar-v2 читает
// дату последнего снимка гео. Если это разные строки, метрика есть в базе и отсутствует
// в отчёте, и заметно это только глазами в готовом файле.
const dateMismatch = [];
for (const g of geos) {
  const D = d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_app_geo WHERE geo=?`).get(g)?.m;
  if (!D) continue;
  const r = d.prepare(`SELECT COUNT(*) n, SUM(door IS NOT NULL) d10, SUM(door3 IS NOT NULL) d3
                         FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`).get(g, D);
  if (!r.n) { dateMismatch.push(`${g}: нет ниш на ${D}`); continue; }
  if (!r.d10 || !r.d3) dateMismatch.push(`${g}: на ${D} дверь топ-10 у ${r.d10 || 0}, топ-3 у ${r.d3 || 0} из ${r.n}`);
}
if (dateMismatch.length) problems.push(`метрики ниш не попали в строку, которую читает radar-v2: ${dateMismatch.join('; ')}`);
else ok.push(`даты стадий согласованы по всем ${geos.length} гео`);

// ---------- 5. Отчёты ----------
const LIMIT_MB = 16;
for (const [f, limited] of [['out/appradar2-artifact.html', true], ['out/appradar2.html', false], ['out/appradar3.html', false]]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { warnings.push(`нет файла ${f}`); continue; }
  const st = fs.statSync(p);
  const mb = st.size / 1048576, age = hours(st.mtime.toISOString());
  if (limited && mb > LIMIT_MB) problems.push(`${f} — ${mb.toFixed(1)} МБ при лимите артефакта ${LIMIT_MB} МБ: отсечка строк уже не достигает своей цели`);
  // Незаполненная метка шаблона: файл записан, весит правильно и при этом не открывается.
  // Так выглядел отчёт, собранный 27.09 в 00:37 процессом со старым кодом.
  // Читается файл целиком: метка может стоять и в конце, за встроенными данными. Двадцать
  // мегабайт читаются за десятки миллисекунд, а проверка должна быть надёжной, а не быстрой.
  const marker = fs.readFileSync(p, 'utf8').match(/__[A-Z][A-Z0-9_]+__/);
  if (marker) problems.push(`${f} собран не до конца: в нём осталась метка шаблона ${marker[0]} — страница не откроется, нужна пересборка`);
  if (age > 36) warnings.push(`${f} собран ${fmtAge(age)} назад`);
  if (!(limited && mb > LIMIT_MB) && age <= 36) ok.push(`${f}: ${mb.toFixed(1)} МБ, собран ${fmtAge(age)} назад`);
}

// ---------- вывод ----------
const line = (s) => console.log(s);
line('');
if (problems.length) { line('КРАСНОЕ'); for (const p of problems) line('  ✗ ' + p); line(''); }
if (warnings.length) { line('ВНИМАНИЕ'); for (const w of warnings) line('  ! ' + w); line(''); }
if (ok.length) { line('В ПОРЯДКЕ'); for (const o of ok) line('  · ' + o); line(''); }
line(problems.length ? `итог: проблем ${problems.length}, предупреждений ${warnings.length}` : `итог: проблем нет${warnings.length ? `, предупреждений ${warnings.length}` : ''}`);
process.exit(problems.length ? 1 : 0);
