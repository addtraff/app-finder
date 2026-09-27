#!/usr/bin/env node
// Проверка коэффициентов спроса: node tools/demand-check.js
//
// По 24 гео из 30 спрос не замерен, а прикинут: берётся спрос той же темы по США и
// умножается на demand_rel_us из config/geos.json. Коэффициент взят из общих соображений о
// размере рынка и не проверялся ни разу — а на нём стоит колонка «Спрос» у четырёх пятых
// ниш отчёта.
//
// 26.09 появились выгрузки по GB, DE, FR, CA и JP. Для этих пяти стран теперь есть И
// оценка, И замер — то есть готовая проверка модели, которая ничего не стоит.
//
// Две вещи проверяются отдельно.
//   1. Величина коэффициента: во сколько раз оценка расходится с замером.
//   2. Сама форма модели. Один коэффициент на страну предполагает, что ВСЕ темы
//      масштабируются между странами одинаково. Правдоподобнее, что «определитель
//      растений» и «журнал давления» ведут себя по-разному. Если разброс по темам внутри
//      страны велик, чинить надо не число, а подход.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from '../src/lib/db.js';

const d = db();
const geos = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'geos.json'), 'utf8')).geos;
const relOf = new Map(geos.map((g) => [g.geo, g.demand_rel_us]));

const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const f2 = (v) => (v == null ? '—' : v.toFixed(2));

// Спрос по темам США — основание оценки.
const us = new Map(d.prepare(
  `SELECT concept, demand_ext dem FROM metrics_niche_v2
    WHERE geo='US' AND snapshot_date=(SELECT MAX(snapshot_date) FROM metrics_niche_v2 WHERE geo='US')
      AND concept IS NOT NULL AND demand_ext IS NOT NULL AND demand_est=0`
).all().map((r) => [r.concept, r.dem]));

// Гео с собственным замером — на них и проверяем.
const measured = d.prepare(
  `SELECT DISTINCT m.geo AS geo FROM metrics_niche_v2 m
     JOIN (SELECT geo, MAX(snapshot_date) mx FROM metrics_niche_v2 GROUP BY geo) f ON f.geo=m.geo AND f.mx=m.snapshot_date
    WHERE m.demand_est=0 AND m.demand_ext IS NOT NULL AND m.geo<>'US'`
).all().map((r) => r.geo);

console.log('');
console.log('ПРОВЕРКА КОЭФФИЦИЕНТОВ СПРОСА');
console.log('='.repeat(78));
console.log(`тем с замеренным спросом по США: ${us.size}`);
console.log(`гео со своим замером (кроме США): ${measured.join(', ') || 'нет'}`);
console.log('');

if (!measured.length) { console.log('сверять не с чем: замер есть только по США'); process.exit(0); }

console.log('1. ВЕЛИЧИНА КОЭФФИЦИЕНТА');
console.log('   гео   тем   коэффициент   факт (медиана)   ошибка   разброс по темам p25…p75');
const all = [];
for (const geo of measured) {
  const rows = d.prepare(
    `SELECT concept, demand_ext dem FROM metrics_niche_v2 m
       JOIN (SELECT geo, MAX(snapshot_date) mx FROM metrics_niche_v2 GROUP BY geo) f ON f.geo=m.geo AND f.mx=m.snapshot_date
      WHERE m.geo=? AND m.demand_est=0 AND m.demand_ext IS NOT NULL AND m.concept IS NOT NULL`
  ).all(geo);
  // Отношение «замер страны / замер США» по каждой общей теме — это и есть настоящий
  // коэффициент. Темы с нулём по любой стороне не участвуют: ноль у сервиса означает
  // «ниже порога измерения», а не «спроса нет», и делить на него нельзя.
  const ratios = [];
  for (const r of rows) {
    const u = us.get(r.concept);
    if (u == null || u <= 0 || r.dem == null || r.dem <= 0) continue;
    ratios.push(r.dem / u);
  }
  if (ratios.length < 5) { console.log(`   ${geo}    общих тем ${ratios.length} — мало для вывода`); continue; }
  const cfgRel = relOf.get(geo);
  const fact = med(ratios);
  const err = cfgRel ? fact / cfgRel : null;
  all.push({ geo, n: ratios.length, cfgRel, fact, err, p25: q(ratios, 0.25), p75: q(ratios, 0.75) });
  console.log(`   ${geo}   ${String(ratios.length).padStart(3)}   ${f2(cfgRel).padStart(11)}   ${f2(fact).padStart(14)}   ${(err == null ? '—' : '×' + f2(err)).padStart(6)}   ${f2(q(ratios, 0.25))} … ${f2(q(ratios, 0.75))}`);
}
console.log('');
console.log('   «Ошибка» — во сколько раз факт отличается от коэффициента в конфиге.');
console.log('   ×1 — коэффициент верен. Меньше единицы — оценка завышала спрос, больше — занижала.');
console.log('');

if (all.length) {
  const errs = all.map((r) => r.err).filter((v) => v != null);
  const worst = all.slice().sort((a, b) => Math.abs(Math.log(b.err)) - Math.abs(Math.log(a.err)))[0];
  console.log('2. ЧТО ЭТО ЗНАЧИТ ДЛЯ ОСТАЛЬНЫХ 24 ГЕО');
  console.log(`   медиана ошибки по проверенным странам: ×${f2(med(errs))}`);
  console.log(`   худшая страна: ${worst.geo} — ×${f2(worst.err)}`);
  const spread = all.map((r) => r.p75 / r.p25).filter((v) => Number.isFinite(v));
  console.log(`   разброс по темам внутри страны (p75/p25): медиана ×${f2(med(spread))}`);
  console.log('');
  console.log('   Если ошибка близка к единице, а разброс по темам невелик — оценка годится');
  console.log('   и по остальным странам, выгрузки можно брать не спеша.');
  console.log('   Если разброс по темам велик, чинить надо не число, а саму модель: один');
  console.log('   коэффициент на страну не описывает рынок, и нужен замер по каждой стране.');
  console.log('');
}
