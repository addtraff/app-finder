#!/usr/bin/env node
// hints-probe.mjs — живой замер автоподсказок App Store (MZSearchHints) как сигнала спроса.
// Node ≥ 22, без зависимостей (global fetch). Вывод — JSON в stdout (и в --out файл).
//
// Что делает (план §2 задания 2N):
//   1. Для каждой фразы K снимает все префиксы длиной minPrefix…len(K) (и полную фразу) на storefront.
//   2. Фиксирует формат ответа (plist XML / JSON), список term+priority+url (если есть), число подсказок.
//   3. Анализ: (a) постоянен ли priority одного term между префиксами; (b) отсортирован ли список по
//      priority убыванию; (c) максимум подсказок и зависимость от длины префикса; (d) влияние заголовка
//      X-Apple-Store-Front (,29 / ,24 t:native / без / language id) и параметров (e=true, Accept: json);
//      (e) метка выхода (--egress) для сравнения двух IP; (f) темп 1/2/5 rps — когда пустой ответ/429;
//      (g) …/wa/trends?maxCount=10; (h) бренды/названия приложений: url содержит src=hint? совпадение
//      с названием top-1 iTunes Search; (i) Spearman priority vs ASA popularity по CSV (--asa).
//
// Запуск:
//   node hints-probe.mjs                      # полный прогон по встроенному списку фраз, US+DE+JP
//   node hints-probe.mjs --only=prefix,header # подмножество этапов: prefix,header,rate,trends,brand,asa
//   node hints-probe.mjs --rps=1 --egress=home --out=hints-probe.json
//   node hints-probe.mjs --asa=asa.csv        # CSV: term,popularity  (US; например из Asodesk/Apple Ads)
//   node hints-probe.mjs --phrases=p.txt      # свой список: строка = "<cc>\t<фраза>" или просто фраза (US)
//
// Прокси: Node 22 fetch НЕ читает HTTPS_PROXY. Если нужен прокси — запускать с машины с прямым доступом
// или через undici ProxyAgent (не входит в «без зависимостей»).

import { writeFileSync, readFileSync } from 'node:fs';

// ---------- аргументы ----------
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const RPS = Number(args.rps ?? 1);
const EGRESS = String(args.egress ?? 'default');
const OUT = args.out ? String(args.out) : null;
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const MIN_PREFIX = Number(args.minPrefix ?? 3);
const stage = (s) => !ONLY || ONLY.has(s);

// ---------- константы ----------
const HINTS = 'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints';
const TRENDS = 'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/trends';
const SEARCH = 'https://itunes.apple.com/search';
const UA = 'iTunes/12.12 (Macintosh; OS X 13.0) AppleWebKit/605.1.15';
// storefront id (без языка) — app-store-scraper/constants.js
const SF = { us: '143441', de: '143443', jp: '143462', gb: '143444', fr: '143442', ru: '143469', br: '143503' };
// language id (второй параметр через дефис) — tweaselORG/parse-tunes consts.ts
const LANG = { 'en-US': 1, 'en-GB': 2, 'fr-FR': 3, 'de-DE': 4, 'es-ES': 8, 'ja-JP': 9, 'pt-BR': 15, 'ru-RU': 16, 'es-MX': 28 };

// 30 фраз US + 5 локальных DE/JP
const DEFAULT_PHRASES = [
  // 10 головных
  ...['habit tracker', 'calorie counter', 'vpn', 'photo editor', 'budget', 'meditation', 'sleep sounds',
      'pdf scanner', 'workout', 'video compressor'].map((t) => ['us', t, 'head']),
  // 10 long-tail
  ...['habit tracker with reminders', 'calorie counter with barcode scanner', 'free vpn for iphone',
      'photo editor remove background', 'budget planner for couples', 'meditation for sleep and anxiety',
      'white noise for baby sleep', 'scan documents to pdf', 'home workout no equipment',
      'compress video for whatsapp'].map((t) => ['us', t, 'longtail']),
  // 5 брендов
  ...['duolingo', 'instagram', 'tiktok', 'spotify', 'notion'].map((t) => ['us', t, 'brand']),
  // 5 локальных
  ['de', 'kalorienzähler', 'local'], ['de', 'haushaltsbuch', 'local'], ['de', 'einschlafhilfe', 'local'],
  ['jp', 'カロリー計算', 'local'], ['jp', '家計簿', 'local'],
];

// ---------- утилиты ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0;
async function throttle(rps = RPS) {
  const gap = 1000 / rps;
  const wait = lastAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
const chars = (s) => Array.from(norm(s));

// ---------- мини-парсер plist (dict/array/string/integer/real/true/false) ----------
function parsePlist(xml) {
  const tokens = [];
  const re = /<\?[^>]*\?>|<!DOCTYPE[^>]*>|<\/?([a-zA-Z]+)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('<?') || m[0].startsWith('<!')) continue;
    if (m[3] !== undefined) { if (m[3].trim()) tokens.push({ text: m[3] }); continue; }
    tokens.push({ tag: m[1], close: m[0].startsWith('</'), self: m[2] === '/' });
  }
  let i = 0;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
  function value() {
    const t = tokens[i++];
    if (!t || !t.tag || t.close) return undefined;
    if (t.tag === 'plist') return value();
    if (t.tag === 'true' || t.tag === 'false') { if (!t.self) i++; return t.tag === 'true'; }
    if (t.tag === 'dict') {
      const d = {};
      while (tokens[i] && !(tokens[i].tag === 'dict' && tokens[i].close)) {
        const k = tokens[i++]; // <key>
        const kt = tokens[i]?.text ? unesc(tokens[i++].text) : '';
        if (tokens[i]?.tag === 'key' && tokens[i].close) i++;
        if (!k || k.tag !== 'key') break;
        d[kt] = value();
      }
      i++; // </dict>
      return d;
    }
    if (t.tag === 'array') {
      const a = [];
      if (t.self) return a;
      while (tokens[i] && !(tokens[i].tag === 'array' && tokens[i].close)) a.push(value());
      i++;
      return a;
    }
    // string / integer / real / date / data
    if (t.self) return t.tag === 'string' ? '' : null;
    let txt = '';
    if (tokens[i]?.text) txt = unesc(tokens[i++].text);
    if (tokens[i]?.tag === t.tag && tokens[i].close) i++;
    if (t.tag === 'integer') return Number.parseInt(txt, 10);
    if (t.tag === 'real') return Number(txt);
    return txt;
  }
  while (tokens[i] && tokens[i].close) i++;
  return value();
}

// Приводим ответ к единому виду: { format, shape, hints:[{term, displayTerm, priority, url, extra}], n, raw_keys }
function normalizeHints(body, contentType = '') {
  const t = body.trim();
  let format, root;
  if (t.startsWith('<')) {
    format = 'plist';
    try { root = parsePlist(t); } catch (e) { return { format, shape: 'parse-error', error: String(e), hints: [], n: 0 }; }
  } else {
    format = 'json';
    try { root = JSON.parse(t); } catch (e) { return { format: contentType.includes('json') ? 'json' : 'unknown', shape: 'parse-error', error: String(e), hints: [], n: 0, head: t.slice(0, 200) }; }
  }
  let list = null, shape = 'unknown';
  if (Array.isArray(root)) { list = root; shape = 'array'; }
  else if (root && Array.isArray(root.hints)) { list = root.hints; shape = 'dict.hints'; }        // современная: {title:"Suggestions", hints:[…]}
  else if (root && typeof root === 'object') {
    const arr = Object.values(root).find((v) => Array.isArray(v));
    if (arr) { list = arr; shape = 'dict.<array>'; }                                                // legacy 2015: <dict><array><dict>term/priority/url
  }
  if (!list) return { format, shape: 'no-list', hints: [], n: 0, raw_keys: root && typeof root === 'object' ? Object.keys(root) : [] };
  const keyset = new Set();
  const hints = list.map((h, idx) => {
    if (typeof h === 'string') return { rank: idx + 1, term: h };
    Object.keys(h || {}).forEach((k) => keyset.add(k));
    const pr = h.priority ?? h.score ?? null;
    return {
      rank: idx + 1,
      term: h.term ?? h.displayTerm ?? h.searchTerm ?? null,
      displayTerm: h.displayTerm ?? null,
      priority: pr == null ? null : Number(pr),
      url: h.url ?? null,
      src_hint: typeof h.url === 'string' ? /src=hint/.test(h.url) : null,
      kind: h.kind ?? h.type ?? null,
    };
  });
  return { format, shape, hints, n: hints.length, keys: [...keyset], title: root?.title ?? null };
}

// ---------- HTTP ----------
async function getRaw(url, headers, { rps = RPS } = {}) {
  await throttle(rps);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'manual' });
    const body = await res.text();
    return { status: res.status, ms: Date.now() - t0, contentType: res.headers.get('content-type') || '', retryAfter: res.headers.get('retry-after'), body };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: String(e?.cause?.code || e.message || e), body: '' };
  }
}

function hintsUrl(term, { param = 'term', extra = '' } = {}) {
  return `${HINTS}?clientApplication=Software&${param}=${encodeURIComponent(term)}${extra}`;
}

async function fetchHints(term, cc, { header, param, extra, accept, rps } = {}) {
  const headers = {};
  const hv = header === undefined ? `${SF[cc]},29` : header; // undefined → стандарт; null → без заголовка
  if (hv) headers['X-Apple-Store-Front'] = hv;
  if (accept) headers.Accept = accept;
  const r = await getRaw(hintsUrl(term, { param, extra }), headers, { rps });
  const parsed = r.status >= 200 && r.status < 300 ? normalizeHints(r.body, r.contentType) : { format: null, shape: null, hints: [], n: 0 };
  return { term, cc, header: hv ?? null, param: param ?? 'term', extra: extra ?? '', accept: accept ?? null, status: r.status, ms: r.ms, contentType: r.contentType, retryAfter: r.retryAfter, error: r.error ?? null, ...parsed, body_head: r.body.slice(0, 300) };
}

// ---------- статистика ----------
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}
const isSortedDesc = (a) => a.every((v, i) => i === 0 || a[i - 1] >= v);

// ---------- этапы ----------
const out = { meta: { started: new Date().toISOString(), node: process.version, rps: RPS, egress: EGRESS, min_prefix: MIN_PREFIX }, stages: {} };

function loadPhrases() {
  if (!args.phrases) return DEFAULT_PHRASES;
  return readFileSync(String(args.phrases), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const [a, b] = line.split('\t');
    return b ? [a.trim().toLowerCase(), b.trim(), 'custom'] : ['us', a.trim(), 'custom'];
  });
}

// (a)(b)(c) лестница префиксов
async function stagePrefix() {
  const phrases = loadPhrases();
  const responses = [];
  for (const [cc, phrase, group] of phrases) {
    const cs = chars(phrase);
    const lens = new Set();
    for (let i = Math.min(MIN_PREFIX, cs.length); i <= cs.length; i++) lens.add(i);
    for (const i of [...lens].sort((a, b) => a - b)) {
      const prefix = cs.slice(0, i).join('');
      const r = await fetchHints(prefix, cc);
      responses.push({ group, phrase, prefix, prefix_len: i, ...r });
      process.stderr.write(`[prefix] ${cc} «${prefix}» → ${r.status} ${r.format ?? ''}/${r.shape ?? ''} n=${r.n}\n`);
    }
  }
  // анализ
  const byTerm = new Map(); // `${cc}|${term}` -> [{prefix_len, priority, rank, n}]
  let withPriority = 0, sortedDesc = 0, withList = 0, maxN = 0;
  const nByLen = {};
  for (const r of responses) {
    if (!r.hints.length) continue;
    withList++;
    maxN = Math.max(maxN, r.n);
    (nByLen[r.prefix_len] ||= []).push(r.n);
    const prs = r.hints.map((h) => h.priority).filter((p) => p != null);
    if (prs.length) { withPriority++; if (isSortedDesc(prs)) sortedDesc++; }
    for (const h of r.hints) {
      const k = `${r.cc}|${norm(h.term)}`;
      (byTerm.get(k) || byTerm.set(k, []).get(k)).push({ prefix: r.prefix, prefix_len: r.prefix_len, priority: h.priority, rank: h.rank, n: r.n });
    }
  }
  let multi = 0, constant = 0;
  const spreads = [];
  const examples = [];
  for (const [k, obs] of byTerm) {
    const prs = obs.map((o) => o.priority).filter((p) => p != null);
    if (prs.length < 2) continue;
    multi++;
    const mn = Math.min(...prs), mx = Math.max(...prs);
    if (mn === mx) constant++;
    spreads.push(mx - mn);
    if (examples.length < 25) examples.push({ term: k, obs: obs.map((o) => [o.prefix_len, o.priority, o.rank]) });
  }
  // появление целевой фразы: min_prefix_len, hint_rank
  const perPhrase = phrases.map(([cc, phrase, group]) => {
    const rs = responses.filter((r) => r.cc === cc && r.phrase === phrase && r.status === 200);
    const target = norm(phrase);
    const hits = rs.map((r) => ({ prefix_len: r.prefix_len, hit: r.hints.find((h) => norm(h.term) === target) || null, n: r.n }));
    const first = hits.find((h) => h.hit);
    const full = rs.find((r) => r.prefix === target);
    const fullHit = full?.hints.find((h) => norm(h.term) === target) || null;
    return {
      cc, phrase, group, requests: rs.length, hints_n_full: full?.n ?? null,
      min_prefix_len: first?.prefix_len ?? null,
      hint_rank_at_min_prefix: first?.hit?.rank ?? null,
      priority_at_min_prefix: first?.hit?.priority ?? null,
      hint_rank_full: fullHit?.rank ?? null, hint_priority_full: fullHit?.priority ?? null,
      priority_track: hits.filter((h) => h.hit).map((h) => [h.prefix_len, h.hit.priority, h.hit.rank]),
    };
  });
  out.stages.prefix = {
    summary: {
      responses: responses.length, with_list: withList, with_priority_field: withPriority,
      priority_present: withPriority > 0,
      sorted_desc_share: withPriority ? sortedDesc / withPriority : null,
      max_hints_per_response: maxN,
      hints_n_by_prefix_len: Object.fromEntries(Object.entries(nByLen).map(([l, a]) => [l, { mean: a.reduce((s, v) => s + v, 0) / a.length, max: Math.max(...a), k: a.length }])),
      terms_seen_on_2plus_prefixes: multi,
      terms_with_constant_priority: constant,
      constant_share: multi ? constant / multi : null,
      spread_quantiles: spreads.length ? quantiles(spreads) : null,
      formats: count(responses.map((r) => `${r.status}:${r.format}/${r.shape}`)),
    },
    per_phrase: perPhrase,
    term_examples: examples,
    responses: responses.map(({ body_head, ...r }) => r),
  };
}
function quantiles(a) { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { min: s[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), max: s[s.length - 1] }; }
function count(arr) { const m = {}; for (const v of arr) m[v] = (m[v] || 0) + 1; return m; }

// (d) заголовки, язык, параметры
async function stageHeader() {
  const probes = [['us', 'habit tracker'], ['us', 'vpn'], ['de', 'kalorienzähler'], ['jp', 'カロリー計算'], ['jp', 'calorie']];
  const variants = (cc) => [
    { name: 'std_29', header: `${SF[cc]},29` },
    { name: 'p24_native', header: `${SF[cc]},24 t:native` },
    { name: 'no_header', header: null },
    { name: 'sf_only', header: SF[cc] },
    { name: 'lang_en-US', header: `${SF[cc]}-1,29` },
    { name: 'lang_es-MX', header: `${SF[cc]}-28,29` },
    { name: 'lang_ru-RU', header: `${SF[cc]}-16,29` },
    { name: 'lang_native', header: `${SF[cc]}-${cc === 'de' ? LANG['de-DE'] : cc === 'jp' ? LANG['ja-JP'] : 1},29` },
    { name: 'e_true_media', header: `${SF[cc]},29`, extra: '&e=true&media=software' },
    { name: 'accept_json', header: `${SF[cc]},29`, accept: 'application/json' },
    { name: 'legacy_q', header: `${SF[cc]},29`, param: 'q', extra: '&media=software' },
    { name: 'legacy_q_nohdr', header: null, param: 'q', extra: '&media=software' },
  ];
  const rows = [];
  for (const [cc, term] of probes) {
    const base = await fetchHints(term, cc);
    const baseTerms = base.hints.map((h) => norm(h.term));
    for (const v of variants(cc)) {
      const r = await fetchHints(term, cc, { header: v.header, param: v.param, extra: v.extra, accept: v.accept });
      const terms = r.hints.map((h) => norm(h.term));
      const same = terms.length === baseTerms.length && terms.every((t, i) => t === baseTerms[i]);
      const overlap = terms.filter((t) => baseTerms.includes(t)).length;
      const prDiff = r.hints.filter((h) => h.priority != null).map((h) => { const b = base.hints.find((x) => norm(x.term) === norm(h.term)); return b && b.priority != null ? h.priority - b.priority : null; }).filter((d) => d != null);
      const latinOnly = terms.every((t) => /^[\x00-\x7F]*$/.test(t));
      rows.push({ cc, term, variant: v.name, header: r.header, param: r.param, extra: r.extra, accept: r.accept, status: r.status, format: r.format, shape: r.shape, keys: r.keys ?? null, n: r.n, same_list_as_std: same, overlap_with_std: overlap, priority_deltas: prDiff, all_ascii_terms: latinOnly, terms: terms.slice(0, 10), body_head: r.status === 200 ? r.body_head.slice(0, 160) : r.body_head });
      process.stderr.write(`[header] ${cc} «${term}» ${v.name} → ${r.status} n=${r.n} same=${same}\n`);
    }
  }
  out.stages.header = rows;
}

// (f) темп
async function stageRate() {
  const terms = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't'].map((c) => `${c}ap`);
  const res = {};
  for (const rps of [1, 2, 5]) {
    const rows = [];
    for (const t of terms) {
      const r = await fetchHints(t, 'us', { rps });
      rows.push({ term: t, status: r.status, n: r.n, ms: r.ms, retryAfter: r.retryAfter, error: r.error });
    }
    res[`rps_${rps}`] = { empty: rows.filter((r) => r.status === 200 && r.n === 0).length, http429: rows.filter((r) => r.status === 429).length, other_errors: rows.filter((r) => r.status !== 200 && r.status !== 429).length, first_bad_index: rows.findIndex((r) => r.status !== 200 || r.n === 0), rows };
    process.stderr.write(`[rate] ${rps} rps → empty=${res[`rps_${rps}`].empty} 429=${res[`rps_${rps}`].http429}\n`);
    await sleep(5000);
  }
  out.stages.rate = res;
}

// (g) trends
async function stageTrends() {
  const rows = [];
  for (const [cc, hv] of [['us', `${SF.us},29`], ['us', `${SF.us},24 t:native`], ['us', null], ['us', `${SF.us},28`], ['de', `${SF.de},29`]]) {
    const h = { Accept: 'application/json, text/xml;q=0.9, */*;q=0.8' };
    if (hv) h['X-Apple-Store-Front'] = hv;
    const r = await getRaw(`${TRENDS}?maxCount=10`, h);
    let parsed = null;
    if (r.status === 200) { try { parsed = r.body.trim().startsWith('<') ? parsePlist(r.body) : JSON.parse(r.body); } catch { parsed = null; } }
    rows.push({ cc, header: hv, status: r.status, contentType: r.contentType, parsed_type: Array.isArray(parsed) ? 'array' : typeof parsed, keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 10) : null, sample: parsed ? JSON.stringify(parsed).slice(0, 400) : r.body.slice(0, 300) });
    process.stderr.write(`[trends] ${cc} ${hv} → ${r.status}\n`);
  }
  out.stages.trends = rows;
}

// (h) бренды / названия приложений среди подсказок
async function stageBrand() {
  const seeds = [['us', 'duol'], ['us', 'insta'], ['us', 'tik'], ['us', 'habit'], ['us', 'calorie']];
  const rows = [];
  for (const [cc, seed] of seeds) {
    const r = await fetchHints(seed, cc);
    for (const h of r.hints.slice(0, 10)) {
      await throttle(RPS);
      let top = null;
      try {
        const s = await fetch(`${SEARCH}?term=${encodeURIComponent(h.term)}&country=${cc}&entity=software&limit=3`, { headers: { 'User-Agent': UA } });
        const j = await s.json();
        top = (j.results || []).map((a) => a.trackName);
      } catch { /* ignore */ }
      const exactApp = top?.some((n) => norm(n) === norm(h.term) || norm(n).startsWith(norm(h.term) + ' ')) ?? null;
      rows.push({ cc, seed, rank: h.rank, term: h.term, displayTerm: h.displayTerm, priority: h.priority, url: h.url, src_hint: h.src_hint, kind: h.kind, top3_apps: top, looks_like_app_name: exactApp });
    }
  }
  out.stages.brand = rows;
}

// (i) Spearman против ASA popularity
async function stageAsa() {
  if (!args.asa) { out.stages.asa = { skipped: 'нет --asa=file.csv (term,popularity)' }; return; }
  const rows = readFileSync(String(args.asa), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(/[,;\t]/)).filter((p) => p.length >= 2 && !Number.isNaN(Number(p[1])));
  const pairs = [];
  const detail = [];
  for (const [term, pop] of rows) {
    const r = await fetchHints(term, 'us');
    const hit = r.hints.find((h) => norm(h.term) === norm(term)) || null;
    detail.push({ term, asa: Number(pop), hint_priority: hit?.priority ?? null, hint_rank: hit?.rank ?? null, hints_n: r.n, present: !!hit });
    if (hit && hit.priority != null) pairs.push([hit.priority, Number(pop)]);
  }
  // fallback-шкала без priority: присутствие (1/0) и rank → сравнить ранговую корреляцию по -rank
  const rankPairs = detail.filter((d) => d.hint_rank != null).map((d) => [-d.hint_rank, d.asa]);
  out.stages.asa = {
    n_terms: detail.length, n_with_priority: pairs.length,
    spearman_priority_vs_asa: pairs.length >= 3 ? spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null,
    spearman_negrank_vs_asa: rankPairs.length >= 3 ? spearman(rankPairs.map((p) => p[0]), rankPairs.map((p) => p[1])) : null,
    presence_rate: detail.length ? detail.filter((d) => d.present).length / detail.length : null,
    detail,
  };
}

// ---------- selftest парсера (без сети): node hints-probe.mjs --selftest ----------
function selftest() {
  const legacy2015 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>hints</key><array>
<dict><key>term</key><string>facebook</string><key>priority</key><integer>10743</integer><key>url</key><string>https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search?submit=edit&amp;term=facebook&amp;media=software&amp;src=hint</string></dict>
<dict><key>term</key><string>facebook messenger</string><key>priority</key><integer>7557</integer><key>url</key><string>https://x/?src=hint</string></dict>
</array></dict></plist>`;
  const modern = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>title</key><string>Suggestions</string><key>hints</key>
<array><dict><key>displayTerm</key><string>meditation free</string><key>term</key><string>meditation free</string></dict>
<dict><key>displayTerm</key><string>meditation timer</string><key>term</key><string>meditation timer</string></dict></array></dict></plist>`;
  const emptyModern = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>title</key><string>Suggestions</string><key>hints</key><array/></dict></plist>`;
  const jsonArr = `[{"term":"panda pop","censoredTerm":"panda pop","score":"7557"},{"term":"panda","censoredTerm":"panda","score":"5512"}]`;
  const jsonDict = `{"title":"Suggestions","hints":[{"displayTerm":"vpn free","term":"vpn free"}]}`;
  const cases = [
    ['legacy2015', legacy2015, (r) => r.format === 'plist' && r.shape === 'dict.hints' && r.n === 2 && r.hints[0].priority === 10743 && r.hints[0].src_hint === true && r.hints[1].term === 'facebook messenger'],
    ['modern', modern, (r) => r.format === 'plist' && r.shape === 'dict.hints' && r.n === 2 && r.hints[0].priority === null && r.hints[1].term === 'meditation timer' && r.title === 'Suggestions'],
    ['emptyModern', emptyModern, (r) => r.format === 'plist' && r.n === 0 && r.shape === 'dict.hints'],
    ['jsonArr', jsonArr, (r) => r.format === 'json' && r.shape === 'array' && r.n === 2 && r.hints[0].priority === 7557],
    ['jsonDict', jsonDict, (r) => r.format === 'json' && r.shape === 'dict.hints' && r.n === 1 && r.hints[0].term === 'vpn free'],
    ['garbage', 'not xml at all', (r) => r.shape === 'parse-error' && r.n === 0],
  ];
  let ok = true;
  for (const [name, body, check] of cases) {
    const r = normalizeHints(body);
    const pass = check(r);
    ok = ok && pass;
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name} → ${JSON.stringify({ format: r.format, shape: r.shape, n: r.n, first: r.hints[0] ?? null })}\n`);
  }
  const sp = spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]);
  process.stdout.write(`${Math.abs(sp - 0.8) < 1e-9 ? 'PASS' : 'FAIL'} spearman=${sp}\n`);
  process.exit(ok ? 0 : 1);
}
if (args.selftest) selftest();

// ---------- main ----------
(async () => {
  // смоук: один запрос — жив ли эндпоинт вообще
  const smoke = await fetchHints('habit', 'us');
  out.meta.smoke = { status: smoke.status, format: smoke.format, shape: smoke.shape, keys: smoke.keys ?? null, n: smoke.n, error: smoke.error, body_head: smoke.body_head.slice(0, 200) };
  process.stderr.write(`[smoke] ${smoke.status} ${smoke.format}/${smoke.shape} n=${smoke.n} keys=${JSON.stringify(smoke.keys)}\n`);
  if (smoke.status === 0) {
    out.meta.verdict = 'NO_NETWORK: эндпоинт недоступен (DNS/прокси). Запускать с машины с прямым доступом.';
  } else {
    if (stage('prefix')) await stagePrefix();
    if (stage('header')) await stageHeader();
    if (stage('brand')) await stageBrand();
    if (stage('trends')) await stageTrends();
    if (stage('asa')) await stageAsa();
    if (stage('rate')) await stageRate();
    const p = out.stages.prefix?.summary;
    out.meta.verdict = !p ? 'partial' : !p.priority_present
      ? 'PRIORITY_ABSENT: поле priority в ответах нет — вариант kw-модуля «1 запрос/фраза по priority» невозможен; использовать лестницу префиксов (присутствие + rank).'
      : p.constant_share >= 0.9
        ? 'PRIORITY_IS_TERM_PROPERTY: priority стабилен между префиксами (≥90%) — допустим 1 запрос на фразу.'
        : 'PRIORITY_IS_PREFIX_DEPENDENT: priority меняется между префиксами — хранить как доп. признак, лестница нужна.';
  }
  out.meta.finished = new Date().toISOString();
  const json = JSON.stringify(out, null, 2);
  if (OUT) writeFileSync(OUT, json);
  process.stdout.write(json + '\n');
})();
