// Импорт внешних выгрузок: Play Console (ground truth), Keyword Planner, Google Trends, Apple Search Ads.
//
// Форматы файлов не зафиксированы в методике и у Google меняются, поэтому колонки ищутся по
// набору названий (английский и русский интерфейс), а недостающее задаётся флагами.
// Выгрузки Play Console и Keyword Planner приходят в UTF-16 LE с табуляцией — это распознаётся.
import fs from 'node:fs';
import path from 'node:path';
import { normTerm } from './schema.js';
import { parsePlannerRange } from './features.js';

export function readTable(file) {
  const buf = fs.readFileSync(file);
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
  else text = buf.toString('utf8');
  return parseCsv(text);
}

// CSV с кавычками и переводами строк внутри полей; разделитель — самый частый из , ; \t в первой строке.
export function parseCsv(text) {
  const firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
  const delim = [',', ';', '\t'].map((c) => [c, firstLine.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

const ALIASES = {
  term: ['search term', 'term', 'keyword', 'search keyword', 'поисковый запрос', 'запрос', 'ключевое слово'],
  day: ['date', 'day', 'дата', 'день'],
  geo: ['country', 'country / region', 'country/region', 'geo', 'страна', 'страна/регион', 'страна / регион'],
  lang: ['language', 'lang', 'store listing language', 'язык'],
  app: ['package name', 'package', 'app_id', 'app id', 'название пакета', 'пакет'],
  impressions: ['impressions', 'store listing impressions', 'search impressions', 'показы', 'показы страницы'],
  visitors: ['store listing visitors', 'visitors', 'посетители', 'посетители страницы', 'посетители страницы приложения'],
  acquisitions: ['store listing acquisitions', 'acquisitions', 'приобретения', 'приобретения через страницу'],
  unique_clicks: ['unique clicks', 'install button unique clicks', 'store listing unique clicks', 'уникальные клики', 'уникальные нажатия'],
};

function findColumns(header) {
  const h = header.map((c) => c.toLowerCase().replace(/\s+/g, ' ').replace(/[:*]/g, '').trim());
  const out = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    let idx = h.findIndex((c) => names.includes(c));
    if (idx < 0) idx = h.findIndex((c) => names.some((n) => n.length > 4 && c.startsWith(n)));
    out[key] = idx >= 0 ? idx : null;
  }
  return out;
}

let regionNames = null;
export function countryCode(value) {
  const v = String(value || '').trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  if (!regionNames) {
    regionNames = new Map();
    for (const lang of ['en', 'ru']) {
      const dn = new Intl.DisplayNames([lang], { type: 'region' });
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        try {
          const name = dn.of(code);
          if (name && name !== code) regionNames.set(name.toLowerCase(), code);
        } catch { /* нет такого кода */ }
      }
    }
  }
  return regionNames.get(v.toLowerCase()) || null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function parseDay(value) {
  const v = String(value || '').trim();
  let m;
  if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(m[1], m[2], m[3]);
  if ((m = v.match(/^(\d{4})(\d{2})(\d{2})$/))) return iso(m[1], m[2], m[3]);
  if ((m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) return iso(m[3], m[2], m[1]);
  if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return iso(m[3], m[1], m[2]);   // формат США: месяц/день
  if ((m = v.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/))) return MONTHS[m[1].toLowerCase()] ? iso(m[3], MONTHS[m[1].toLowerCase()], m[2]) : null;
  return null;
}
const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const num = (v) => {
  const s = String(v ?? '').replace(/[\s ,]/g, '');
  if (s === '' || s === '-' || s === '—') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const AGGREGATE_TERMS = new Set(['other', '(other)', 'others', 'прочее', 'другие', '(not set)', 'total', 'итого']);

// Play Console -> console_search_terms. Если в файле есть и приобретения, и уникальные клики,
// пишутся обе метрики отдельными строками: смешивает их не импорт, а обучение, и оно берёт одну.
export function importConsole(d, file, { app = null, geo = null, lang = null, metric = null, date }) {
  const rows = readTable(file);
  const header = rows[0];
  const col = findColumns(header);
  const problems = [];
  if (col.term == null) problems.push('колонка с поисковым запросом');
  if (col.day == null) problems.push('колонка с датой');
  if (col.visitors == null) problems.push('колонка с посетителями страницы');
  if (col.app == null && !app) problems.push('колонка с пакетом или флаг --app');
  if (col.geo == null && !geo) problems.push('колонка со страной или флаг --geo');
  if (problems.length) throw new Error(`в ${path.basename(file)} не найдены: ${problems.join(', ')}. Заголовок: ${header.join(' | ')}`);

  const kinds = metric ? [metric]
    : [col.unique_clicks != null ? 'unique_clicks' : null, col.acquisitions != null ? 'acquisitions' : null].filter(Boolean);
  if (!kinds.length) kinds.push('acquisitions');

  const ins = d.prepare(`INSERT OR REPLACE INTO console_search_terms
    (app_id, geo, lang, term, day, impressions, visitors, unique_clicks, metric_kind, is_censored, source_file, imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`);
  const stats = { rows: 0, skipped_aggregate: 0, skipped_bad: 0, kinds, days: new Set(), apps: new Set(), geos: new Set() };
  const now = new Date().toISOString();
  d.transaction(() => {
    for (const r of rows.slice(1)) {
      const term = normTerm(r[col.term]);
      if (!term || AGGREGATE_TERMS.has(term)) { stats.skipped_aggregate++; continue; }
      const day = parseDay(r[col.day]);
      const g = col.geo != null ? countryCode(r[col.geo]) : geo;
      const a = col.app != null ? r[col.app] : app;
      if (!day || !g || !a) { stats.skipped_bad++; continue; }
      const l = col.lang != null && r[col.lang] ? r[col.lang].toLowerCase() : (lang || '');
      for (const kind of kinds) {
        const conv = kind === 'unique_clicks' ? num(r[col.unique_clicks]) : num(r[col.acquisitions]);
        ins.run(a, g, l, term, day, col.impressions != null ? num(r[col.impressions]) : null, num(r[col.visitors]), conv, kind,
          path.basename(file), now);
      }
      stats.rows++;
      stats.days.add(day); stats.apps.add(a); stats.geos.add(g);
    }
  })();
  return { ...stats, days: stats.days.size, apps: [...stats.apps], geos: [...stats.geos], date };
}

// Keyword Planner: «Keyword» и «Avg. monthly searches» — число или диапазон «1K – 10K».
export function importPlanner(d, file, { geo = null }) {
  const rows = readTable(file);
  // Над заголовком у Keyword Planner служебные строки («Keyword Stats …»), поэтому заголовок —
  // первая строка, где есть и колонка слова, и колонка объёма.
  const h = rows.findIndex((r) => r.some((c) => /^(keyword|ключевое слово)$/i.test(c)) && r.some((c) => /searches|запросов/i.test(c)));
  if (h < 0) throw new Error('не найдена строка заголовка с колонками Keyword и Avg. monthly searches');
  const header = rows[h].map((c) => c.toLowerCase());
  const iK = header.findIndex((c) => /^keyword|ключев/.test(c));
  const iV = header.findIndex((c) => /avg\.? monthly searches|searches|среднее число запросов/.test(c));
  const iG = header.findIndex((c) => c === 'geo' || c === 'country' || c === 'страна');
  if (iV < 0) throw new Error('не найдена колонка Avg. monthly searches');
  const ins = d.prepare(`INSERT OR REPLACE INTO raw_external_keyword_planner (geo, keyword, avg_monthly_searches, imported_at, range_low, range_high)
    VALUES (?,?,?,?,?,?)`);
  let n = 0;
  const now = new Date().toISOString().slice(0, 10);
  d.transaction(() => {
    for (const r of rows.slice(h + 1)) {
      const kw = normTerm(r[iK]);
      const g = iG >= 0 ? countryCode(r[iG]) : geo;
      const range = parsePlannerRange(r[iV]);
      if (!kw || !g || !range) continue;
      ins.run(g, kw, Math.round(range.mid), now, range.low, range.high);
      n++;
    }
  })();
  return { rows: n };
}

// Google Trends multiTimeline.csv: служебные строки, затем «Week,слово: (United States),…».
export function importTrends(d, file, { geo }) {
  const rows = readTable(file);
  const h = rows.findIndex((r) => /^(week|month|day|неделя|месяц|день)$/i.test(r[0]));
  if (h < 0) throw new Error('не найдена строка заголовка Week/Month/Day');
  const terms = rows[h].slice(1).map((c) => normTerm(c.replace(/:\s*\(.*\)\s*$/, '')));
  const ins = d.prepare(`INSERT OR REPLACE INTO raw_external_trends (geo, keyword, point_date, value, imported_at) VALUES (?,?,?,?,?)`);
  let n = 0;
  const now = new Date().toISOString().slice(0, 10);
  d.transaction(() => {
    for (const r of rows.slice(h + 1)) {
      const day = parseDay(r[0]) || (/^\d{4}-\d{2}$/.test(r[0]) ? `${r[0]}-01` : null);
      if (!day) continue;
      terms.forEach((t, i) => {
        const raw = r[i + 1];
        const v = raw === '<1' ? 0.5 : Number(raw);
        if (!t || !Number.isFinite(v)) return;
        ins.run(geo, t, day, v, now);
        n++;
      });
    }
  })();
  return { points: n, terms: terms.length };
}

// Apple Search Ads: keyword, popularity (5–100), страна колонкой или флагом.
export function importAsa(d, file, { geo = null }) {
  const rows = readTable(file);
  const header = rows[0].map((c) => c.toLowerCase());
  const iK = header.findIndex((c) => /keyword|term|запрос/.test(c));
  const iP = header.findIndex((c) => /popularity|популярн/.test(c));
  const iG = header.findIndex((c) => /country|storefront|geo|страна/.test(c));
  if (iK < 0 || iP < 0) throw new Error(`нужны колонки keyword и popularity, есть: ${rows[0].join(' | ')}`);
  const ins = d.prepare(`INSERT OR REPLACE INTO raw_external_asa (geo, keyword, popularity, imported_at) VALUES (?,?,?,?)`);
  let n = 0;
  const now = new Date().toISOString().slice(0, 10);
  d.transaction(() => {
    for (const r of rows.slice(1)) {
      const g = iG >= 0 ? countryCode(r[iG]) : geo;
      const p = num(r[iP]);
      if (!r[iK] || !g || p == null) continue;
      ins.run(g, normTerm(r[iK]), p, now);
      n++;
    }
  })();
  return { rows: n };
}
