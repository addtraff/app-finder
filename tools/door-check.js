#!/usr/bin/env node
// Сверка двери с тем, что случилось на самом деле: node tools/door-check.js
//
// Дверь — центральная метрика проекта и единственное утверждение, которое можно проверить
// фактом. Она говорит «чтобы встать в топ-10, нужно столько установок». Таблица входов
// говорит, с чем туда вставали. Достаточно свести одно с другим.
//
// Проверяется дверь в топ-10: у неё есть история по датам, и сравнение идёт с той дверью,
// которая стояла В ДЕНЬ ВХОДА, а не с сегодняшней. Дверь в топ-3 сюда не идёт: её начали
// считать 26.09, а записи за более ранние даты проставлены догоняющим проходом по свежей
// выдаче, то есть это сегодняшнее число под вчерашней датой. Сверять по нему — значит
// сверять метрику саму с собой. История топ-3 копится с 27.09; проверка станет возможна,
// когда наберётся две недели.
//
// Три вопроса, три ответа:
//   1. Где стоят входы относительно двери — выше, вровень или сильно ниже.
//   2. Калибровка: в нишах с высокой дверью входят дороже, чем в нишах с низкой?
//   3. Смысл двери: те, кто вошёл ниже неё, удерживаются хуже — или разницы нет?
import { db } from '../src/lib/db.js';

const d = db();
const q = (n) => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n)));
const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '—');
const quant = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);

// Дверь ниши на день входа: точное совпадение даты, иначе ближайшая более ранняя. Более
// поздняя не годится принципиально — она знает про сам вход и уже им сдвинута.
const rows = d.prepare(`
  SELECT e.geo, e.niche_id, e.app_id, e.entry_date, e.installs_at_entry AS inst,
         e.still_in, e.observed_after, e.days_in_top10,
         -- Новичок ниши: в выдаче этой ниши его не было в первый день окна. Флаг не хранится,
         -- он выводится из тех же полей, что и в отчёте, — одно определение на оба места.
         (CASE WHEN e.first_seen_serp > e.observed_from THEN 1 ELSE 0 END) AS fresh,
         (SELECT g.door FROM metrics_niche_geo g
           WHERE g.geo=e.geo AND g.niche_id=e.niche_id AND g.snapshot_date<=e.entry_date AND g.door IS NOT NULL
           ORDER BY g.snapshot_date DESC LIMIT 1) AS door,
         (SELECT g.snapshot_date FROM metrics_niche_geo g
           WHERE g.geo=e.geo AND g.niche_id=e.niche_id AND g.snapshot_date<=e.entry_date AND g.door IS NOT NULL
           ORDER BY g.snapshot_date DESC LIMIT 1) AS door_date
    FROM niche_entries e
   WHERE e.installs_at_entry IS NOT NULL`).all();

const withDoor = rows.filter((r) => r.door != null && r.door > 0);
const sameDay = withDoor.filter((r) => r.door_date === r.entry_date).length;

console.log('');
console.log('СВЕРКА ДВЕРИ В ТОП-10 С РЕАЛЬНЫМИ ВХОДАМИ');
console.log('='.repeat(78));
console.log(`входов с известными установками: ${rows.length}`);
console.log(`из них с дверью на день входа или раньше: ${withDoor.length} (ровно в день входа ${pct(sameDay, withDoor.length)})`);
console.log('');

// ---------- 1. Где стоят входы относительно двери ----------
const ratios = withDoor.map((r) => r.inst / r.door).sort((a, b) => a - b);
const below = withDoor.filter((r) => r.inst < r.door).length;
console.log('1. ОТНОШЕНИЕ «УСТАНОВКИ НА ВХОДЕ / ДВЕРЬ НА ТОТ ДЕНЬ»');
console.log(`   p10 ×${quant(ratios, 0.1).toFixed(2)}   p25 ×${quant(ratios, 0.25).toFixed(2)}   медиана ×${quant(ratios, 0.5).toFixed(2)}   p75 ×${quant(ratios, 0.75).toFixed(1)}   p90 ×${quant(ratios, 0.9).toFixed(1)}`);
console.log(`   вошли ДЕШЕВЛЕ двери: ${below} из ${withDoor.length} (${pct(below, withDoor.length)})`);
console.log('   Если дверь меряет порог входа, медиана должна быть чуть выше единицы:');
console.log('   вставать сильно дороже необходимого незачем, дешевле — нельзя.');
console.log('');

// ---------- 2. Калибровка по величине двери ----------
console.log('2. КАЛИБРОВКА: ЧТО ПРОИСХОДИТ В НИШАХ С РАЗНОЙ ДВЕРЬЮ');
console.log('   дверь ниши        входов   медиана входа   отношение   ниже двери');
const BUCKETS = [[0, 1e3], [1e3, 1e4], [1e4, 1e5], [1e5, 1e6], [1e6, 1e7], [1e7, Infinity]];
for (const [lo, hi] of BUCKETS) {
  const b = withDoor.filter((r) => r.door >= lo && r.door < hi);
  if (!b.length) continue;
  const inst = b.map((r) => r.inst).sort((a, x) => a - x);
  const rr = b.map((r) => r.inst / r.door).sort((a, x) => a - x);
  const label = hi === Infinity ? `${q(lo)}+` : `${q(lo)}–${q(hi)}`;
  console.log(`   ${label.padEnd(16)} ${String(b.length).padStart(6)}   ${q(quant(inst, 0.5)).padStart(13)}   ${('×' + quant(rr, 0.5).toFixed(2)).padStart(9)}   ${pct(b.filter((r) => r.inst < r.door).length, b.length).padStart(10)}`);
}
console.log('   Ровное отношение по строкам — дверь масштабируется правильно.');
console.log('   Если в дорогих нишах отношение сильно меньше, дверь там завышена.');
console.log('');

// ---------- 3. Значит ли дверь хоть что-нибудь для удержания ----------
const judged = withDoor.filter((r) => r.observed_after >= 2);
console.log('3. УДЕРЖАНИЕ ПО РАССТОЯНИЮ ДО ДВЕРИ');
console.log(`   (только входы, у которых после них был хотя бы один снятый день: ${judged.length})`);
console.log('   вход относительно двери   входов   держатся   простояли дней (медиана)');
const BANDS = [[0, 0.5, 'вдвое дешевле и ниже'], [0.5, 1, 'чуть дешевле'], [1, 2, 'вровень'], [2, 10, 'вдвое дороже и выше'], [10, Infinity, 'вдесятеро дороже']];
for (const [lo, hi, name] of BANDS) {
  const b = judged.filter((r) => { const x = r.inst / r.door; return x >= lo && x < hi; });
  if (!b.length) continue;
  const held = b.filter((r) => r.still_in).length;
  const days = b.map((r) => r.days_in_top10).sort((a, x) => a - x);
  console.log(`   ${name.padEnd(24)} ${String(b.length).padStart(6)}   ${pct(held, b.length).padStart(8)}   ${String(quant(days, 0.5)).padStart(22)}`);
}
console.log('   Если дверь означает «цену места», удержание должно расти слева направо.');
console.log('   Ровная колонка означает, что дверь не предсказывает ничего.');
console.log('');

// ---------- 4. Новички против старожилов ----------
if (withDoor.some((r) => r.fresh != null)) {
  console.log('4. ТО ЖЕ ОТДЕЛЬНО ДЛЯ НОВИЧКОВ НИШИ');
  for (const [flag, name] of [[1, 'новички ниши'], [0, 'были в выдаче']]) {
    const b = judged.filter((r) => Number(r.fresh) === flag);
    if (!b.length) continue;
    const rr = b.map((r) => r.inst / r.door).sort((a, x) => a - x);
    console.log(`   ${name.padEnd(16)} входов ${String(b.length).padStart(5)}   медиана ×${quant(rr, 0.5).toFixed(2)}   ниже двери ${pct(b.filter((r) => r.inst < r.door).length, b.length)}   держатся ${pct(b.filter((r) => r.still_in).length, b.length)}`);
  }
  console.log('');
}
