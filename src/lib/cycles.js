// Учёт обходов и блокировки гео.
//
// Две беды, ради которых это написано, случились 26.09 в один день.
//
// Первая: дневной обход оборвался (код выхода задачи Windows 0xC000013A — прерывание), и
// система об этом не узнала. В таблице runs остались 33 строки со статусом «running» и
// пустым finished_at, а признака «обход прошёл целиком» не существовало вовсе: судить
// можно было только глазами по логам. Теперь у каждого прохода есть строка в cycles,
// которая закрывается явно, а незакрытые строки мёртвых процессов помечаются при старте.
//
// Вторая: ручной пересчёт и дневной обход работали по одному гео одновременно, и обход
// дважды перезаписал результат — причём своим, более старым кодом, потому что его процесс
// стартовал до правки. Теперь гео берётся под блокировку, а ручной запуск по занятому гео
// отказывается работать и объясняет, кто его держит.
//
// Живость процесса проверяется через process.kill(pid, 0): сигнал не посылается, но ядро
// отвечает, существует ли процесс. Работает и на Windows. Поэтому блокировка, оставшаяся
// от убитого процесса, снимается сразу, а не по таймауту.
import os from 'node:os';
import { execSync } from 'node:child_process';
import { db, retryBusy } from './db.js';
import { log, warn } from './util.js';

const HOST = os.hostname();
const STALE_MINUTES = 90;   // столько живёт блокировка без стука сердца, если pid проверить нельзя

// Версия кода на момент старта прохода. Нужна ровно для одного вопроса: «этот висящий
// обход работает тем же кодом, что лежит в репозитории, или более старым?»
let _ver = null;
export function codeVersion() {
  if (_ver !== null) return _ver;
  try {
    _ver = execSync('git rev-parse --short HEAD', { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { _ver = null; }
  return _ver;
}

function alive(pid, host) {
  if (host !== HOST) return true;          // чужая машина — судить не можем, считаем живым
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------- обходы ----------

export function startCycle({ runId, cycle, geo, date, stagesTotal }) {
  const d = db();
  retryBusy(() => d.prepare(
    `INSERT OR REPLACE INTO cycles
       (run_id, cycle, geo, snapshot_date, started_at, status, stages_total, stages_ok, stages_failed, pid, host, code_version)
     VALUES (?,?,?,?,?, 'running', ?, 0, 0, ?, ?, ?)`
  ).run(runId, cycle, geo, date, new Date().toISOString(), stagesTotal, process.pid, HOST, codeVersion()));
}

// Прогресс пишется по ходу, а не только в конце. Оборванный обход иначе показывает 0 из 20
// независимо от того, успел он одну стадию или девятнадцать — 28.09 три гео так и выглядели
// «ничего не сделали», хотя по журналу стадий доходили до середины.
export function progressCycle({ runId, geo, stagesOk, stagesFailed }) {
  try {
    db().prepare(`UPDATE cycles SET stages_ok=?, stages_failed=? WHERE run_id=? AND geo=?`)
      .run(stagesOk, stagesFailed, runId, geo);
  } catch { /* учёт прогресса не критичен: итог всё равно запишется в finishCycle */ }
}

export function finishCycle({ runId, geo, status = 'ok', stagesOk = 0, stagesFailed = 0, notes = null }) {
  const d = db();
  retryBusy(() => d.prepare(
    `UPDATE cycles SET finished_at=?, status=?, stages_ok=?, stages_failed=?, notes=? WHERE run_id=? AND geo=?`
  ).run(new Date().toISOString(), status, stagesOk, stagesFailed, notes, runId, geo));
}

// Уборка после смерти: проходы и стадии, чей процесс больше не существует, помечаются
// прерванными. Делается при каждом старте — так следующий запуск чинит учёт за предыдущий.
export function reapDead() {
  const d = db();
  const open = d.prepare(`SELECT run_id, geo, pid, host, started_at, stages_ok FROM cycles WHERE status='running'`).all();
  // Стучащая блокировка — прямое свидетельство жизни, и оно сильнее опроса pid. 28.09 в 21:50
  // жнец похоронил обходы JP, AT и NL по «процесс не найден», а те же pid 33128, 27008 и 17632
  // через 49 минут держали замки GB, SE и FR со свежим стуком. Почему опрос pid соврал —
  // не установлено (Windows переиспользует номера, и daily запускается не в одном экземпляре),
  // поэтому здесь не догадка о причине, а отказ хоронить того, кто на наших глазах подаёт признаки.
  const beating = new Map(d.prepare(`SELECT name, heartbeat_at, acquired_at FROM locks`).all()
    .map((l) => [l.name, Date.parse(l.heartbeat_at || l.acquired_at)]));
  const fresh = (geo) => (beating.get(`geo:${geo}`) || 0) > Date.now() - STALE_MINUTES * 60000;
  const dead = open.filter((r) => !alive(r.pid, r.host) && !fresh(r.geo));
  if (!dead.length) return { cycles: 0, runs: 0 };
  let runs = 0;
  retryBusy(() => d.transaction(() => {
    // В заметке остаётся то, что жнец видел: кто судил, сколько стадий обход успел и держал ли
    // замок. Без этого запись «процесс не найден» не отличить от «обход и не начинался».
    const upC = d.prepare(`UPDATE cycles SET status='interrupted', finished_at=?,
        notes=COALESCE(notes,'') || ' процесс не найден (судил pid ' || ? || ', стадий ' || stages_ok || '/' || stages_total || ', замок ' || ? || ')'
      WHERE run_id=? AND geo=?`);
    const upR = d.prepare(`UPDATE runs SET status='interrupted', finished_at=? WHERE run_id=? AND geo=? AND finished_at IS NULL`);
    const now = new Date().toISOString();
    for (const r of dead) { upC.run(now, process.pid, beating.has(`geo:${r.geo}`) ? 'протух' : 'не взят', r.run_id, r.geo); runs += upR.run(now, r.run_id, r.geo).changes; }
  })());
  warn(`учёт: помечено прерванными обходов ${dead.length}, стадий ${runs}`);
  return { cycles: dead.length, runs };
}

// Стадии-сироты: строки без отметки о завершении, не принадлежащие ни одному работающему
// обходу. Такие остались от запусков до появления учёта циклов и от процессов, убитых до
// 27.09. Порог в сутки выбран с запасом: самая долгая стадия (enrich-apps) идёт около часа.
export function reapOrphanRuns(hours = 24) {
  const d = db();
  const live = new Set(d.prepare(`SELECT run_id FROM cycles WHERE status='running'`).all().map((r) => r.run_id));
  const rows = d.prepare(
    `SELECT rowid, run_id FROM runs WHERE finished_at IS NULL AND started_at < datetime('now', ?)`
  ).all(`-${hours} hour`).filter((r) => !live.has(r.run_id));
  if (!rows.length) return 0;
  retryBusy(() => d.transaction(() => {
    const up = d.prepare(`UPDATE runs SET status='interrupted', finished_at=? WHERE rowid=?`);
    const now = new Date().toISOString();
    for (const r of rows) up.run(now, r.rowid);
  })());
  warn(`учёт: закрыто стадий-сирот ${rows.length} (старше ${hours} ч., без работающего обхода)`);
  return rows.length;
}

// ---------- блокировки ----------

export function acquireLock(name, { runId, cycle, force = false }) {
  const d = db();
  const cur = d.prepare(`SELECT * FROM locks WHERE name=?`).get(name);
  if (cur) {
    const fresh = Date.parse(cur.heartbeat_at || cur.acquired_at) > Date.now() - STALE_MINUTES * 60000;
    const live = alive(cur.pid, cur.host);
    if (live && fresh && !force) {
      return { ok: false, holder: cur };
    }
    if (!live || !fresh) log(`  блокировка ${name} снята: держатель ${cur.pid} не отвечает`);
  }
  retryBusy(() => d.prepare(
    `INSERT OR REPLACE INTO locks (name, run_id, cycle, pid, host, acquired_at, heartbeat_at) VALUES (?,?,?,?,?,?,?)`
  ).run(name, runId, cycle, process.pid, HOST, new Date().toISOString(), new Date().toISOString()));
  return { ok: true, holder: null };
}

export function beat(name) {
  try {
    db().prepare(`UPDATE locks SET heartbeat_at=? WHERE name=? AND pid=?`).run(new Date().toISOString(), name, process.pid);
  } catch { /* стук сердца не критичен: потеря приведёт лишь к снятию блокировки по таймауту */ }
}

export function releaseLock(name) {
  try { db().prepare(`DELETE FROM locks WHERE name=? AND pid=?`).run(name, process.pid); } catch { /* уже снята */ }
}

export function holderText(h) {
  const age = Math.round((Date.now() - Date.parse(h.acquired_at)) / 60000);
  return `${h.cycle || 'процесс'} pid ${h.pid} на ${h.host}, держит ${age} мин.`;
}

// Когда по каждому гео последний раз завершился успешный обход. Нужно порядку суточного
// прохода: он идёт больше суток, а запускается ежедневно, поэтому фиксированный порядок
// оставляет хвост списка необойдённым навсегда. Гео без единого успешного обхода получает
// ноль и идёт первым — это ровно тот случай, ради которого всё и делается.
export function lastOkCycle() {
  const rows = db().prepare(`SELECT geo, MAX(finished_at) f FROM cycles WHERE status='ok' GROUP BY geo`).all();
  return new Map(rows.map((r) => [r.geo, r.f ? Date.parse(r.f) : 0]));
}
