// Проверка ниш после правки П32 (концепт подсказки подтверждается выдачей семени).
//   1. Чистота ядра: у ключа ядра не меньше 2 общих приложений в топ-20 с семенами концепта
//      ниши; у ниш без семян — с остальными ключами ядра (связность).
//   2. Подпись: концепт ниши подтверждён её ключами (семя или concept_ok=1), а не одной подсказкой.
//   3. Привязка приложений: прошедшие воронку не держатся за нишу единственным не головным ключом.
//   node tools/check-niches.js [--geo=US,GB] [--out=out/niche-check.json]
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from '../src/lib/db.js';
import { activeGeos } from '../src/lib/config.js';

const arg = (n, def) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${def}`).slice(n.length + 3);
const d = db();
const geos = arg('geo', '') ? arg('geo', '').split(',') : activeGeos().map((g) => g.geo);
const MIN = 2;
const total = { niches: 0, keywords: 0, foreign: 0, nichesDirty: 0, weakLabel: 0, apps: 0, appsSingleKey: 0 };
const worst = [], weak = [], single = [], perGeo = {};

for (const geo of geos) {
  const date = d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_niche_geo WHERE geo=?`).get(geo)?.m;
  if (!date) continue;
  const top20 = new Map();
  for (const r of d.prepare(`SELECT r.keyword, r.app_id FROM raw_search r
      JOIN (SELECT keyword, MAX(snapshot_date) md FROM raw_search WHERE geo=? GROUP BY keyword) l ON l.keyword=r.keyword AND l.md=r.snapshot_date
     WHERE r.geo=? AND r.position<=20`).all(geo, geo)) {
    if (!top20.has(r.keyword)) top20.set(r.keyword, new Set());
    top20.get(r.keyword).add(r.app_id);
  }
  const kwInfo = new Map(d.prepare(`SELECT keyword, concept, source, concept_ok FROM disc_keywords WHERE geo=?`).all(geo).map((r) => [r.keyword, r]));
  const seedPool = new Map();
  for (const [kw, k] of kwInfo) if (k.source === 'seed' && k.concept && top20.has(kw)) {
    if (!seedPool.has(k.concept)) seedPool.set(k.concept, new Set());
    top20.get(kw).forEach((a) => seedPool.get(k.concept).add(a));
  }
  const niches = d.prepare(`SELECT niche_id, head_keyword, concept FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`).all(geo, date);
  const g = { niches: niches.length, keywords: 0, foreign: 0, nichesDirty: 0, weakLabel: 0, apps: 0, appsSingleKey: 0 };
  const coreOf = new Map();
  for (const n of niches) {
    const core = d.prepare(`SELECT keyword FROM keyword_cores WHERE niche_id=? AND geo=? AND active=1`).all(n.niche_id, geo).map((r) => r.keyword);
    coreOf.set(n.niche_id, core);
    const pool = n.concept ? seedPool.get(n.concept) : null;
    const foreign = [];
    for (const kw of core) {
      const k = kwInfo.get(kw);
      if (k?.source === 'seed') continue;
      const mine = top20.get(kw) || new Set();
      let ref = pool;
      if (!ref || !ref.size) { ref = new Set(); for (const o of core) if (o !== kw) (top20.get(o) || []).forEach((a) => ref.add(a)); }
      let shared = 0; for (const a of mine) if (ref.has(a)) shared++;
      if (shared < MIN) foreign.push(kw);
    }
    g.keywords += core.length; g.foreign += foreign.length;
    if (foreign.length && foreign.length / Math.max(1, core.length) >= 0.25) {
      g.nichesDirty++;
      worst.push({ geo, head: n.head_keyword, concept: n.concept, core: core.length, foreign: foreign.slice(0, 6) });
    }
    // Подпись: сколько ключей ядра подтверждают концепт.
    if (n.concept) {
      const confirm = core.filter((kw) => { const k = kwInfo.get(kw); return k && k.concept === n.concept && (k.source === 'seed' || k.concept_ok === 1); }).length;
      if (confirm === 0 || confirm / Math.max(1, core.length) < 0.34) { g.weakLabel++; weak.push({ geo, head: n.head_keyword, concept: n.concept, confirm, core: core.length }); }
    }
  }
  // Привязка приложений: сколько ключей ядра своей ниши у приложения в топ-50.
  const mdate = d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_app_geo WHERE geo=?`).get(geo)?.m;
  const pos = d.prepare(`SELECT keyword, best_position FROM disc_app_keyword WHERE geo=? AND app_id=?`);
  for (const a of d.prepare(`SELECT m.app_id, m.niche_id, p.title FROM metrics_app_v2 m JOIN apps p ON p.app_id=m.app_id
      WHERE m.geo=? AND m.snapshot_date=(SELECT MAX(snapshot_date) FROM metrics_app_v2 WHERE geo=?) AND m.passed_funnel=1 AND m.niche_id IS NOT NULL`).all(geo, geo)) {
    const core = new Set(coreOf.get(a.niche_id) || []);
    if (!core.size) continue;
    g.apps++;
    const hits = pos.all(geo, a.app_id).filter((r) => core.has(r.keyword) && r.best_position <= 50);
    // Один ключ ядра — норма, если это головной ключ ниши (ядра маленькие). Подозрительно — один
    // и не головной: приложение держится за нишу случайным запросом.
    const head = niches.find((n) => n.niche_id === a.niche_id)?.head_keyword;
    if (hits.length <= 1 && hits[0]?.keyword !== head) {
      g.appsSingleKey++;
      if (single.length < 400) single.push({ geo, title: a.title, niche: niches.find((n) => n.niche_id === a.niche_id)?.head_keyword, key: hits[0]?.keyword || null });
    }
  }
  perGeo[geo] = { date, mdate, ...g };
  for (const k of Object.keys(total)) total[k] += g[k] || 0;
}

const report = { total, perGeo, worst: worst.sort((a, b) => b.foreign.length - a.foreign.length), weak, singleKeyApps: single };
const out = path.join(ROOT, arg('out', 'out/niche-check.json'));
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`ниш ${total.niches}, ключей в ядрах ${total.keywords}, чужих ${total.foreign} (${(total.foreign / Math.max(1, total.keywords) * 100).toFixed(1)} %)`);
console.log(`ниш, где чужих ≥ 25 %: ${total.nichesDirty}; ниш со слабой подписью концепта: ${total.weakLabel}`);
console.log(`приложений, прошедших воронку, с нишей: ${total.apps}; привязаны через один не головной ключ: ${total.appsSingleKey} (${(total.appsSingleKey / Math.max(1, total.apps) * 100).toFixed(1)} %)`);
console.log('подробно:', out);
