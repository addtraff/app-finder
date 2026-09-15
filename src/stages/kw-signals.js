// kw-signals: сигналы раздела 5 по словарю гео — popularity score из подсказок (раздел 4)
// и признаки выдачи, фразы и внешних выгрузок.
//
// Словарь — ключи радара (disc_keywords) плюс избранное (kw_watch) и слова своих приложений
// из Play Console. Полный расчёт (binary) — для отслеживаемых: семена, избранное, Console;
// разведочный словарь — грубо, по трём префиксам (4.3). Слово, посчитанное не хуже нужного
// способа за последние recompute_days, не пересчитывается: score меняется медленно.
import { primaryHl } from '../lib/config.js';
import { CaptchaStop } from '../lib/play.js';
import { log, warn, daysAgoUTC } from '../lib/util.js';
import { kwDb, kwConfig, keywordId, normTerm } from '../lib/kw/schema.js';
import { scorePhrase, percentileScores, ProbeError } from '../lib/kw/popularity.js';
import { suggestCache } from '../lib/kw/suggest-cache.js';
import { langOf, phraseFeatures, loadSerpContext, serpFeatures, brandFlag, loadExternal } from '../lib/kw/features.js';

const QUALITY = { cache: 0, rough: 1, binary: 2, exact: 3 };

export function dictionary(d, geo) {
  const map = new Map();
  const add = (term, patch) => {
    const t = normTerm(term);
    if (!t) return;
    map.set(t, { term: t, tracked: 0, is_brand: 0, source: null, order: 9, ...map.get(t), ...patch });
  };
  for (const r of d.prepare(
    `SELECT keyword, source, depth, is_brand, suggest_score FROM disc_keywords WHERE geo=? AND dead=0`).all(geo)) {
    add(r.keyword, { source: r.source, is_brand: r.is_brand, order: r.source === 'seed' ? 1 : 3 + (r.depth || 0), suggest_score: r.suggest_score });
  }
  for (const r of d.prepare(`SELECT keyword FROM seed_keywords WHERE geo=?`).all(geo)) add(r.keyword, { tracked: 1, order: 1 });
  for (const r of d.prepare(`SELECT term FROM kw_watch WHERE geo=?`).all(geo)) add(r.term, { tracked: 1, order: 0, source: map.get(normTerm(r.term))?.source || 'watch' });
  for (const r of d.prepare(`SELECT DISTINCT term FROM console_search_terms WHERE geo=?`).all(geo)) {
    add(r.term, { tracked: 1, order: 0, source: map.get(normTerm(r.term))?.source || 'console' });
  }
  return [...map.values()].sort((a, b) => a.order - b.order || (b.suggest_score || 0) - (a.suggest_score || 0));
}

export async function run({ geo, date, runId, limit = null, mode = null, offline = false, force = false, terms = null }) {
  const d = kwDb();
  const cfg = kwConfig();
  const sc = cfg.score;
  const hl = primaryHl(geo);
  const lang = langOf(hl);
  const startedAt = new Date().toISOString();

  let dict = dictionary(d, geo);
  if (terms) {
    const wanted = new Set(terms.map(normTerm));
    for (const t of wanted) if (!dict.find((x) => x.term === t)) dict.push({ term: t, tracked: 1, is_brand: 0, source: 'manual', order: 0 });
    dict = dict.filter((x) => wanted.has(x.term)).map((x) => ({ ...x, tracked: 1 }));
  }

  const modeFor = (k) => (offline ? 'cache' : mode || (k.tracked ? sc.mode_tracked : sc.mode_explore));
  const since = daysAgoUTC(sc.recompute_days, new Date(`${date}T12:00:00Z`));
  const lastRow = d.prepare(
    `SELECT s.day, s.score_method FROM kw_signals s JOIN keywords k ON k.keyword_id=s.keyword_id
      WHERE k.term=? AND s.geo=? AND s.day<=? ORDER BY s.day DESC LIMIT 1`);
  const todo = dict.filter((k) => {
    if (force) return true;
    const last = lastRow.get(k.term, geo, date);
    return !(last && last.day >= since && QUALITY[last.score_method] >= QUALITY[modeFor(k)]);
  });
  const queue = limit ? todo.slice(0, limit) : todo;
  log(`  ${geo}: словарь ${dict.length}, к расчёту ${queue.length}` +
      `${todo.length > queue.length ? ` (из ${todo.length}, --limit)` : ''}, свежих ${dict.length - todo.length}`);

  const cache = suggestCache({ geo, hl, date, ttlDays: sc.suggest_cache_days, offline });
  const ctx = loadSerpContext(d, geo, date);
  const ext = loadExternal(d, geo, date);
  const geoCount = d.prepare(`SELECT COUNT(DISTINCT geo) c FROM raw_suggest WHERE suggestion=?`);
  const stop = cfg.stopwords[lang] || [];

  const ins = d.prepare(`INSERT OR REPLACE INTO kw_signals (
      keyword_id, geo, day, score, min_prefix_len, avg_suggest_pos, kp_volume, trends_index, asa_popularity,
      top10_installs_median, top10_reviews_median, title_match_share, total_results,
      score_raw, score_raw_norm, prefix_hit_share, score_method, probes, prefixes_total, requests,
      installs_spread, suggest_geo_count, words, chars, stopword_share, is_brand, lang, is_translit,
      category, score_group, serp_date, tracked)
    VALUES (@keyword_id, @geo, @day, NULL, @min_prefix_len, @avg_suggest_pos, @kp_volume, @trends_index, @asa_popularity,
      @top10_installs_median, @top10_reviews_median, @title_match_share, @total_results,
      @score_raw, @score_raw_norm, @prefix_hit_share, @score_method, @probes, @prefixes_total, @requests,
      @installs_spread, @suggest_geo_count, @words, @chars, @stopword_share, @is_brand, @lang, @is_translit,
      @category, NULL, @serp_date, @tracked)`);

  let done = 0, errors = 0, noSignal = 0, cacheHits = 0, stoppedBy = null, budgetLeft = 0;
  for (const k of queue) {
    if (!offline && cache.stats.requests >= sc.max_requests_per_geo) { budgetLeft = queue.length - done - errors - noSignal; stoppedBy = 'бюджет запросов'; break; }
    let res;
    try {
      res = await scorePhrase(k.term, {
        lookup: cache.lookup, peek: cache.peek, mode: modeFor(k),
        minPrefix: sc.min_prefix, minPrefixByScript: sc.min_prefix_by_script, maxPrefix: sc.max_prefix, posExponent: sc.pos_exponent,
      });
    } catch (e) {
      if (e instanceof CaptchaStop) { stoppedBy = e.message; break; }
      if (e instanceof ProbeError) { errors++; continue; }
      throw e;
    }
    cacheHits += res.cache_hits;
    // Без единого снятого префикса строку не пишем: «сигнала нет» — это отсутствие строки, а не ноль.
    if (res.score_raw == null) { noSignal++; continue; }
    const serp = serpFeatures(k.term, ctx);
    ins.run({
      keyword_id: keywordId(d, k.term), geo, day: date,
      min_prefix_len: res.min_prefix_len, avg_suggest_pos: res.avg_suggest_pos,
      kp_volume: ext.kp.get(k.term) ?? null, trends_index: ext.trends.get(k.term) ?? null, asa_popularity: ext.asa.get(k.term) ?? null,
      top10_installs_median: serp.top10_installs_median, top10_reviews_median: serp.top10_reviews_median,
      title_match_share: serp.title_match_share, total_results: serp.total_results,
      score_raw: res.score_raw, score_raw_norm: res.score_raw_norm, prefix_hit_share: res.prefix_hit_share,
      score_method: res.method, probes: JSON.stringify(res.probes), prefixes_total: res.prefixes_total, requests: res.requests,
      installs_spread: serp.installs_spread, suggest_geo_count: geoCount.get(k.term).c,
      ...phraseFeatures(k.term, lang, stop),
      is_brand: brandFlag(k.term, k.is_brand, serp.top10),
      category: serp.category, serp_date: serp.serp_date, tracked: k.tracked ? 1 : 0,
    });
    done++;
    if (done % 50 === 0) log(`  ${geo}: ${done}/${queue.length}, запросов ${cache.stats.requests}, префиксов из кэша ${cacheHits}`);
  }

  const normalized = normalizeDay(d, geo, date);

  const s = cache.stats;
  const errShare = s.requests ? (s.errors + s.shape_errors) / s.requests : 0;
  const status = stoppedBy && !stoppedBy.startsWith('бюджет') ? 'stopped' : errShare > cfg.health.suggest_error_share_max ? 'suspect' : 'ok';
  d.prepare(`INSERT OR REPLACE INTO kw_runs (run_id, stage, geo, day, started_at, finished_at, status, requests, cache_hits, errors, shape_errors, empty, notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(runId, 'kw-signals', geo, date, startedAt, new Date().toISOString(), status, s.requests, cacheHits, s.errors, s.shape_errors, s.empty,
      `посчитано ${done}, без снятых префиксов ${noSignal}, ошибок фраз ${errors}, нормировано ${normalized}` + (stoppedBy ? `; остановлено: ${stoppedBy}${budgetLeft ? `, осталось ${budgetLeft}` : ''}` : ''));
  if (status === 'suspect') warn(`  ${geo}: доля ошибок подсказок ${(errShare * 100).toFixed(1)} % — возможен дрейф парсера (раздел 10)`);
  if (stoppedBy) warn(`  ${geo}: остановлено — ${stoppedBy}`);
  log(`  ${geo}: посчитано ${done}, без снятых префиксов ${noSignal}, ошибок ${errors}; запросов ${s.requests}, префиксов из кэша ${cacheHits}, пустых ответов ${s.empty}`);
  return { done, errors, stats: s, stoppedBy };
}

// Шкала 0–100 для строк дня — против накопленного словаря гео (последняя строка каждого слова).
export function normalizeDay(d, geo, date) {
  const cfg = kwConfig().score;
  const field = cfg.normalization === 'max' ? 'score_raw_norm' : 'score_raw';
  const rows = d.prepare(
    `SELECT s.keyword_id, s.day, s.score_raw, s.score_raw_norm, s.category FROM kw_signals s
       JOIN (SELECT keyword_id, MAX(day) md FROM kw_signals WHERE geo=? AND day<=? GROUP BY keyword_id) f
         ON f.keyword_id=s.keyword_id AND f.md=s.day
      WHERE s.geo=?`).all(geo, date, geo);
  const ranks = percentileScores(rows, { groupOf: (r) => r.category || '—', minGroupSize: cfg.min_group_size, field });
  const up = d.prepare(`UPDATE kw_signals SET score=?, score_group=? WHERE keyword_id=? AND geo=? AND day=?`);
  let n = 0;
  d.transaction(() => {
    for (const r of rows) {
      if (r.day !== date) continue;
      const v = ranks.get(r);
      if (!v) continue;
      up.run(v.score, v.group, r.keyword_id, geo, date);
      n++;
    }
  })();
  return n;
}
