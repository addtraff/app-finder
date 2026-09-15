// Признаки раздела 5, кроме подсказок: из уже собранной выдачи, из самой фразы и внешние.
// Выдача не переснимается — берётся последний срез по фразе в гео не позже расчётного дня:
// из raw_search радара или из трекера kw_track_serp, какой свежее.
import { median } from '../util.js';
import { normTerm } from './schema.js';
import { scriptOf } from './popularity.js';

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const NON_LATIN_LANGS = { ja: ['han', 'hiragana', 'katakana'], ko: ['hangul'], zh: ['han'], ar: ['arabic'], he: ['hebrew'], ru: ['cyrillic'] };

export const langOf = (hl) => String(hl || 'en').split('-')[0].toLowerCase();

// Транслитерация или чужая письменность: латиница в гео с нелатинским языком и наоборот.
export function isTranslit(term, lang) {
  const script = scriptOf(term);
  if (script === 'other') return 0;
  const expected = NON_LATIN_LANGS[lang];
  if (expected) return expected.includes(script) ? 0 : 1;
  return script === 'latin' ? 0 : 1;
}

export function phraseFeatures(term, lang, stopwords = []) {
  const t = normTerm(term);
  const words = t.split(' ').filter(Boolean);
  const stop = new Set(stopwords);
  return {
    words: words.length,
    chars: Array.from(t).length,
    stopword_share: words.length ? words.filter((w) => stop.has(w)).length / words.length : null,
    lang,
    is_translit: isTranslit(t, lang),
  };
}

// Последние срезы выдачи и карточки по гео — одним проходом на весь словарь.
export function loadSerpContext(d, geo, date) {
  const slices = new Map();   // term -> { date, rows: [{position, app_id}] }
  const put = (r) => {
    const cur = slices.get(r.term);
    if (!cur || r.snapshot_date > cur.date) slices.set(r.term, { date: r.snapshot_date, rows: [] });
    const s = slices.get(r.term);
    if (s.date === r.snapshot_date) s.rows.push({ position: r.position, app_id: r.app_id });
  };
  for (const r of d.prepare(
    `SELECT r.keyword AS term, r.snapshot_date, r.position, r.app_id
       FROM raw_search r
       JOIN (SELECT keyword, MAX(snapshot_date) md FROM raw_search WHERE geo=? AND snapshot_date<=? GROUP BY keyword) f
         ON f.keyword=r.keyword AND f.md=r.snapshot_date
      WHERE r.geo=?`).iterate(geo, date, geo)) put(r);
  for (const r of d.prepare(
    `SELECT t.term, t.snapshot_date, t.position, t.app_id
       FROM kw_track_serp t
       JOIN (SELECT term, MAX(snapshot_date) md FROM kw_track_serp WHERE geo=? AND snapshot_date<=? GROUP BY term) f
         ON f.term=t.term AND f.md=t.snapshot_date
      WHERE t.geo=?`).iterate(geo, date, geo)) put(r);

  // Карточка: последний снимок в этом гео; если в гео приложения не снимали — в любом.
  // Установки у Play глобальные, так что откат на другое гео не искажает медиану.
  const cards = new Map();
  const cols = `p.app_id, p.max_installs, p.reviews_count, p.ratings_count, p.title, p.developer, p.genre_id, p.snapshot_date`;
  for (const r of d.prepare(
    `SELECT ${cols} FROM raw_app_page p
       JOIN (SELECT app_id, MAX(snapshot_date) md FROM raw_app_page GROUP BY app_id) f
         ON f.app_id=p.app_id AND f.md=p.snapshot_date
      GROUP BY p.app_id`).iterate()) cards.set(r.app_id, r);
  for (const r of d.prepare(
    `SELECT ${cols} FROM raw_app_page p
       JOIN (SELECT app_id, MAX(snapshot_date) md FROM raw_app_page WHERE geo=? GROUP BY app_id) f
         ON f.app_id=p.app_id AND f.md=p.snapshot_date
      WHERE p.geo=?
      GROUP BY p.app_id`).iterate(geo, geo)) cards.set(r.app_id, r);

  return { slices, cards };
}

export function serpFeatures(term, ctx) {
  const t = normTerm(term);
  const slice = ctx.slices.get(t);
  if (!slice || !slice.rows.length) {
    return { serp_date: null, total_results: null, top10_installs_median: null, top10_reviews_median: null,
      title_match_share: null, installs_spread: null, category: null, top10: [] };
  }
  const rows = [...slice.rows].sort((a, b) => a.position - b.position);
  const top10 = rows.filter((r) => r.position <= 10).map((r) => ({ ...r, card: ctx.cards.get(r.app_id) || null }));
  const installs = top10.map((r) => r.card?.max_installs).filter((v) => v != null);
  const reviews = top10.map((r) => r.card?.reviews_count ?? r.card?.ratings_count).filter((v) => v != null);
  const titled = top10.filter((r) => r.card?.title);
  const q = normTitle(t);
  const titleMatch = titled.length ? titled.filter((r) => normTitle(r.card.title).includes(q)).length / titled.length : null;

  const inst = (pos) => top10.find((r) => r.position === pos)?.card?.max_installs;
  const i1 = inst(1), i10 = inst(Math.max(...top10.map((r) => r.position)));
  const spread = i1 != null && i10 != null ? Math.log10(i1 + 1) - Math.log10(i10 + 1) : null;

  const genres = new Map();
  for (const r of top10) if (r.card?.genre_id) genres.set(r.card.genre_id, (genres.get(r.card.genre_id) || 0) + 1);
  const category = [...genres].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    serp_date: slice.date,
    // Радар снимает топ-50, поэтому «число результатов» здесь упирается в 50 — это глубина
    // выдачи в пределах среза, а не полное число результатов Play.
    total_results: rows.length,
    top10_installs_median: median(installs),
    top10_reviews_median: median(reviews),
    title_match_share: titleMatch,
    installs_spread: spread,
    category,
    top10,
  };
}

// Бренд: разметка радара (навигационный запрос) или совпадение с именем разработчика топ-3.
export function brandFlag(term, discIsBrand, top10) {
  if (discIsBrand) return 1;
  const q = normTitle(term);
  for (const r of top10.slice(0, 3)) {
    if (r.card?.developer && normTitle(r.card.developer) === q) return 1;
  }
  const titles = top10.map((r) => normTitle(r.card?.title)).filter(Boolean);
  if (titles[0] && (titles[0] === q || titles[0].startsWith(q + ' ')) && titles.filter((x) => x.includes(q)).length < 3) return 1;
  return 0;
}

// Keyword Planner отдаёт диапазоны; признак — десятичный логарифм середины (3.3).
export function parsePlannerRange(text) {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, '').replace(/,/g, '');
  if (!s) return null;
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)([kmкм]|тыс)?/g)].map((m) => {
    const mult = m[2] === 'k' || m[2] === 'к' || m[2] === 'тыс' ? 1e3 : m[2] === 'm' || m[2] === 'м' ? 1e6 : 1;
    return Math.round(Number(m[1]) * mult);
  });
  if (!nums.length) return null;
  const low = nums[0], high = nums.length > 1 ? nums[1] : nums[0];
  return { low, high, mid: (low + high) / 2 };
}

export function loadExternal(d, geo, date) {
  const kp = new Map(d.prepare(
    `SELECT keyword, avg_monthly_searches, range_low, range_high FROM raw_external_keyword_planner WHERE geo=?`).all(geo)
    .map((r) => {
      const mid = r.range_low != null && r.range_high != null ? (r.range_low + r.range_high) / 2 : r.avg_monthly_searches;
      return [r.keyword, mid != null && mid > 0 ? Math.log10(mid) : null];
    }));
  const asa = new Map(d.prepare(`SELECT keyword, popularity FROM raw_external_asa WHERE geo=?`).all(geo)
    .map((r) => [r.keyword, r.popularity]));
  const trends = new Map(d.prepare(
    `SELECT t.keyword, t.value FROM raw_external_trends t
       JOIN (SELECT keyword, MAX(point_date) md FROM raw_external_trends WHERE geo=? AND point_date<=? GROUP BY keyword) f
         ON f.keyword=t.keyword AND f.md=t.point_date
      WHERE t.geo=?`).all(geo, date, geo).map((r) => [r.keyword, r.value]));
  return { kp, asa, trends };
}

// Сезонный множитель (S4): профиль по месяцам — среднее значение месяца к среднему за год.
// Сначала собственный ряд слова (от 12 месяцев), иначе профиль категории, иначе 1.
export function seasonalProfile(d, geo, keywordsByCategory) {
  const rows = d.prepare(`SELECT keyword, point_date, value FROM raw_external_trends WHERE geo=? AND value IS NOT NULL`).all(geo);
  const byKw = new Map();
  for (const r of rows) {
    if (!byKw.has(r.keyword)) byKw.set(r.keyword, []);
    byKw.get(r.keyword).push(r);
  }
  const profileOf = (points) => {
    const months = new Map();
    for (const p of points) {
      const m = Number(String(p.point_date).slice(5, 7));
      if (!m) continue;
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(p.value);
    }
    if (months.size < 12) return null;
    const avg = new Map([...months].map(([m, v]) => [m, v.reduce((a, b) => a + b, 0) / v.length]));
    const year = [...avg.values()].reduce((a, b) => a + b, 0) / avg.size;
    if (!(year > 0)) return null;
    return Object.fromEntries([...avg].map(([m, v]) => [m, v / year]));
  };
  const own = new Map();
  for (const [kw, pts] of byKw) { const p = profileOf(pts); if (p) own.set(kw, p); }
  const byCategory = new Map();
  for (const [cat, kws] of keywordsByCategory) {
    const pts = kws.flatMap((k) => byKw.get(k) || []);
    const p = profileOf(pts);
    if (p) byCategory.set(cat, p);
  }
  return { own, byCategory };
}

