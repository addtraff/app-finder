#!/usr/bin/env node
// ios-smoke.mjs — живой smoke-test эндпоинтов App Store для ТЗ iOS-радара.
// Node >= 22, без зависимостей (только глобальный fetch). Запускать с машины, где нет egress-прокси.
//
//   node ios-smoke.mjs                      # полный прогон (~40–60 мин с паузами и темп-тестами)
//   node ios-smoke.mjs --skip-rate          # без серий «темп до отказа» (~10 мин)
//   node ios-smoke.mjs --rate-only          # только серии темпа (search + hints)
//   node ios-smoke.mjs --plan               # напечатать план URL без сети
//   node ios-smoke.mjs --cc us --cooldown 90 --out ./ios-smoke-result.json
//
// Выход: JSON (--out, по умолчанию ./ios-smoke-result.json рядом с cwd) + краткий отчёт в stdout.
// Каждая проверка пишет: http-статус, подмножество заголовков (retry-after, cache-control, age,
// x-cache, content-type, content-length, date), ключи верхнего уровня, число элементов, 2–3 примера полей,
// время ответа. Ошибки сети фиксируются как {error}, прогон не прерывается.

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CC = opt('--cc', 'us').toLowerCase();
const OUT = opt('--out', './ios-smoke-result.json');
const COOLDOWN_S = Number(opt('--cooldown', '60'));
const SKIP_RATE = flag('--skip-rate');
const RATE_ONLY = flag('--rate-only');
const PLAN = flag('--plan');
const PAUSE_MS = Number(opt('--pause', '1200')); // пауза между «обычными» запросами (≈0.8 rps)

// ---------- константы ----------
const STOREFRONT = { us: '143441', gb: '143444', de: '143443', fr: '143442', es: '143454', mx: '143468', ua: '143492', pl: '143478', br: '143503', jp: '143462' }[CC] || '143441';
const SF_GB = '143444';
const IOS_UA = 'AppStore/3.0 iOS/18.0 model/iPhone16,2 hwp/t8130 build/22A3354 (6; dt:326) AMS/1';
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const DUOLINGO = '570060128';
const GENRE = '6013'; // Health & Fitness
const TERM = 'habit tracker';
const HINT_PREFIX = 'habit';

// 90+ разных терминов для серий темпа (search) и префиксов (hints)
const TERMS = ('photo editor,budget planner,water reminder,sleep sounds,meditation,calorie counter,step counter,qr scanner,pdf scanner,' +
  'video compressor,voice recorder,white noise,baby tracker,period tracker,workout planner,running tracker,habit tracker,todo list,' +
  'notes app,journal,mood tracker,plant identifier,bird identifier,recipe,grocery list,invoice maker,resume builder,flashcards,' +
  'language learning,piano,guitar tuner,metronome,translator,currency converter,unit converter,tip calculator,mortgage calculator,' +
  'weather radar,tide chart,star map,compass,speedometer,parking,fuel log,car maintenance,bike computer,hiking map,fishing,' +
  'golf gps,chess,sudoku,crossword,word search,solitaire,mahjong,coloring book,drawing,logo maker,collage maker,' +
  'wallpapers,widgets,icon changer,ringtones,caller id,spam blocker,vpn,password manager,authenticator,file manager,' +
  'cloud storage,backup contacts,duplicate photos,phone cleaner,battery health,wifi analyzer,speed test,remote control tv,' +
  'universal remote,screen mirroring,baby monitor,pet camera,dog training,cat games,horoscope,tarot,bible,quran,prayer times,' +
  'countdown,alarm clock,pomodoro,focus timer,screen time,intermittent fasting,keto diet,recipes vegan,meal planner,' +
  'wine scanner,barcode scanner,price tracker,coupons,cashback,stock tracker,crypto wallet,expense splitter,shared list').split(',').map(s => s.trim());
const PREFIXES = TERMS.map(t => t.split(' ')[0].slice(0, 4));

// ---------- утилиты ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const R = { startedAt: now(), cc: CC, storefront: STOREFRONT, node: process.version, checks: {}, rate: {}, verdicts: {}, apps: {}, errors: [] };
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const HDR_KEEP = ['content-type', 'content-length', 'retry-after', 'cache-control', 'age', 'x-cache', 'date', 'x-apple-jingle-correlation-key', 'x-apple-request-uuid', 'via', 'server', 'x-apple-orig-url', 'content-language'];

async function req(url, { headers = {}, timeoutMs = 30000, method = 'GET' } = {}) {
  if (PLAN) { console.log(`${method} ${url}  ${JSON.stringify(headers)}`); return { planned: true }; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, headers, signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    const h = {}; for (const k of HDR_KEEP) { const v = res.headers.get(k); if (v) h[k] = v; }
    return { status: res.status, finalUrl: res.url !== url ? res.url : undefined, headers: h, text, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    const error = String(e && e.cause ? e.cause.code || e.cause.message || e.cause : e.message || e);
    if (R.errors.length < 500) R.errors.push({ at: now(), url, error });
    return { status: 0, error, ms: Math.round(performance.now() - t0) };
  } finally { clearTimeout(t); }
}
const J = (t) => { try { return JSON.parse(String(t).trim()); } catch { return undefined; } };
const keys = (o) => (o && typeof o === 'object') ? Object.keys(o) : undefined;
const pick = (o, ks) => { const r = {}; for (const k of ks) if (o && o[k] !== undefined) r[k] = o[k]; return r; };
const head = (t, n = 300) => String(t || '').slice(0, n).replace(/\s+/g, ' ');
function rec(name, data) { R.checks[name] = { at: now(), ...data }; log(name, '→', data.status ?? data.error ?? '', data.note ?? ''); }
async function pause() { if (!PLAN) await sleep(PAUSE_MS); }
function overlap(a, b) { const sb = new Set(b); let same = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++; return { common: a.filter(x => sb.has(x)).length, samePos: same, n: Math.min(a.length, b.length) }; }
const idsOf = (arr, k = 'trackId') => (arr || []).map(x => String(x[k]));
const plistCount = (t) => (String(t).match(/<key>term<\/key>/g) || []).length;
function plistHints(t) { // минимальный разбор plist: term/priority/url
  const out = []; const re = /<key>term<\/key>\s*<string>([^<]*)<\/string>(?:\s*<key>priority<\/key>\s*<integer>(\d+)<\/integer>)?(?:\s*<key>url<\/key>\s*<string>([^<]*)<\/string>)?/g;
  let m; while ((m = re.exec(String(t)))) out.push({ term: m[1], priority: m[2] ? Number(m[2]) : undefined, url: m[3] ? 'yes' : undefined });
  return out;
}

// ---------- 1. Search API ----------
const SEARCH = (term, p = {}) => { const q = new URLSearchParams({ term, country: CC, entity: 'software', limit: '200', ...p }); return `https://itunes.apple.com/search?${q}`; };
const LOOKUP = (ids, cc = CC, extra = '') => `https://itunes.apple.com/lookup?id=${ids.join(',')}&country=${cc}&entity=software${extra}`;
let searchUs = [];
async function searchApi() {
  const s1 = await req(SEARCH(TERM)); const j1 = J(s1.text); searchUs = j1?.results || [];
  rec('search.us.software.200', { status: s1.status, ms: s1.ms, headers: s1.headers, resultCount: j1?.resultCount, len: searchUs.length, topKeys: keys(j1), resultKeys: keys(searchUs[0]), sample: searchUs.slice(0, 3).map(a => pick(a, ['trackId', 'trackName', 'userRatingCount', 'averageUserRating', 'releaseDate', 'currentVersionReleaseDate', 'price', 'primaryGenreId'])), bodyHead: j1 ? undefined : head(s1.text) });
  await pause();
  const s2 = await req(SEARCH(TERM, { entity: 'iPadSoftware' })); const j2 = J(s2.text);
  rec('search.us.iPadSoftware', { status: s2.status, ms: s2.ms, resultCount: j2?.resultCount, top20_vs_software: overlap(idsOf(j2?.results).slice(0, 20), idsOf(searchUs).slice(0, 20)) });
  await pause();
  const s3 = await req(SEARCH(TERM, { lang: 'es_mx' })); const j3 = J(s3.text);
  rec('search.us.lang_es_mx', { status: s3.status, ms: s3.ms, resultCount: j3?.resultCount, top20_vs_default: overlap(idsOf(j3?.results).slice(0, 20), idsOf(searchUs).slice(0, 20)), firstNames: (j3?.results || []).slice(0, 3).map(a => a.trackName) });
  await pause();
  const s4 = await req(SEARCH(TERM, { country: 'de' })); const j4 = J(s4.text);
  rec('search.de', { status: s4.status, ms: s4.ms, resultCount: j4?.resultCount, top20_vs_us: overlap(idsOf(j4?.results).slice(0, 20), idsOf(searchUs).slice(0, 20)), sample: (j4?.results || []).slice(0, 2).map(a => pick(a, ['trackId', 'trackName', 'userRatingCount', 'currency', 'price'])) });
  await pause();
  const s5 = await req(SEARCH(TERM, { limit: '50' })); const j5 = J(s5.text);
  rec('search.us.limit50', { status: s5.status, ms: s5.ms, resultCount: j5?.resultCount, top50_same_as_200: overlap(idsOf(j5?.results), idsOf(searchUs).slice(0, 50)) });
  await pause();
  const s6 = await req(SEARCH(TERM, { limit: '250' })); const j6 = J(s6.text);
  rec('search.us.limit250', { status: s6.status, ms: s6.ms, resultCount: j6?.resultCount, note: 'ограничение limit: 200 или ошибка?', bodyHead: j6 ? undefined : head(s6.text) });
  await pause();
  // кэш: повтор того же URL, затем с &timestamp=
  const c1 = await req(SEARCH(TERM)); const c2 = await req(SEARCH(TERM) + `&timestamp=${Date.now()}`);
  rec('search.cache', { repeat: { status: c1.status, ms: c1.ms, headers: c1.headers }, withTimestamp: { status: c2.status, ms: c2.ms, headers: c2.headers }, note: 'сравнить age/x-cache/ms; порядок одинаков?', sameOrder: overlap(idsOf(J(c1.text)?.results), idsOf(J(c2.text)?.results)) });
  await pause();
  // rating counts по стране: Duolingo us vs gb
  const lu = await req(LOOKUP([DUOLINGO], 'us')); const lg = await req(LOOKUP([DUOLINGO], 'gb'));
  const au = J(lu.text)?.results?.[0], ag = J(lg.text)?.results?.[0];
  rec('lookup.duolingo.us_vs_gb', { status: [lu.status, lg.status], us: pick(au, ['userRatingCount', 'averageUserRating', 'userRatingCountForCurrentVersion', 'price', 'currency']), gb: pick(ag, ['userRatingCount', 'averageUserRating', 'userRatingCountForCurrentVersion', 'price', 'currency']), differ: au && ag ? (au.userRatingCount !== ag.userRatingCount) : undefined });
  await pause();
}

// ---------- 2. Lookup: максимум id ----------
async function lookupBatch() {
  // собрать ≥300 id: из search по 2 доп. терминам
  const pool = new Set(idsOf(searchUs));
  for (const t of ['photo editor', 'budget planner']) { if (pool.size >= 320) break; const r = await req(SEARCH(t)); for (const id of idsOf(J(r.text)?.results)) pool.add(id); await pause(); }
  const ids = [...pool];
  for (const n of [100, 200, 300]) {
    const batch = ids.slice(0, n); if (batch.length < n) { rec(`lookup.batch${n}`, { skipped: `only ${ids.length} ids` }); continue; }
    const url = LOOKUP(batch); const r = await req(url); const j = J(r.text);
    rec(`lookup.batch${n}`, { status: r.status, ms: r.ms, urlLen: url.length, requested: n, resultCount: j?.resultCount, headers: r.headers, bodyHead: j ? undefined : head(r.text) });
    await pause();
  }
}

// ---------- 3. MZStore search ----------
const MZ = (term, host = 'search.itunes.apple.com', extra = '') => `https://${host}/WebObjects/MZStore.woa/wa/search?clientApplication=Software&media=software&term=${encodeURIComponent(term)}${extra}`;
function mzSummary(r) {
  const j = J(r.text); if (!j) return { status: r.status, ms: r.ms, headers: r.headers, bodyHead: head(r.text) };
  const b = j.bubbles || []; const res = b[0]?.results || [];
  const txt = r.text;
  const markers = {}; for (const m of ['"isAd"', 'adamId', '"ad"', 'Sponsored', 'searchAd', 'inAppPurchase', 'inApp', 'customProductPage', 'productPage', 'developer', 'storePlatformData', 'pageData', 'nextPageUrl', 'canLoadMore', 'startIndex', 'bubbleId', 'totalResults', 'numResults']) markers[m] = (txt.match(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  return { status: r.status, ms: r.ms, headers: r.headers, topKeys: keys(j), bubbles: b.map(x => ({ name: x.name || x.title || x.bubbleId, results: (x.results || []).length })), resultKeys: keys(res[0]), firstIds: res.slice(0, 20).map(x => String(x.id)), markers, hasStorePlatformData: !!j.storePlatformData, storePlatformKeys: keys(j.storePlatformData), storePlatformLookupCount: j.storePlatformData?.lockup?.results ? Object.keys(j.storePlatformData.lockup.results).length : undefined };
}
let mzFirst = [];
async function mzstore() {
  const base = { 'X-Apple-Store-Front': `${STOREFRONT},24 t:native`, 'Accept-Language': 'en-us', 'User-Agent': IOS_UA, Accept: 'application/json' };
  const m1 = mzSummary(await req(MZ(TERM), { headers: base })); mzFirst = m1.firstIds || [];
  rec('mzstore.24native.en', { ...m1, top20_vs_searchApi: overlap(mzFirst, idsOf(searchUs).slice(0, 20)) }); await pause();
  rec('mzstore.24native.noUA', mzSummary(await req(MZ(TERM), { headers: { 'X-Apple-Store-Front': `${STOREFRONT},24 t:native`, 'Accept-Language': 'en-us' } }))); await pause();
  rec('mzstore.143441-1,29', mzSummary(await req(MZ(TERM), { headers: { 'X-Apple-Store-Front': `${STOREFRONT}-1,29`, 'Accept-Language': 'en-us', 'User-Agent': IOS_UA } }))); await pause();
  rec('mzstore.143441-1,29.itunesHost', mzSummary(await req(MZ(TERM, 'itunes.apple.com'), { headers: { 'X-Apple-Store-Front': `${STOREFRONT}-1,29` } }))); await pause();
  rec('mzstore.noHeader', mzSummary(await req(MZ(TERM), { headers: { 'User-Agent': IOS_UA } }))); await pause();
  const m4 = mzSummary(await req(MZ(TERM), { headers: { ...base, 'X-Apple-Store-Front': `${STOREFRONT}-28,24 t:native` } }));
  rec('mzstore.143441-28.esMX', { ...m4, top20_vs_en: overlap(m4.firstIds || [], mzFirst) }); await pause();
  const m5 = mzSummary(await req(MZ(TERM), { headers: { ...base, 'Accept-Language': 'es-mx' } }));
  rec('mzstore.acceptLang.esMX', { ...m5, top20_vs_en: overlap(m5.firstIds || [], mzFirst) }); await pause();
  const m6 = mzSummary(await req(MZ(TERM, 'search.itunes.apple.com', '&limit=50'), { headers: base }));
  rec('mzstore.limit50', { ...m6, note: 'честен ли параметр limit?' }); await pause();
  const m7 = mzSummary(await req(MZ(TERM, 'search.itunes.apple.com', '&entity=iPadSoftware'), { headers: { ...base, 'X-Apple-Store-Front': `${STOREFRONT},30` } }));
  rec('mzstore.ipad.platform30', { ...m7, top20_vs_iphone: overlap(m7.firstIds || [], mzFirst), note: 'есть ли переключатель iPhone/iPad' }); await pause();
}

// ---------- 4. tools.applemediaservices ----------
async function amsSearch() {
  for (const lim of [25, 50]) {
    const url = `https://tools.applemediaservices.com/api/apple-media/apps/${CC}/search.json?types=apps&term=${encodeURIComponent(TERM)}&l=en-US&limit=${lim}&platform=web&additionalPlatforms=iphone`;
    const r = await req(url, { headers: { 'User-Agent': WEB_UA } }); const j = J(r.text); const d = j?.apps?.data || [];
    const a = d[0]?.attributes;
    rec(`ams.search.limit${lim}`, { status: r.status, ms: r.ms, headers: r.headers, topKeys: keys(j), appsKeys: keys(j?.apps), count: d.length, attrKeys: keys(a), chartPositions: a?.chartPositions, userRating: a?.userRating ? pick(a.userRating, ['value', 'ratingCount']) : undefined, hasIAP: a?.hasInAppPurchases, offers: Array.isArray(a?.offers) ? a.offers.length : undefined, bodyHead: j ? undefined : head(r.text) });
    await pause();
  }
}

// ---------- 5. Hints ----------
const HINTS = (term, extra = '') => `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(term)}${extra}`;
function hintSummary(r) {
  const t = r.text || ''; const isPlist = /<plist/i.test(t); const j = isPlist ? undefined : J(t);
  const hints = isPlist ? plistHints(t) : undefined;
  return { status: r.status, ms: r.ms, headers: r.headers, format: isPlist ? 'plist' : (j ? 'json' : head(t, 80)), count: isPlist ? plistCount(t) : (Array.isArray(j) ? j.length : undefined), sample: hints?.slice(0, 3), hasPriority: hints?.some(h => h.priority !== undefined), hasUrl: hints?.some(h => h.url), jsonKeys: keys(j) };
}
async function hints() {
  rec('hints.sf29', hintSummary(await req(HINTS(HINT_PREFIX), { headers: { 'X-Apple-Store-Front': `${STOREFRONT},29` } }))); await pause();
  rec('hints.sf24', hintSummary(await req(HINTS(HINT_PREFIX), { headers: { 'X-Apple-Store-Front': `${STOREFRONT},24` } }))); await pause();
  rec('hints.sf-1,29', hintSummary(await req(HINTS(HINT_PREFIX), { headers: { 'X-Apple-Store-Front': `${STOREFRONT}-1,29`, 'User-Agent': 'iTunes/12.0 (Macintosh)' } }))); await pause();
  rec('hints.noHeader', hintSummary(await req(HINTS(HINT_PREFIX)))); await pause();
  rec('hints.gb', hintSummary(await req(HINTS(HINT_PREFIX), { headers: { 'X-Apple-Store-Front': `${SF_GB},29` } }))); await pause();
  rec('hints.altParams.e_media_cc_q', hintSummary(await req(`https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&e=true&media=software&cc=${CC}&q=${encodeURIComponent(HINT_PREFIX)}`, { headers: { 'X-Apple-Store-Front': `${STOREFRONT},29` } }))); await pause();
  rec('hints.altParams.e_media_term', hintSummary(await req(HINTS(HINT_PREFIX, '&e=true&media=software'), { headers: { 'X-Apple-Store-Front': `${STOREFRONT},29` } }))); await pause();
  rec('hints.longTerm', hintSummary(await req(HINTS('habit tracker for'), { headers: { 'X-Apple-Store-Front': `${STOREFRONT},29` } }))); await pause();
  const tr = await req(`https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/trends?maxCount=10`, { headers: { 'X-Apple-Store-Front': `${STOREFRONT},29` } });
  rec('hints.trends', { status: tr.status, ms: tr.ms, headers: tr.headers, format: /<plist/i.test(tr.text || '') ? 'plist' : (J(tr.text) ? 'json' : 'other'), count: plistCount(tr.text), bodyHead: head(tr.text, 400) }); await pause();
}

// ---------- 6. Чарты ----------
async function charts() {
  for (const [name, url] of [
    ['charts.v2.top-free.100', `https://rss.marketingtools.apple.com/api/v2/${CC}/apps/top-free/100/apps.json`],
    ['charts.v2.top-free.200', `https://rss.marketingtools.apple.com/api/v2/${CC}/apps/top-free/200/apps.json`],
    ['charts.v2.top-paid.100', `https://rss.marketingtools.apple.com/api/v2/${CC}/apps/top-paid/100/apps.json`],
    ['charts.v2.top-grossing.100', `https://rss.marketingtools.apple.com/api/v2/${CC}/apps/top-grossing/100/apps.json`],
    ['charts.v2.top-free.genre6013', `https://rss.marketingtools.apple.com/api/v2/${CC}/apps/top-free/genre=6013/100/apps.json`],
  ]) { const r = await req(url); const j = J(r.text); const res = j?.feed?.results; rec(name, { status: r.status, ms: r.ms, headers: r.headers, topKeys: keys(j), feedKeys: keys(j?.feed), count: res?.length, firstKeys: keys(res?.[0]), sample: res?.slice(0, 2).map(x => pick(x, ['id', 'name', 'artistName', 'releaseDate', 'genres'])), bodyHead: j ? undefined : head(r.text) }); await pause(); }
  for (const [name, url] of [
    ['charts.legacy.topfree.g6013.200', `https://itunes.apple.com/${CC}/rss/topfreeapplications/limit=200/genre=${GENRE}/json`],
    ['charts.legacy.topfree.g6013.100', `https://itunes.apple.com/${CC}/rss/topfreeapplications/limit=100/genre=${GENRE}/json`],
    ['charts.legacy.topfree.nogenre.200', `https://itunes.apple.com/${CC}/rss/topfreeapplications/limit=200/json`],
    ['charts.legacy.topgrossing.g6013.200', `https://itunes.apple.com/${CC}/rss/topgrossingapplications/limit=200/genre=${GENRE}/json`],
    ['charts.legacy.toppaid.g6013.100', `https://itunes.apple.com/${CC}/rss/toppaidapplications/limit=100/genre=${GENRE}/json`],
    ['charts.legacy.newapplications.g6013', `https://itunes.apple.com/${CC}/rss/newapplications/limit=100/genre=${GENRE}/json`],
    ['charts.legacy.newfreeapplications', `https://itunes.apple.com/${CC}/rss/newfreeapplications/limit=100/json`],
    ['charts.legacy.newpaidapplications.g6013', `https://itunes.apple.com/${CC}/rss/newpaidapplications/limit=100/genre=${GENRE}/json`],
    ['charts.legacy.topfreeipad.g6013.100', `https://itunes.apple.com/${CC}/rss/topfreeipadapplications/limit=100/genre=${GENRE}/json`],
    ['charts.legacy.limit300', `https://itunes.apple.com/${CC}/rss/topfreeapplications/limit=300/genre=${GENRE}/json`],
    ['charts.ax.topfree.g6013.200', `https://ax.itunes.apple.com/WebObjects/MZStoreServices.woa/ws/RSS/topfreeapplications/genre=${GENRE}/limit=200/json?s=${STOREFRONT}`],
    ['charts.mzservices.charts.freeAppsV2', `https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/charts?cc=${CC}&g=${GENRE}&name=freeAppsV2&limit=200`],
  ]) { const r = await req(url); const j = J(r.text); const e = j?.feed?.entry; const ids = j?.resultIds; rec(name, { status: r.status, ms: r.ms, headers: r.headers, topKeys: keys(j), count: Array.isArray(e) ? e.length : (e ? 1 : (Array.isArray(ids) ? ids.length : undefined)), entryKeys: keys(Array.isArray(e) ? e[0] : e), sample: Array.isArray(e) ? e.slice(0, 1).map(x => ({ id: x.id?.attributes?.['im:id'], name: x['im:name']?.label, releaseDate: x['im:releaseDate']?.label, genre: x.category?.attributes?.label })) : undefined, bodyHead: j ? undefined : head(r.text) }); await pause(); }
  for (const [pop, plat, label] of [[27, 29, 'topFreeIphone'], [30, 29, 'topPaidIphone'], [38, 29, 'topGrossingIphone'], [44, 30, 'topFreeIpad'], [45, 30, 'topPaidIpad'], [46, 30, 'topGrossingIpad']]) {
    const url = `https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewTop?genreId=${GENRE}&popId=${pop}`;
    const r = await req(url, { headers: { 'X-Apple-Store-Front': `${STOREFRONT},${plat}` } }); const j = J(r.text);
    const seg = j?.pageData?.segmentedControl?.segments?.[0]?.pageData; const adam = seg?.selectedChart?.adamIds;
    rec(`charts.viewTop.${label}`, { status: r.status, ms: r.ms, headers: r.headers, topKeys: keys(j), adamIds: adam?.length, selectedChart: seg?.selectedChart ? pick(seg.selectedChart, ['title', 'shortTitle', 'kind', 'kindId', 'popId', 'genreId']) : undefined, allCharts: seg?.topCharts?.map(c => ({ title: c.title, popId: c.popId, n: c.adamIds?.length })), hasLockupMeta: !!j?.storePlatformData?.lockup, bodyHead: j ? undefined : head(r.text) });
    await pause();
  }
  const r500 = await req(`https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewTop?genreId=36&popId=27&limit=500`, { headers: { 'X-Apple-Store-Front': `${STOREFRONT},29` } }); const j500 = J(r500.text);
  rec('charts.viewTop.genre36.limit500', { status: r500.status, ms: r500.ms, adamIds: j500?.pageData?.segmentedControl?.segments?.[0]?.pageData?.selectedChart?.adamIds?.length }); await pause();
  const rf = await req(`https://itunes.apple.com/WebObjects/MZStore.woa/wa/topChartFragmentData?popId=27&genreId=${GENRE}&pageNumbers=0&pageSize=1000`, { headers: { 'X-Apple-Store-Front': `${STOREFRONT}-1,29` } });
  rec('charts.topChartFragmentData', { status: rf.status, ms: rf.ms, format: J(rf.text) ? 'json' : 'other', topKeys: keys(J(rf.text)), bodyHead: head(rf.text, 200) }); await pause();
}

// ---------- 7. выбор 3 приложений ----------
async function pickApps() {
  R.apps.large = { id: DUOLINGO, name: 'Duolingo' };
  const notGame = (a) => String(a.primaryGenreId) !== '6014';
  const mid = searchUs.find(a => notGame(a) && a.userRatingCount >= 1000 && a.userRatingCount <= 50000);
  if (mid) R.apps.medium = { id: String(mid.trackId), name: mid.trackName, ratings: mid.userRatingCount, released: mid.releaseDate };
  const cutoff = Date.now() - 90 * 86400e3;
  let young = searchUs.find(a => Date.parse(a.releaseDate) > cutoff);
  if (!young) for (const t of ['water reminder', 'budget planner', 'sleep sounds']) { const j = J((await req(SEARCH(t))).text); young = (j?.results || []).find(a => Date.parse(a.releaseDate) > cutoff); await pause(); if (young) break; }
  if (young) R.apps.young = { id: String(young.trackId), name: young.trackName, ratings: young.userRatingCount, released: young.releaseDate };
  else { const j = J((await req(`https://itunes.apple.com/${CC}/rss/newapplications/limit=10/json`)).text); const e = j?.feed?.entry?.[0]; if (e) R.apps.young = { id: e.id?.attributes?.['im:id'], name: e['im:name']?.label, released: e['im:releaseDate']?.label, from: 'newapplications' }; }
  if (!R.apps.medium) R.apps.medium = { id: '1073493121', name: 'fallback (Streaks)', note: 'не найден в выдаче — подставлен fallback' };
  if (!R.apps.young) R.apps.young = { id: DUOLINGO, note: 'молодое не найдено — дублируется Duolingo' };
  log('apps:', JSON.stringify(R.apps));
}

// ---------- 8. отзывы / страница / amp-api / similar ----------
function tokenFromHtml(html) {
  const meta = html.match(/<meta name="web-experience-app\/config\/environment" content="(.+?)">/);
  let metaToken, metaErr; if (meta) { try { metaToken = JSON.parse(decodeURIComponent(meta[1]))?.MEDIA_API?.token; } catch (e) { metaErr = String(e); } }
  const rx = /token%22%3A%22([^%]+)%22/.exec(html); const rxToken = rx?.[1];
  const anyJwt = (html.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/) || [])[0];
  const tok = metaToken || rxToken || anyJwt; let exp;
  if (tok) { try { exp = new Date(JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString()).exp * 1000).toISOString(); } catch { } }
  return { metaPresent: !!meta, metaToken: !!metaToken, metaErr, regexToken: !!rxToken, anyJwt: !!anyJwt, token: tok, exp };
}
async function perApp(label, id) {
  const P = `reviews.${label}`;
  // RSS pages 1..11
  const pages = [];
  for (let p = 1; p <= 11; p++) {
    const r = await req(`https://itunes.apple.com/${CC}/rss/customerreviews/page=${p}/id=${id}/sortby=mostrecent/json`); const j = J(r.text);
    let e = j?.feed?.entry; if (e && !Array.isArray(e)) e = [e];
    const links = (j?.feed?.link || []).map(l => l.attributes?.rel).filter(Boolean);
    pages.push({ page: p, status: r.status, ms: r.ms, entries: e ? e.length : (j ? 0 : undefined), firstKeys: p === 1 ? keys(e?.[0]) : undefined, voteSum: e?.[0]?.['im:voteSum']?.label, voteCount: e?.[0]?.['im:voteCount']?.label, version: e?.[0]?.['im:version']?.label, updated: e?.[0]?.updated?.label, langField: e?.[0] ? Object.keys(e[0]).filter(k => /lang/i.test(k)) : undefined, links, bodyHead: j ? undefined : head(r.text, 120) });
    await sleep(PLAN ? 0 : 700);
  }
  rec(`${P}.rss`, { id, nonEmptyPages: pages.filter(x => x.entries > 0).length, page11: pick(pages[10], ['status', 'entries', 'bodyHead']), pages });
  // гистограмма HTML
  const h = await req(`https://itunes.apple.com/${CC}/customer-reviews/id${id}?displayable-kind=11`, { headers: { 'X-Apple-Store-Front': `${STOREFRONT},12` } });
  const totals = (h.text || '').match(/<span class="total">([^<]*)<\/span>/g) || []; const rc = (h.text || '').match(/class="rating-count"[^>]*>([^<]*)</);
  rec(`${P}.histogramHtml`, { status: h.status, ms: h.ms, headers: h.headers, len: (h.text || '').length, ratingCountText: rc?.[1]?.trim(), totals: totals.map(s => s.replace(/<[^>]+>/g, '')), bodyHead: h.status !== 200 ? head(h.text) : undefined }); await pause();
  const hj = await req(`https://itunes.apple.com/${CC}/customer-reviews/id${id}?dataOnly=true&displayable-kind=11`, { headers: { 'X-Apple-Store-Front': `${STOREFRONT}-1,29` } });
  rec(`${P}.histogramDataOnly`, { status: hj.status, ms: hj.ms, format: J(hj.text) ? 'json' : 'other', topKeys: keys(J(hj.text)), bodyHead: head(hj.text, 200) }); await pause();
  // страница apps.apple.com
  const pg = await req(`https://apps.apple.com/${CC}/app/id${id}`, { headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-US,en;q=0.9' } }); const html = pg.text || '';
  const scripts = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*id="([^"]+)"/g)].map(m => m[1]);
  const scripts2 = [...html.matchAll(/<script[^>]*id="([^"]+)"[^>]*type="application\/json"/g)].map(m => m[1]);
  const tok = tokenFromHtml(html);
  const sub = html.match(/class="[^"]*(?:product-header__subtitle|app-header__subtitle)[^"]*"[^>]*>\s*([^<]{1,120})/);
  rec(`${P}.page`, { status: pg.status, ms: pg.ms, finalUrl: pg.finalUrl, headers: pg.headers, len: html.length, jsonScriptIds: [...new Set([...scripts, ...scripts2])], shoebox: (html.match(/id="shoebox-[^"]+"/g) || []).slice(0, 5), hasJsonLd: /application\/ld\+json/.test(html), token: pick(tok, ['metaPresent', 'metaToken', 'regexToken', 'anyJwt', 'exp', 'metaErr']), subtitle: sub?.[1]?.trim(), hasIAPSection: /In-App Purchases/.test(html), iapPriceSamples: (html.match(/\$\d+\.\d{2}/g) || []).slice(0, 5), privacy: ['Data Used to Track You', 'Data Linked to You', 'Data Not Linked to You'].filter(s => html.includes(s)), hasVersionHistory: /Version History/.test(html), hasAlsoLike: /You Might Also Like/.test(html) });
  await pause();
  // amp-api
  const token = tok.token || R.token; if (tok.token && !R.token) R.token = tok.token;
  const ampH = { Authorization: `Bearer ${token || 'NONE'}`, Origin: 'https://apps.apple.com', Referer: `https://apps.apple.com/${CC}/app/id${id}`, 'User-Agent': WEB_UA, Accept: 'application/json' };
  for (const host of ['amp-api.apps.apple.com', 'amp-api-edge.apps.apple.com']) {
    const rv = await req(`https://${host}/v1/catalog/${CC}/apps/${id}/reviews?l=en-US&offset=0&limit=20&platform=web&additionalPlatforms=appletv,ipad,iphone,mac`, { headers: ampH }); const jv = J(rv.text);
    rec(`${P}.amp.reviews.${host.split('.')[0]}`, { status: rv.status, ms: rv.ms, headers: rv.headers, tokenUsed: !!token, topKeys: keys(jv), count: jv?.data?.length, next: jv?.next, attrKeys: keys(jv?.data?.[0]?.attributes), sample: jv?.data?.slice(0, 1).map(x => pick(x.attributes, ['date', 'rating', 'isEdited', 'title'])), bodyHead: jv ? undefined : head(rv.text) }); await pause();
    const rd = await req(`https://${host}/v1/catalog/${CC}/apps/${id}?platform=web&additionalPlatforms=iphone,ipad&l=en-US&fields=privacyDetails,userRating,chartPositions,offers,hasInAppPurchases,subtitle,name,artistName,releaseDate,bundleId,deviceFamilies&extend=versionHistory`, { headers: ampH }); const jd = J(rd.text);
    const at = jd?.data?.[0]?.attributes; const pa = at?.platformAttributes?.ios;
    rec(`${P}.amp.details.${host.split('.')[0]}`, { status: rd.status, ms: rd.ms, headers: rd.headers, topKeys: keys(jd), dataKeys: keys(jd?.data?.[0]), attrKeys: keys(at), platformAttrKeys: keys(pa), privacyDetails: at?.privacyDetails ? keys(at.privacyDetails) : undefined, userRating: at?.userRating ? pick(at.userRating, ['value', 'ratingCount', 'ratingCountList']) : undefined, chartPositions: at?.chartPositions, subtitle: pa?.subtitle ?? at?.subtitle, offers: Array.isArray(pa?.offers) ? pa.offers.length : (Array.isArray(at?.offers) ? at.offers.length : undefined), hasInAppPurchases: pa?.hasInAppPurchases ?? at?.hasInAppPurchases, versionHistory: pa?.versionHistory?.length, relationships: keys(jd?.data?.[0]?.relationships), bodyHead: jd ? undefined : head(rd.text) }); await pause();
  }
  const ri = await req(`https://amp-api-edge.apps.apple.com/v1/catalog/${CC}/apps/${id}?platform=web&include=top-in-apps,customers-also-bought-apps&l=en-US`, { headers: ampH }); const ji = J(ri.text);
  rec(`${P}.amp.include.iap_similar`, { status: ri.status, ms: ri.ms, relationships: keys(ji?.data?.[0]?.relationships), topInApps: ji?.data?.[0]?.relationships?.['top-in-apps']?.data?.length, alsoBought: ji?.data?.[0]?.relationships?.['customers-also-bought-apps']?.data?.length, bodyHead: ji ? undefined : head(ri.text) }); await pause();
  // similar (HTML, platform 32)
  const sm = await req(`https://itunes.apple.com/${CC}/app/app/id${id}`, { headers: { 'X-Apple-Store-Front': `${STOREFRONT},32` } });
  const m = /customersAlsoBoughtApps":(\[[^\]]*\])/.exec(sm.text || '');
  rec(`${P}.similar.platform32`, { status: sm.status, ms: sm.ms, headers: sm.headers, len: (sm.text || '').length, hasCustomersAlsoBought: !!m, count: m ? (J(m[1]) || []).length : undefined, bodyHead: sm.status !== 200 ? head(sm.text) : undefined }); await pause();
}

// ---------- 9. серии темпа ----------
async function rateSeries(name, mkUrl, mkHeaders, isEmpty) {
  if (PLAN) { console.log(`RATE ${name}: 3 серии × 30 запросов при 1/2/5 rps, cooldown ${COOLDOWN_S}s`); return; }
  R.rate[name] = {};
  let termIdx = 0;
  for (const rps of [1, 2, 5]) {
    const interval = 1000 / rps; const results = []; const t0 = performance.now();
    const jobs = [];
    for (let i = 0; i < 30; i++) {
      const term = TERMS[(termIdx++) % TERMS.length];
      jobs.push((async () => { await sleep(i * interval); const r = await req(mkUrl(term), { headers: mkHeaders }); results[i] = { i, term, status: r.status, ms: r.ms, retryAfter: r.headers?.['retry-after'], empty: r.status === 200 ? isEmpty(r.text) : undefined, bodyHead: r.status !== 200 ? head(r.text, 120) : undefined }; })());
    }
    await Promise.all(jobs);
    const elapsed = Math.round(performance.now() - t0);
    const firstBad = results.find(x => x.status !== 200 || x.empty);
    const summary = { rps, requests: 30, elapsedMs: elapsed, effectiveRps: +(30000 / elapsed).toFixed(2), statuses: results.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {}), emptyCount: results.filter(x => x.empty).length, firstBadIndex: firstBad ? firstBad.i : null, firstBad, retryAfterSeen: results.some(x => x.retryAfter), p50ms: results.map(x => x.ms).sort((a, b) => a - b)[15], maxMs: Math.max(...results.map(x => x.ms)), rows: results };
    R.rate[name][`rps${rps}`] = summary;
    log(`rate ${name} @${rps}rps: statuses ${JSON.stringify(summary.statuses)} empty=${summary.emptyCount} firstBad=${summary.firstBadIndex} p50=${summary.p50ms}ms`);
    log(`cooldown ${COOLDOWN_S}s`); await sleep(COOLDOWN_S * 1000);
    // проверка восстановления после серии
    const rr = await req(mkUrl('weather'), { headers: mkHeaders }); summary.afterCooldown = { status: rr.status, empty: rr.status === 200 ? isEmpty(rr.text) : undefined };
    if (rr.status !== 200 || summary.afterCooldown.empty) { log('после cooldown всё ещё отказ — ждём ещё 120s'); await sleep(120000); const r2 = await req(mkUrl('weather'), { headers: mkHeaders }); summary.after2 = { status: r2.status }; }
  }
}

// ---------- 10. вердикты ----------
function verdicts() {
  const c = R.checks, v = R.verdicts;
  const ok = (n) => c[n] && c[n].status === 200;
  v.searchApi_alive = ok('search.us.software.200') && c['search.us.software.200'].resultCount > 0;
  v.searchApi_limit200 = c['search.us.software.200']?.resultCount;
  v.searchApi_ipad_differs = c['search.us.iPadSoftware'] && c['search.us.iPadSoftware'].top20_vs_software?.samePos < 20;
  v.ratingCount_byCountry = c['lookup.duolingo.us_vs_gb']?.differ;
  v.lookup_maxBatch = [300, 200, 100].find(n => ok(`lookup.batch${n}`) && c[`lookup.batch${n}`].resultCount > 0) || null;
  v.mzstore_alive = ok('mzstore.24native.en') && (c['mzstore.24native.en'].bubbles || []).some(b => b.results > 0);
  v.mzstore_results = c['mzstore.24native.en']?.bubbles?.[0]?.results;
  v.mzstore_top20_samePos_vs_searchApi = c['mzstore.24native.en']?.top20_vs_searchApi?.samePos;
  v.ams_search_alive = ok('ams.search.limit25') && c['ams.search.limit25'].count > 0;
  v.hints_alive = ok('hints.sf29') && c['hints.sf29'].count > 0; v.hints_count = c['hints.sf29']?.count; v.hints_priority = c['hints.sf29']?.hasPriority; v.hints_noHeader_works = ok('hints.noHeader') && c['hints.noHeader'].count > 0;
  v.trends_alive = ok('hints.trends');
  v.chartsV2_100 = c['charts.v2.top-free.100']?.count; v.chartsV2_200 = c['charts.v2.top-free.200']?.status === 200 ? c['charts.v2.top-free.200'].count : `HTTP ${c['charts.v2.top-free.200']?.status}`; v.chartsV2_grossing = c['charts.v2.top-grossing.100']?.status;
  v.legacyRss_genre_depth = c['charts.legacy.topfree.g6013.200']?.count; v.legacyRss_status = c['charts.legacy.topfree.g6013.200']?.status; v.legacy_new_feeds = { newapplications: c['charts.legacy.newapplications.g6013']?.count, newfree: c['charts.legacy.newfreeapplications']?.count };
  v.viewTop_depth = c['charts.viewTop.topFreeIphone']?.adamIds; v.viewTop_grossing = c['charts.viewTop.topGrossingIphone']?.adamIds; v.viewTop_ipad = c['charts.viewTop.topFreeIpad']?.adamIds;
  for (const l of ['large', 'medium', 'young']) {
    const p = `reviews.${l}`; if (!c[`${p}.rss`]) continue;
    v[`${l}_rss_nonEmptyPages`] = c[`${p}.rss`].nonEmptyPages; v[`${l}_rss_page11_status`] = c[`${p}.rss`].page11?.status;
    v[`${l}_page_token`] = c[`${p}.page`]?.token; v[`${l}_page_jsonScripts`] = c[`${p}.page`]?.jsonScriptIds; v[`${l}_page_iap`] = c[`${p}.page`]?.hasIAPSection;
    v[`${l}_amp_reviews`] = { edge: c[`${p}.amp.reviews.amp-api-edge`]?.status, plain: c[`${p}.amp.reviews.amp-api`]?.status };
    v[`${l}_amp_details`] = { edge: c[`${p}.amp.details.amp-api-edge`]?.status, plain: c[`${p}.amp.details.amp-api`]?.status, attrKeys: c[`${p}.amp.details.amp-api-edge`]?.attrKeys };
    v[`${l}_similar`] = c[`${p}.similar.platform32`]?.hasCustomersAlsoBought;
    v[`${l}_histogram_totals`] = c[`${p}.histogramHtml`]?.totals?.length;
  }
  for (const [k, s] of Object.entries(R.rate)) for (const [rps, d] of Object.entries(s)) v[`rate_${k}_${rps}`] = { statuses: d.statuses, empty: d.emptyCount, firstBad: d.firstBadIndex, retryAfter: d.retryAfterSeen, afterCooldown: d.afterCooldown };
}

// ---------- main ----------
(async () => {
  log(`ios-smoke start cc=${CC} storefront=${STOREFRONT} node=${process.version} plan=${PLAN} skipRate=${SKIP_RATE} rateOnly=${RATE_ONLY}`);
  if (!RATE_ONLY) {
    await searchApi(); await lookupBatch(); await mzstore(); await amsSearch(); await hints(); await charts(); await pickApps();
    for (const l of ['large', 'medium', 'young']) await perApp(l, R.apps[l].id);
  }
  if (!SKIP_RATE) {
    await rateSeries('searchApi', (t) => SEARCH(t, { limit: '50' }), {}, (txt) => (J(txt)?.resultCount ?? 0) === 0);
    await rateSeries('hints', (t) => HINTS(t.slice(0, 4)), { 'X-Apple-Store-Front': `${STOREFRONT},29` }, (txt) => plistCount(txt) === 0 && !J(txt));
    await rateSeries('mzstore', (t) => MZ(t), { 'X-Apple-Store-Front': `${STOREFRONT},24 t:native`, 'Accept-Language': 'en-us', 'User-Agent': IOS_UA }, (txt) => !((J(txt)?.bubbles || [])[0]?.results?.length));
  }
  R.finishedAt = now();
  if (!PLAN) { verdicts(); writeFileSync(OUT, JSON.stringify(R, null, 2)); log(`JSON → ${OUT}`); console.log('\n===== КРАТКИЙ ОТЧЁТ ====='); for (const [k, val] of Object.entries(R.verdicts)) console.log(`${k}: ${typeof val === 'object' ? JSON.stringify(val) : val}`); console.log('\nПриложения:', JSON.stringify(R.apps)); }
})().catch(e => { console.error('FATAL', e); try { writeFileSync(OUT, JSON.stringify(R, null, 2)); } catch { } process.exit(1); });
