#!/usr/bin/env node
// Первая проверка модели фактом: node tools/backtest.js [--horizon 7]
//
// Журнал предсказаний с 16.09 пишет две группы на каждую дату: голову модели (верхние
// строки рекомендации) и случайный контроль того же размера. Признаки заморожены на день
// предсказания, исход снимается позже. Здесь эти две группы сравниваются.
//
// Что тут важнее самих чисел — две оговорки, без которых сравнение врёт.
//
// Первая: строк 126 тысяч, но объектов всего пять с половиной тысяч. Одно приложение
// попадает в журнал на десяти датах, и считать его за десять независимых наблюдений
// значит сузить доверительный интервал вчетверо и объявить победу на шуме. Поэтому всё
// сначала сворачивается по объекту, и только потом сравниваются группы.
//
// Вторая: семидневный горизонт — слабый. Он не заменяет тридцатидневную проверку (первая
// будет 16.10), он даёт первый сигнал на три недели раньше. Если на семи днях разницы с
// контролем нет, это ещё ничего не доказывает; если разница есть и велика — это повод
// присмотреться, а не вывод.
import { db } from '../src/lib/db.js';

const args = process.argv.slice(2);
const optOf = (n, def) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : def; };
const H = Number(optOf('horizon', 7));
const col = `outcome_${H}`;

const d = db();
const pct = (x) => (x == null ? '—' : (100 * x).toFixed(1) + '%');
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Свёртка по объекту: объект попадает в голову, если хоть раз там был; исходы усредняются.
function collapse(kind, pick) {
  const rows = d.prepare(
    `SELECT object_id, geo, in_head, ${col} AS o FROM predictions WHERE kind=? AND ${col} IS NOT NULL`
  ).all(kind);
  const by = new Map();
  for (const r of rows) {
    const key = r.geo + '|' + r.object_id;
    let s = by.get(key);
    if (!s) by.set(key, s = { head: 0, vals: [], gone: 0, n: 0 });
    if (r.in_head) s.head = 1;
    s.n++;
    const o = JSON.parse(r.o);
    if (o.gone) { s.gone++; continue; }
    const v = pick(o);
    if (v != null && Number.isFinite(v)) s.vals.push(v);
  }
  return [...by.values()].map((s) => ({
    head: s.head,
    value: s.vals.length ? s.vals.reduce((a, b) => a + b, 0) / s.vals.length : null,
    goneShare: s.n ? s.gone / s.n : 0,
  }));
}

// Доверительный интервал разницы медиан — бутстрэпом по объектам, без предположений о
// распределении. Прирост установок распределён крайне неровно, среднему тут верить нельзя.
function bootstrapDiff(head, ctrl, iters = 2000) {
  if (head.length < 20 || ctrl.length < 20) return null;
  const draw = (a) => { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[(Math.random() * a.length) | 0]; return o; };
  const diffs = new Array(iters);
  for (let i = 0; i < iters; i++) diffs[i] = med(draw(head)) - med(draw(ctrl));
  diffs.sort((a, b) => a - b);
  return { lo: diffs[Math.floor(iters * 0.025)], hi: diffs[Math.floor(iters * 0.975)] };
}

// Главная статистика — доля выросших, а не медиана прироста. Play обновляет счётчик
// установок пачками раз в несколько дней, и за короткий горизонт у большинства приложений
// он не двигается вовсе: медиана равна нулю в обеих группах и не различает ничего. Доля
// тех, у кого счётчик всё-таки сдвинулся вверх, различает.
function bootstrapShare(head, ctrl, iters = 3000) {
  if (head.length < 30 || ctrl.length < 30) return null;
  const share = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[(Math.random() * a.length) | 0] > 0 ? 1 : 0; return s / a.length; };
  const diffs = new Array(iters);
  for (let i = 0; i < iters; i++) diffs[i] = share(head) - share(ctrl);
  diffs.sort((a, b) => a - b);
  return { lo: diffs[Math.floor(iters * 0.025)], hi: diffs[Math.floor(iters * 0.975)] };
}

function report(title, rows, what) {
  const head = rows.filter((r) => r.head), ctrl = rows.filter((r) => !r.head);
  const hv = head.map((r) => r.value).filter((v) => v != null);
  const cv = ctrl.map((r) => r.value).filter((v) => v != null);
  console.log(title);
  console.log(`   объектов: голова ${head.length}, контроль ${ctrl.length}`);
  if (hv.length < 30 || cv.length < 30) { console.log('   наблюдений не хватает для сравнения'); console.log(''); return; }

  const sh = (a) => a.filter((v) => v > 0).length / a.length;
  const sHead = sh(hv), sCtrl = sh(cv);
  console.log(`   ${what}: голова ${pct(sHead)}, контроль ${pct(sCtrl)}, разница ${pct(sHead - sCtrl)}`);
  console.log(`   медиана величины: голова ${fmt(med(hv))}, контроль ${fmt(med(cv))}`);
  const goneH = head.reduce((a, r) => a + r.goneShare, 0) / head.length;
  const goneC = ctrl.reduce((a, r) => a + r.goneShare, 0) / ctrl.length;
  console.log(`   выпали из наблюдения: голова ${pct(goneH)}, контроль ${pct(goneC)}`);

  const ci = bootstrapShare(hv, cv);
  if (!ci) { console.log(''); return; }
  const crosses = ci.lo <= 0 && ci.hi >= 0;
  console.log(`   разница долей, 95 % интервал: ${pct(ci.lo)} … ${pct(ci.hi)}`);
  console.log(`   ВЫВОД: ${crosses
    ? 'разницы с контролем не видно — интервал накрывает ноль'
    : (sHead > sCtrl ? 'голова опережает контроль' : 'голова ОТСТАЁТ от контроля — это хуже, чем отсутствие разницы')}`);
  console.log('');
}

const fmt = (v) => (v == null ? '—' : Math.abs(v) < 0.001 ? '0' : v.toFixed(3));

const dates = d.prepare(`SELECT COUNT(DISTINCT pred_date) n, MIN(pred_date) a, MAX(pred_date) b FROM predictions WHERE ${col} IS NOT NULL`).get();
console.log('');
console.log(`БЭКТЕСТ НА ГОРИЗОНТЕ ${H} ДНЕЙ`);
console.log('='.repeat(78));
console.log(`даты предсказаний с исходом: ${dates.n} (${dates.a} … ${dates.b})`);
if (H < 30) console.log('горизонт короткий: сигнал слабый, тридцатидневная проверка остаётся главной (с 16.10)');
console.log('');

report('ПРИЛОЖЕНИЯ — сдвинулся ли счётчик установок вверх', collapse('app', (o) => o.growth), 'доля выросших');
report('НИШИ — прибавилось ли молодых органиков', collapse('niche', (o) => o.dyoung), 'доля с прибавкой');

// Главный подвох сравнения со случайным контролем: голову отбирает скор, в который входит
// недавний рост, а рост склонен продолжаться сам по себе. Часть отрыва может быть не
// заслугой модели, а инерцией. Проверяется послойно: если внутри одного размера и одного
// импульса ключей голова всё равно впереди, модель добавляет что-то сверх инерции; если
// отрыв исчезает — весь сигнал был инерцией.
function stratified(kind, pick, strata, name) {
  const rows = d.prepare(
    `SELECT object_id, geo, in_head, features f, ${col} AS o FROM predictions WHERE kind=? AND ${col} IS NOT NULL`
  ).all(kind);
  const by = new Map();
  for (const r of rows) {
    const o = JSON.parse(r.o); if (o.gone) continue;
    const v = pick(o); if (v == null || !Number.isFinite(v)) continue;
    const s = strata(JSON.parse(r.f)); if (s == null) continue;
    const key = s + '|' + r.geo + '|' + r.object_id;
    let e = by.get(key);
    if (!e) by.set(key, e = { s, head: 0, vals: [] });
    if (r.in_head) e.head = 1;
    e.vals.push(v);
  }
  const groups = new Map();
  for (const e of by.values()) {
    if (!groups.has(e.s)) groups.set(e.s, { head: [], ctrl: [] });
    const avg = e.vals.reduce((a, b) => a + b, 0) / e.vals.length;
    groups.get(e.s)[e.head ? 'head' : 'ctrl'].push(avg);
  }
  console.log(name);
  console.log('   слой                голова   контроль   разница   объектов');
  const order = [...groups.keys()].sort();
  let anyLead = 0, anyLag = 0;
  for (const s of order) {
    const g = groups.get(s);
    if (g.head.length < 30 || g.ctrl.length < 30) { console.log(`   ${String(s).padEnd(18)} наблюдений мало (${g.head.length} / ${g.ctrl.length})`); continue; }
    const sh = (a) => a.filter((v) => v > 0).length / a.length;
    const h = sh(g.head), c = sh(g.ctrl);
    if (h > c) anyLead++; else anyLag++;
    console.log(`   ${String(s).padEnd(18)} ${pct(h).padStart(7)}   ${pct(c).padStart(8)}   ${pct(h - c).padStart(7)}   ${String(g.head.length + g.ctrl.length).padStart(8)}`);
  }
  console.log(`   слоёв, где голова впереди: ${anyLead}, где позади: ${anyLag}`);
  console.log('');
}

const bucket = (v, edges, labels) => {
  if (v == null) return null;
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

stratified('app', (o) => o.growth,
  (f) => bucket(f.inst, [1e4, 1e5, 1e6, 1e7], ['1 до 10K', '2 10K–100K', '3 100K–1M', '4 1M–10M', '5 10M+']),
  'ПРИЛОЖЕНИЯ ПО РАЗМЕРУ НА ВХОДЕ — доля выросших');

// Слой по импульсу ключей был бы точнее — именно он входит в скор и создаёт инерцию, — но
// на датах 16–20.09 охват топ-50 в журнал ещё не писался: k50 и k50p пусты во всех строках.
// Эта проверка станет возможна на записях с 23.09, когда наступит их горизонт.
stratified('app', (o) => o.growth,
  (f) => bucket(f.age, [6, 18, 48], ['1 до полугода', '2 0,5–1,5 года', '3 1,5–4 года', '4 старше 4 лет']),
  'ПРИЛОЖЕНИЯ ПО ВОЗРАСТУ НА ВХОДЕ — доля выросших');

// Отдельно: держится ли квадрант «Цель» — ниша, названная целью, должна ею остаться.
const nq = d.prepare(`SELECT in_head, ${col} AS o, features f FROM predictions WHERE kind='niche' AND ${col} IS NOT NULL`).all();
let kept = { 1: [0, 0], 0: [0, 0] };
for (const r of nq) {
  const f = JSON.parse(r.f), o = JSON.parse(r.o);
  if (f.quad !== 'target' || o.gone) continue;
  kept[r.in_head][1]++;
  if (o.quad === 'target') kept[r.in_head][0]++;
}
console.log('НИШИ — удержали ли квадрант «Цель» те, кто им был на входе');
for (const [k, name] of [[1, 'голова  '], [0, 'контроль']]) {
  const [ok, all] = kept[k];
  console.log(`   ${name} ${all ? `${ok} из ${all} (${pct(ok / all)})` : 'наблюдений нет'}`);
}
console.log('');
