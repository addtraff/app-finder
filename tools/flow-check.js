#!/usr/bin/env node
// Сверка ДВЕРИ-ПОТОКА с реальными входами: node tools/flow-check.js [--geo US,DE]
//
// Продолжение door-check.js. Там сверялась дверь-запас — накопленные установки самого
// слабого в топ-10 — и она не выдержала проверки: медианный вошедший имел в 25 раз больше,
// в дешёвых нишах в 135 раз, а удержание от расстояния до двери не зависело вовсе.
//
// Ответ на это обычно такой: запас и не должен работать, потому что установки — это то,
// что накоплено за всю жизнь, а конкурировать приходится с тем, кто получает СЕЙЧАС.
// Пятилетнее приложение с 500 тыс. установок и трёхмесячное со 100 тыс. — разные соперники.
// Отсюда дверь-поток: сколько установок в день у самого слабого в десятке.
//
// Прежде чем строить на потоке что-либо ещё, его надо проверить тем же способом. Иначе
// повторится ровно то, что уже случилось с запасом: три недели центральная метрика ошибалась
// в 25 раз, и никто этого не видел, потому что сверять было не с чем.
//
// Почему считается заново, а не берётся из базы. Во-первых, door_flow появился в
// metrics_niche_geo только 23.09, а входы идут с 09.09 — истории почти нет. Во-вторых,
// строки за 24–25.09 переписаны догоняющим проходом 27.09, и вычисленный в нём поток знает
// о данных ПОСЛЕ входа. Сравнивать вход с метрикой, которая подглядела в будущее, — это не
// проверка. Поэтому поток восстанавливается из сырых снимков с жёсткой отсечкой на дату
// входа: никаких данных позже неё.
import { db } from '../src/lib/db.js';

const args = process.argv.slice(2);
const optOf = (n, def = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : def; };
const d = db();

const q = (n) => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n)));
const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '—');
const quant = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);

const geos = (optOf('geo') || d.prepare(`SELECT DISTINCT geo FROM keyword_cores WHERE active=1 ORDER BY geo`).all().map((r) => r.geo).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

// ---------- восстановление потока на дату ----------
// Формула ровно та же, что в niche-doors: прирост оценок за окно, переведённый в установки
// через «установок на оценку» у самого приложения. Отличие одно — окно обрезано датой входа.
function flowBuilder(geo) {
  const hist = new Map();
  for (const r of d.prepare(
    `SELECT app_id, snapshot_date dt, MAX(max_installs) inst, MAX(ratings_count) rc FROM raw_app_page
      WHERE geo=? AND ratings_count IS NOT NULL AND max_installs IS NOT NULL
      GROUP BY app_id, snapshot_date ORDER BY app_id, snapshot_date`
  ).all(geo)) {
    if (!hist.has(r.app_id)) hist.set(r.app_id, []);
    hist.get(r.app_id).push(r);
  }
  const cache = new Map();
  return (id, upto) => {
    const key = id + '|' + upto;
    if (cache.has(key)) return cache.get(key);
    const all = hist.get(id);
    let out = null;
    if (all) {
      const s = all.filter((x) => x.dt <= upto);
      if (s.length >= 2) {
        const a = s[0], b = s[s.length - 1];
        const days = Math.round((Date.parse(b.dt) - Date.parse(a.dt)) / 864e5);
        const dR = b.rc - a.rc;
        // Три дня — нижняя граница осмысленности: на одном-двух днях прирост оценок это шум,
        // а деление на такое окно даёт «поток», который к рынку отношения не имеет.
        if (days >= 3 && dR >= 0 && b.rc > 0) out = Math.round((dR * (b.inst / b.rc)) / days);
      }
    }
    cache.set(key, out);
    return out;
  };
}

const rows = [];
let noFlowEntrant = 0, noDoorFlow = 0;

for (const geo of geos) {
  const core = d.prepare(`SELECT niche_id, keyword FROM keyword_cores WHERE geo=? AND active=1`).all(geo);
  if (!core.length) continue;
  const kwsOfNiche = new Map();
  for (const r of core) {
    if (!kwsOfNiche.has(r.niche_id)) kwsOfNiche.set(r.niche_id, []);
    kwsOfNiche.get(r.niche_id).push(r.keyword);
  }
  // Топ-10 по ключу и дате.
  const top = new Map();
  for (const r of d.prepare(`SELECT snapshot_date dt, keyword kw, app_id FROM raw_search WHERE geo=? AND position<=10 ORDER BY position`).all(geo)) {
    const k = r.kw + '|' + r.dt;
    if (!top.has(k)) top.set(k, []);
    top.get(k).push(r.app_id);
  }
  const flowAt = flowBuilder(geo);
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

  const entries = d.prepare(
    `SELECT niche_id, app_id, entry_date, installs_at_entry inst, still_in, observed_after, days_in_top10,
            (CASE WHEN first_seen_serp > observed_from THEN 1 ELSE 0 END) fresh
       FROM niche_entries WHERE geo=?`
  ).all(geo);

  const doorCache = new Map();
  const doorFlowAt = (nid, date) => {
    const key = nid + '|' + date;
    if (doorCache.has(key)) return doorCache.get(key);
    const perKw = [];
    for (const kw of kwsOfNiche.get(nid) || []) {
      const list = top.get(kw + '|' + date);
      if (!list) continue;
      const vals = list.map((a) => flowAt(a, date)).filter((v) => v != null);
      if (vals.length >= 3) perKw.push(Math.min(...vals));
    }
    const out = perKw.length ? median(perKw) : null;
    doorCache.set(key, out);
    return out;
  };

  const stockDoor = d.prepare(
    `SELECT door FROM metrics_niche_geo WHERE geo=? AND niche_id=? AND snapshot_date<=? AND door IS NOT NULL
      ORDER BY snapshot_date DESC LIMIT 1`);

  for (const e of entries) {
    const mine = flowAt(e.app_id, e.entry_date);
    if (mine == null) { noFlowEntrant++; continue; }
    const door = doorFlowAt(e.niche_id, e.entry_date);
    if (door == null) { noDoorFlow++; continue; }
    rows.push({ geo, ...e, mine, door, stock: stockDoor.get(geo, e.niche_id, e.entry_date)?.door ?? null });
  }
}

console.log('');
console.log('СВЕРКА ДВЕРИ-ПОТОКА С РЕАЛЬНЫМИ ВХОДАМИ');
console.log('='.repeat(78));
console.log(`гео: ${geos.length}, входов с обеими величинами: ${rows.length}`);
console.log(`отброшено: у вошедшего нет оценки потока ${noFlowEntrant}, у ниши нет двери-потока на день входа ${noDoorFlow}`);
console.log('поток восстановлен из сырых снимков с отсечкой на дату входа — данных позже неё не используется');
console.log('');

if (rows.length < 100) { console.log('наблюдений слишком мало для выводов'); process.exit(0); }

// ---------- 1. Где стоят входы относительно двери-потока ----------
const withDoor = rows.filter((r) => r.door > 0);
const ratios = withDoor.map((r) => r.mine / r.door).sort((a, b) => a - b);
const below = withDoor.filter((r) => r.mine < r.door).length;
console.log('1. ОТНОШЕНИЕ «ПОТОК ВОШЕДШЕГО / ДВЕРЬ-ПОТОК НА ТОТ ДЕНЬ»');
console.log(`   наблюдений ${withDoor.length} (у остальных дверь-поток равна нулю)`);
console.log(`   p10 ×${quant(ratios, 0.1).toFixed(2)}   p25 ×${quant(ratios, 0.25).toFixed(2)}   медиана ×${quant(ratios, 0.5).toFixed(2)}   p75 ×${quant(ratios, 0.75).toFixed(1)}   p90 ×${quant(ratios, 0.9).toFixed(1)}`);
console.log(`   вошли СЛАБЕЕ двери: ${below} из ${withDoor.length} (${pct(below, withDoor.length)})`);
console.log('   У запаса медиана была ×25. Чем ближе к единице здесь — тем лучше поток');
console.log('   описывает порог входа.');
console.log('');

// ---------- 2. Калибровка ----------
console.log('2. КАЛИБРОВКА ПО ВЕЛИЧИНЕ ДВЕРИ-ПОТОКА');
console.log('   дверь-поток        входов   медиана входа   отношение   слабее двери');
for (const [lo, hi] of [[0, 10], [10, 100], [100, 1e3], [1e3, 1e4], [1e4, Infinity]]) {
  const b = withDoor.filter((r) => r.door >= lo && r.door < hi);
  if (b.length < 20) continue;
  const inst = b.map((r) => r.mine).sort((a, x) => a - x);
  const rr = b.map((r) => r.mine / r.door).sort((a, x) => a - x);
  const label = hi === Infinity ? `${q(lo)}+/дн` : `${q(lo)}–${q(hi)}/дн`;
  console.log(`   ${label.padEnd(17)} ${String(b.length).padStart(6)}   ${(q(quant(inst, 0.5)) + '/дн').padStart(13)}   ${('×' + quant(rr, 0.5).toFixed(2)).padStart(9)}   ${pct(b.filter((r) => r.mine < r.door).length, b.length).padStart(12)}`);
}
console.log('   У запаса отношение падало со ×135 до ×2,4 — метрика врала тем сильнее,');
console.log('   чем дешевле выглядела ниша. Ровная колонка здесь означала бы, что поток');
console.log('   масштабируется честно.');
console.log('');

// ---------- 3. Предсказывает ли поток удержание ----------
const judged = withDoor.filter((r) => r.observed_after >= 2);
console.log('3. УДЕРЖАНИЕ ПО РАССТОЯНИЮ ДО ДВЕРИ-ПОТОКА');
console.log(`   (только входы, у которых после них был хотя бы один снятый день: ${judged.length})`);
console.log('   вход относительно двери   входов   держатся   дней в топе (медиана)');
for (const [lo, hi, name] of [[0, 0.5, 'вдвое слабее и ниже'], [0.5, 1, 'чуть слабее'], [1, 2, 'вровень'], [2, 10, 'вдвое сильнее и выше'], [10, Infinity, 'вдесятеро сильнее']]) {
  const b = judged.filter((r) => { const x = r.mine / r.door; return x >= lo && x < hi; });
  if (b.length < 20) continue;
  const days = b.map((r) => r.days_in_top10).sort((a, x) => a - x);
  console.log(`   ${name.padEnd(24)} ${String(b.length).padStart(6)}   ${pct(b.filter((r) => r.still_in).length, b.length).padStart(8)}   ${String(quant(days, 0.5)).padStart(20)}`);
}
console.log('   Это главная проверка. У запаса колонка «держатся» была ровной (40–44%),');
console.log('   то есть метрика не предсказывала ничего. Если здесь удержание растёт слева');
console.log('   направо — поток говорит о рынке то, чего запас не говорил.');
console.log('');

// ---------- 4. Запас против потока на одних и тех же входах ----------
const both = judged.filter((r) => r.inst != null);
if (both.length >= 100) {
  console.log('4. ЗАПАС ПРОТИВ ПОТОКА НА ОДНИХ И ТЕХ ЖЕ ВХОДАХ');
  console.log(`   ${both.length} входов, у которых известны и установки, и поток`);
  const corr = (f) => {
    const a = both.map(f), s = both.map((r) => (r.still_in ? 1 : 0));
    const ma = a.reduce((x, y) => x + y, 0) / a.length, ms = s.reduce((x, y) => x + y, 0) / s.length;
    let num = 0, da = 0, ds = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = s[i] - ms; num += x * y; da += x * x; ds += y * y; }
    return da && ds ? num / Math.sqrt(da * ds) : 0;
  };
  // Логарифм отношения: сами отношения тянутся на порядки, и без него связь меряет выбросы.
  const lg = (v) => Math.log10(Math.max(1e-3, v));
  const withStock = both.filter((r) => r.stock > 0);
  if (withStock.length >= 50) {
    const c = (f) => { const saved = both.length; both.length = 0; both.push(...withStock); const v = corr(f); both.length = 0; both.push(...judged.filter((r) => r.inst != null)); return v; };
    console.log(`   связь «удержался» с расстоянием до двери-ЗАПАСА:  ${c((r) => lg(r.inst / Math.max(1, r.stock))).toFixed(3)} (${withStock.length} набл.)`);
  }
  console.log(`   связь «удержался» с расстоянием до двери-ПОТОКА:  ${corr((r) => lg(r.mine / Math.max(1, r.door))).toFixed(3)}`);
  console.log(`   связь «удержался» с самим потоком вошедшего:      ${corr((r) => lg(r.mine)).toFixed(3)}`);
  console.log(`   связь «удержался» с самими установками вошедшего: ${corr((r) => lg(r.inst)).toFixed(3)}`);
  console.log('   Значения около нуля означают, что величина об удержании ничего не знает.');
  console.log('');
}

// ---------- 5. Новички ----------
console.log('5. НОВИЧКИ НИШИ ОТДЕЛЬНО');
for (const [flag, name] of [[1, 'новички ниши'], [0, 'были в выдаче']]) {
  const b = judged.filter((r) => Number(r.fresh) === flag);
  if (b.length < 20) continue;
  const rr = b.map((r) => r.mine / r.door).sort((a, x) => a - x);
  console.log(`   ${name.padEnd(16)} входов ${String(b.length).padStart(5)}   медиана ×${quant(rr, 0.5).toFixed(2)}   слабее двери ${pct(b.filter((r) => r.mine < r.door).length, b.length)}   держатся ${pct(b.filter((r) => r.still_in).length, b.length)}`);
}
console.log('');
