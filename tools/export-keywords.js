#!/usr/bin/env node
// Выгрузка списка ключей для внешней оценки объёма и конкуренции.
//   node tools/export-keywords.js            — все гео
//   node tools/export-keywords.js US,DE      — только указанные
//
// Кладёт в out/keywords/:
//   <GEO>.csv  — гео, ключ, слой, тема, наш порядковый балл и пустые колонки volume/competition
//   <GEO>.txt  — только слова, по одному в строке, головные сверху: вставлять в сервис
//   all.csv    — всё одним файлом
//
// Слои нужны, чтобы список можно было оборвать на любом месте, если у сервиса лимит:
//   1 — головной ключ темы: по нему тема названа и по нему считается дверь;
//   2 — остальное ядро ниши: то, из чего ниша собрана;
//   3 — прочие отслеживаемые слова: снимаем выдачу, но в ядро они не вошли;
//   4 — наши шаблонные варианты.
//
// Четвёртый слой важно не смешивать с остальными. Это 621 слово, которое Play нам не
// подсказывал: мы сами приставили к теме «best», «free», «how to», «offline», «for android»,
// «without ads» и сняли по ним выдачу. Может оказаться, что половину из них никто не ищет —
// и внешние объёмы это как раз покажут, — но тратить на них чужую квоту раньше настоящих
// подсказок незачем. Источник каждого слова стоит в колонке source: suggest (подсказка
// Play), seed (наше семя темы), template (наш шаблон).
//
// Наш балл (suggest_score) идёт в файле нарочно. Это порядковая величина без единиц: сколько
// раз слово всплыло в подсказках Play и на какой глубине. На США она сейчас лежит между 0 и
// 5,8 при среднем 0,66 — то есть почти у всех слов почти ноль, и именно поэтому внешний
// объём и нужен. Когда данные вернутся, первым делом считается ранговая корреляция между
// этим баллом и внешним объёмом: низкая корреляция — это разговор о том, какая из двух шкал
// что меряет, а не повод молча подменить одну другой.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { log } from '../src/lib/util.js';

const d = db();
const geos = (process.argv[2] ? process.argv[2].split(',') : config().geos.geos.map((g) => g.geo))
  .map((g) => g.trim().toUpperCase()).filter(Boolean);
const outDir = path.join(ROOT, 'out', 'keywords');
fs.mkdirSync(outDir, { recursive: true });

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const HEAD = ['geo', 'keyword', 'tier', 'source', 'concept', 'our_score', 'volume', 'competition'];
const all = [];
const summary = [];

for (const geo of geos) {
  // Ядро ниш — основной список. Берётся последний снимок метрик этого гео: сегодняшний
  // может быть ещё не посчитан, пока идёт сбор.
  const mdate = d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_keyword_geo WHERE geo=?`).get(geo)?.m;
  const ndate = d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_niche_v2 WHERE geo=?`).get(geo)?.m;
  const concept = new Map(ndate
    ? d.prepare(`SELECT niche_id, COALESCE(concept, head_keyword) c FROM metrics_niche_v2 WHERE geo=? AND snapshot_date=?`)
      .all(geo, ndate).map((r) => [r.niche_id, r.c])
    : []);
  const score = new Map(mdate
    ? d.prepare(`SELECT keyword, MAX(suggest_score) s FROM metrics_keyword_geo WHERE geo=? AND snapshot_date=? GROUP BY keyword`)
      .all(geo, mdate).map((r) => [r.keyword, r.s])
    : []);

  const src = new Map(d.prepare(`SELECT keyword, source FROM disc_keywords WHERE geo=? AND active=1`).all(geo)
    .map((r) => [r.keyword, r.source]));
  const rows = new Map();
  for (const r of d.prepare(
    `SELECT keyword, MAX(is_head) is_head, MIN(niche_id) niche_id FROM keyword_cores
      WHERE geo=? AND active=1 GROUP BY keyword`).all(geo)) {
    // Шаблон уходит в свой слой, даже если попал в ядро: Play такого слова не подсказывал.
    const source = src.get(r.keyword) || '';
    const tier = source === 'template' ? 4 : r.is_head ? 1 : 2;
    rows.set(r.keyword, { tier, niche: r.niche_id, source });
  }
  // Прочее, что мы снимаем в выдаче, но в ядро оно не попало.
  for (const r of d.prepare(
    `SELECT DISTINCT keyword FROM raw_search WHERE geo=? AND snapshot_date>=date('now','-14 day')`).all(geo)) {
    if (!rows.has(r.keyword)) {
      const source = src.get(r.keyword) || '';
      rows.set(r.keyword, { tier: source === 'template' ? 4 : 3, niche: null, source });
    }
  }
  if (!rows.size) { log(`  ${geo}: ключей нет, пропускаю`); continue; }

  const list = [...rows.entries()]
    .map(([keyword, v]) => ({ geo, keyword, tier: v.tier, source: v.source, concept: concept.get(v.niche) || '', our_score: score.get(keyword) ?? '' }))
    .sort((a, b) => a.tier - b.tier || (Number(b.our_score) || 0) - (Number(a.our_score) || 0) || a.keyword.localeCompare(b.keyword));

  fs.writeFileSync(path.join(outDir, `${geo}.csv`),
    [HEAD.join(','), ...list.map((r) => [r.geo, r.keyword, r.tier, r.source, r.concept, r.our_score, '', ''].map(csvCell).join(','))].join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, `${geo}.txt`), list.map((r) => r.keyword).join('\n') + '\n');
  all.push(...list);
  const by = (n) => list.filter((r) => r.tier === n).length;
  summary.push({ geo, всего: list.length, головных: by(1), ядро: by(2), прочих: by(3), шаблонных: by(4) });
}

fs.writeFileSync(path.join(outDir, 'all.csv'),
  [HEAD.join(','), ...all.map((r) => [r.geo, r.keyword, r.tier, r.source, r.concept, r.our_score, '', ''].map(csvCell).join(','))].join('\n') + '\n');

console.table(summary);
log(`выгружено ${all.length} пар «ключ × гео» по ${summary.length} гео в out/keywords/`);
log(`головных ${all.filter((r) => r.tier === 1).length}, ядро ${all.filter((r) => r.tier === 2).length}, прочих ${all.filter((r) => r.tier === 3).length}, шаблонных ${all.filter((r) => r.tier === 4).length}`);
log(`уникальных слов ${new Set(all.map((r) => r.keyword)).size} — многие повторяются в англоязычных гео`);
