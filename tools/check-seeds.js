// Проверка каталога ниш на живой выдаче: ключ, по которому Play ничего не находит,
// это ниша, молча выпавшая из обхода. Ошибка проявилась бы только через сутки сбора
// пустым door, поэтому дешевле поймать её здесь.
//
//   node tools/check-seeds.js            # выборка: по 4 ниши на каждый язык
//   node tools/check-seeds.js --all      # весь каталог по всем гео (долго)
//   node tools/check-seeds.js --geo DE   # один гео целиком
import gpRaw from 'google-play-scraper';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gp = gpRaw.default || gpRaw;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'seeds.json'), 'utf8'));
const geos = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'geos.json'), 'utf8'));

const args = process.argv.slice(2);
const only = args.includes('--geo') ? args[args.indexOf('--geo') + 1] : null;
const all = args.includes('--all');
const SAMPLE = Number(args.includes('--sample') ? args[args.indexOf('--sample') + 1] : 4);
const THIN = 5;  // меньше стольких результатов — ключ считаем подозрительным

const hlOf = new Map(geos.geos.map((g) => [g.geo, Array.isArray(g.hl) ? g.hl[0] : g.hl]));

// Один гео на язык: проверять один и тот же перевод в AT, CH и DE смысла нет.
const byLang = new Map();
for (const [geo, list] of Object.entries(seeds.keywords)) {
  const lang = list[0]?.lang;
  if (!lang || byLang.has(lang)) continue;
  byLang.set(lang, geo);
}

let targets;
if (only) targets = [only];
else if (all) targets = Object.keys(seeds.keywords);
else targets = [...byLang.values()];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const thin = [];
let checked = 0;

for (const geo of targets) {
  const list = seeds.keywords[geo] || [];
  const pick = (only || all) ? list : list.filter((_, i) => i % Math.ceil(list.length / SAMPLE) === 0);
  console.log(`\n=== ${geo} (${pick[0]?.lang}) — ${pick.length} ключей ===`);
  for (const k of pick) {
    let n = 0, first = '';
    try {
      const res = await gp.search({ term: k.keyword, country: geo, lang: hlOf.get(geo) || 'en', num: 10 });
      n = res.length;
      first = res[0]?.title || '';
    } catch (e) {
      first = `ОШИБКА ${e.message}`;
    }
    checked++;
    const flag = n < THIN ? ' <-- ТОНКО' : '';
    console.log(`  ${String(n).padStart(2)} | ${k.concept.padEnd(24)} | ${k.keyword.padEnd(34)} | ${first.slice(0, 40)}${flag}`);
    if (n < THIN) thin.push({ geo, concept: k.concept, keyword: k.keyword, n });
    await sleep(3000);
  }
}

console.log(`\nпроверено ${checked} ключей, подозрительных ${thin.length}`);
for (const t of thin) console.log(`  ${t.geo} ${t.concept}: «${t.keyword}» — ${t.n} результатов`);
