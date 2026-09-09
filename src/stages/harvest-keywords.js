// D1. Расширение семян: подсказки рекурсивно, шаблоны интента языка гео, n-граммы 1–3
// из заголовков и кратких описаний топ-20 (встречаются у >= 3 приложений, бренды отброшены).
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, geoConf, primaryHl } from '../lib/config.js';
import { registerKeyword } from '../lib/registry.js';
import { log } from '../lib/util.js';

const STOP = new Set(('a an the and or of for to in on with without my your best free app apps android pro plus lite ' +
  'new all any get make made using use easy simple fast quick top mobile phone online offline').split(' '));

function prefixesOf(kw) {
  const words = kw.split(/\s+/).filter(Boolean);
  const out = new Set([kw]);
  if (words.length >= 2) out.add(words.slice(0, 2).join(' '));
  if (words.length >= 3) out.add(words.slice(0, 3).join(' '));
  const head = words[0] || '';
  for (const n of [3, 4, 5, 6]) if (head.length > n) out.add(head.slice(0, n));
  return [...out];
}

function ngrams(text, n) {
  const toks = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i + n <= toks.length; i++) {
    const g = toks.slice(i, i + n);
    if (g.every((t) => STOP.has(t))) continue;
    if (g.some((t) => t.length < 3 && !/\d/.test(t))) continue;
    out.push(g.join(' '));
  }
  return out;
}

export async function run({ geo, date, runId, cycle = 'discovery', withNgrams = true }) {
  const d = db();
  startRun(runId, 'harvest-keywords', geo, cycle, date);
  const g = geoConf(geo);
  const hl = primaryHl(geo);
  const lang = g.review_langs[0];
  const cfg = config();
  const budget = cfg.budget.discovery;
  const templates = cfg.intents[lang] || cfg.intents.en;

  const seeds = d.prepare(`SELECT keyword, lang, intent_type, concept FROM seed_keywords WHERE geo=?`).all(geo);
  if (!seeds.length) {
    finishRun(runId, 'harvest-keywords', geo, { status: 'skipped', notes: 'нет семян на языке гео' });
    log(`  ${geo}: семян нет — обход не запускается (ТЗ 3.2)`);
    return { added: 0 };
  }

  const insSuggest = d.prepare(
    `INSERT OR REPLACE INTO raw_suggest (snapshot_date, geo, prefix, position, suggestion) VALUES (?,?,?,?,?)`
  );

  const seen = new Set(d.prepare(`SELECT keyword FROM disc_keywords WHERE geo=?`).all(geo).map((r) => r.keyword));
  let added = 0, requests = 0;

  // Лимит ограничивает расширение, а не сам каталог: семя — это ниша, которую решили
  // наблюдать, и молча выбросить её нельзя. Без исключения гео, добравший лимит
  // подсказками в прошлом прогоне, не увидел бы ни одной новой ниши из seeds.json.
  const addKw = (kw, source, depth, intent, concept, force = false) => {
    const k = kw.toLowerCase().trim();
    if (!k || k.length < 3 || k.length > 60) return false;
    if (seen.has(k)) return false;
    if (!force && seen.size >= budget.max_keywords_per_geo) return false;
    registerKeyword(geo, k, { lang, source, depth, intent, date, concept });
    seen.add(k);
    added++;
    return true;
  };

  // 1) семена
  for (const s of seeds) addKw(s.keyword, 'seed', 0, s.intent_type, s.concept, true);

  // 2) подсказки рекурсивно (глубина из бюджета). Запросы выполняются независимо от
  // лимита на число ключей: raw_suggest нужен для suggest_score и wom_index, даже если
  // сам ключ в ядро уже не влезает.
  const suggestCounts = new Map();  // keyword -> {prefixes:Set, score:number}
  let frontier = seeds.map((s) => s.keyword);
  const conceptOf = new Map(seeds.map((s) => [s.keyword.toLowerCase(), s.concept]));
  const askedPrefixes = new Set();
  for (let depth = 1; depth <= budget.suggest_depth; depth++) {
    const next = [];
    for (const kw of frontier) {
      const concept = conceptOf.get(kw) || null;
      for (const prefix of prefixesOf(kw)) {
        if (askedPrefixes.has(prefix)) continue;
        askedPrefixes.add(prefix);
        let sugg = [];
        try {
          sugg = await play.suggest(prefix, geo, hl);
          requests++;
        } catch (e) {
          log(`  подсказки "${prefix}" упали: ${e.message}`);
          continue;
        }
        const write = d.transaction(() => {
          sugg.forEach((s, i) => insSuggest.run(date, geo, prefix, i + 1, s));
        });
        write();
        sugg.forEach((s, i) => {
          const k = s.toLowerCase().trim();
          if (!suggestCounts.has(k)) suggestCounts.set(k, { prefixes: new Set(), score: 0 });
          const rec = suggestCounts.get(k);
          rec.prefixes.add(prefix);
          rec.score += Math.max(0, 11 - (i + 1)) / 10;
          if (addKw(k, 'suggest', depth, 'generic', concept)) { conceptOf.set(k, concept); next.push(k); }
        });
      }
    }
    frontier = next;
  }

  // 3) шаблоны интента языка гео
  for (const s of seeds) {
    for (const t of templates) addKw(t.t.replace('{kw}', s.keyword), 'template', 0, t.intent, s.concept);
  }

  // suggest_score и глубина подсказки (ключ с 3+ префиксов — устойчивый спрос, не артефакт написания)
  const updSug = d.prepare(`UPDATE disc_keywords SET suggest_score=?, suggest_depth=? WHERE geo=? AND keyword=?`);
  d.transaction(() => {
    for (const [k, rec] of suggestCounts) updSug.run(rec.score, rec.prefixes.size, geo, k);
  })();

  // 4) n-граммы из заголовков и кратких описаний топ-20 уже собранной выдачи
  let ngramAdded = 0;
  if (withNgrams) {
    const rows = d.prepare(
      `SELECT DISTINCT r.app_id, a.title, p.summary
         FROM raw_search r
         JOIN apps a ON a.app_id = r.app_id
         LEFT JOIN raw_app_page p ON p.app_id = r.app_id AND p.geo = r.geo
        WHERE r.geo=? AND r.position <= 20`
    ).all(geo);
    const counts = new Map();
    for (const row of rows) {
      const brandTokens = new Set(String(row.title || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2).slice(0, 1));
      const text = `${row.title || ''} ${row.summary || ''}`;
      const grams = new Set();
      for (const n of [1, 2, 3]) for (const gm of ngrams(text, n)) grams.add(gm);
      for (const gm of grams) {
        if ([...brandTokens].some((b) => gm.includes(b))) continue;
        counts.set(gm, (counts.get(gm) || 0) + 1);
      }
    }
    for (const [gm, cnt] of [...counts].sort((a, b) => b[1] - a[1])) {
      if (cnt < 3) break;
      if (addKw(gm, 'ngram', 1, 'generic', null)) ngramAdded++;
    }
  }

  finishRun(runId, 'harvest-keywords', geo, { requests, notes: `+${added} ключей (n-грамм ${ngramAdded})` });
  log(`  ${geo}: ключей всего ${seen.size}, добавлено ${added} (n-грамм ${ngramAdded}), запросов подсказок ${requests}`);
  return { added, total: seen.size };
}
