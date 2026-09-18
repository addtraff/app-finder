// Методика v2.0 в редакции ТЗ AppRadar 2 (docs/tz-appradar-v2.md, раздел 5).
//
// Ниша описывается четырьмя величинами вместо одного скора: свобода (есть ли куда встать),
// ёмкость (сколько установок в месяц даст свободное место), чистота (не выкуплен ли этот
// трафик) и срок. Приложение — семью проверками: шесть методики v1.1 и 3b «трафик поисковый».
//
// Стадия только читает сырьё и расчётный слой (выдача, карточки, metrics_*_geo, рекламные
// библиотеки) и пишет свои таблицы — metrics_keyword_geo, metrics_niche_v2, metrics_app_v2,
// metrics_geo_calibration. Строки дня пересчитываются целиком.
//
// Всё, что требует истории (прирост установок, курс, ёмкость, 3b, входы в топ), считается
// тем же кодом с первого дня: пока окна нет, поле пустое, а не ноль.
import { db, startRun, finishRun } from '../lib/db.js';
import { config, geoConf, referenceGeo } from '../lib/config.js';
import { qv, clearQCache } from './quantiles.js';
import { hostOf, META_DETECTOR } from './check-ads.js';
import { screenAsOf } from '../lib/snapshots.js';
import { ageMonthsAt, parseReleased } from '../lib/dates.js';
import { quantile, quantileSet, norm, median, log } from '../lib/util.js';
import { ubtLexicon } from './analyze-ubt.js';

// Взвешенное среднее по доступным частям: пустая часть исключается вместе с весом.
function weighted(parts) {
  let s = 0, w = 0;
  for (const [v, wt] of parts) {
    if (v == null || !Number.isFinite(v)) continue;
    s += v * wt; w += wt;
  }
  return w ? s / w : null;
}

const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const shift = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const num = (v) => (v == null || !Number.isFinite(v) ? null : v);
const round = (v, p = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(p)));

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 2);
}

// Процентиль значения среди непустых значений выборки, 0–100, средний ранг при равенстве.
function percentileOf(values) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  return (v) => {
    if (v == null || !n) return null;
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    let eq = lo;
    while (eq < n && sorted[eq] === v) eq++;
    return n === 1 ? 50 : (100 * (lo + (eq - lo - 1) / 2)) / (n - 1);
  };
}

// ---------- рекламные библиотеки: один проход на запуск ----------
export function loadAdsEvidence(d) {
  // Google: единица — домен. found — была ли когда-либо хоть одна находка (как в score);
  // даты показов — из последнего ответа с объявлениями: пути 1.N.6.1 и 1.N.7.1 в секундах.
  const google = new Map();
  for (const r of d.prepare(
    `SELECT developer_domain dom, checked_at, creatives_found f, count FROM raw_ads_google
      WHERE creatives_found IS NOT NULL ORDER BY checked_at`
  ).all()) {
    const cur = google.get(r.dom) || { found: 0, checked: null, creatives: null, withAds: null, first: null, last: null };
    cur.found = Math.max(cur.found, r.f ? 1 : 0);
    cur.checked = r.checked_at;
    if (r.f) { cur.creatives = r.count ?? null; cur.withAds = r.checked_at; }
    google.set(r.dom, cur);
  }
  for (const r of d.prepare(
    `SELECT developer_domain dom, checked_at, path, value FROM raw_ads_google_field
      WHERE path LIKE '1.%.6.1' OR path LIKE '1.%.7.1'`
  ).all()) {
    const cur = google.get(r.dom);
    if (!cur || cur.withAds !== r.checked_at) continue;
    const t = Number(r.value) * 1000;
    if (!Number.isFinite(t) || t <= 0) continue;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (r.path.endsWith('.6.1')) { if (!cur.first || iso < cur.first) cur.first = iso; }
    else if (!cur.last || iso > cur.last) cur.last = iso;
  }

  // Meta: отрицательный результат — только от актуального детектора, как в score.
  const meta = new Map();
  for (const r of d.prepare(
    `SELECT app_id, checked_at, found_by_package_id f FROM raw_ads_meta
      WHERE found_by_package_id IS NOT NULL AND (found_by_package_id=1 OR note LIKE ?)
      ORDER BY checked_at`
  ).all(`${META_DETECTOR}%`)) {
    const cur = meta.get(r.app_id) || { found: 0, checked: null };
    cur.found = Math.max(cur.found, r.f ? 1 : 0);
    cur.checked = r.checked_at;
    meta.set(r.app_id, cur);
  }

  const tracking = new Map(d.prepare(
    `SELECT t.app_id, t.found, t.matched_names, t.checked_at FROM raw_tracking_scan t
       JOIN (SELECT app_id, MAX(checked_at) md FROM raw_tracking_scan GROUP BY app_id) f
         ON f.app_id=t.app_id AND f.md=t.checked_at`
  ).all().map((r) => [r.app_id, r]));
  const apk = new Map(d.prepare(
    `SELECT a.app_id, a.attribution_sdk, a.checked_at FROM raw_apk a
       JOIN (SELECT app_id, MAX(checked_at) md FROM raw_apk GROUP BY app_id) f
         ON f.app_id=a.app_id AND f.md=a.checked_at`
  ).all().map((r) => [r.app_id, r]));
  return { google, meta, tracking, apk };
}

export async function run({ geo, date, runId, cycle = 'daily' }) {
  const d = db();
  startRun(runId, 'radar-v2', geo, cycle, date);
  // RADAR_TIMING=1 — длительность этапов стадии в лог.
  let tickAt = Date.now();
  const tick = (name) => { if (process.env.RADAR_TIMING) log(`  radar-v2 ${geo}: ${name} ${Date.now() - tickAt} мс`); tickAt = Date.now(); };
  clearQCache();
  const cfg = config();
  const V = cfg.scoring.v2;
  const g = geoConf(geo);
  const refGeo = referenceGeo();
  const refConf = geoConf(refGeo);

  // День гео — последний день с метриками приложений; ниши — последний их день не позже.
  const D = d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_app_geo WHERE geo=? AND snapshot_date<=?`).get(geo, date)?.m;
  const nicheDate = D && d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_niche_geo WHERE geo=? AND snapshot_date<=?`).get(geo, D)?.m;
  if (!D || !nicheDate) {
    finishRun(runId, 'radar-v2', geo, { status: 'skipped', notes: 'нет метрик приложений или ниш' });
    return { niches: 0, apps: 0 };
  }

  const ctr = (pos) => (pos <= 10 ? V.ctr_top10[pos - 1] : pos <= 20 ? V.ctr_11_20 : pos <= 50 ? V.ctr_21_50 : 0);
  const moneyOf = (gc) => ((gc.ecpm_rel_us ?? 0) + (gc.arpu_rel_us ?? 0));
  const moneyRatio = moneyOf(refConf) ? moneyOf(g) / moneyOf(refConf) : null;

  // ---------- ниши, ядра, спрос ----------
  const niches = d.prepare(`SELECT * FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`).all(geo, nicheDate);
  const nicheById = new Map(niches.map((n) => [n.niche_id, n]));
  const kwInfo = new Map(d.prepare(`SELECT keyword, suggest_score, is_brand FROM disc_keywords WHERE geo=?`).all(geo)
    .map((r) => [r.keyword, r]));
  const cores = new Map();
  for (const r of d.prepare(`SELECT niche_id, keyword, is_head FROM keyword_cores WHERE geo=? AND active=1`).all(geo)) {
    if (!nicheById.has(r.niche_id) || kwInfo.get(r.keyword)?.is_brand) continue;
    if (!cores.has(r.niche_id)) cores.set(r.niche_id, []);
    cores.get(r.niche_id).push(r.keyword);
  }
  const allKeywords = new Set([...cores.values()].flat());
  const sug = (kw) => kwInfo.get(kw)?.suggest_score || 0;
  const factories = new Set(d.prepare(`SELECT DISTINCT developer_id FROM developer_clusters WHERE is_factory=1`).all().map((r) => r.developer_id));

  // ---------- выдача: история за окно входов, по дням ----------
  const since = shift(D, -V.entry_window_days);
  const serp = new Map(); // kw -> Map(date -> [{pos, app}])
  for (const r of d.prepare(
    `SELECT snapshot_date, keyword, position, app_id FROM raw_search
      WHERE geo=? AND snapshot_date<=? AND snapshot_date>=? AND position<=50`
  ).all(geo, D, since)) {
    if (!allKeywords.has(r.keyword)) continue;
    if (!serp.has(r.keyword)) serp.set(r.keyword, new Map());
    const byDate = serp.get(r.keyword);
    if (!byDate.has(r.snapshot_date)) byDate.set(r.snapshot_date, []);
    byDate.get(r.snapshot_date).push({ pos: r.position, app: r.app_id });
  }
  const snaps = new Map(); // kw -> [{date, top10:Set, top20:Set, top50:Set, list}]
  for (const [kw, byDate] of serp) {
    const list = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dt, rows]) => {
      rows.sort((a, b) => a.pos - b.pos);
      return {
        date: dt, list: rows,
        top10: new Set(rows.filter((x) => x.pos <= 10).map((x) => x.app)),
        top20: new Set(rows.filter((x) => x.pos <= 20).map((x) => x.app)),
        top50: new Set(rows.map((x) => x.app)),
      };
    });
    snaps.set(kw, list);
  }
  const latest = (kw) => { const l = snaps.get(kw); return l && l.length ? l[l.length - 1] : null; };

  tick('serp');
  // ---------- карточки: последняя на день и история установок ----------
  const cards = new Map();
  const cardHist = new Map();
  for (const r of d.prepare(
    `SELECT app_id, snapshot_date, hl, max_installs, score, ratings_count, released, updated_ts, title, summary,
            developer_id, developer_website, privacy_policy, title_hash, short_desc_hash, listing_hash, genre_id
       FROM raw_app_page WHERE geo=? AND snapshot_date<=?`
  ).all(geo, D)) {
    const cur = cards.get(r.app_id);
    if (!cur || r.snapshot_date > cur.snapshot_date || (r.snapshot_date === cur.snapshot_date && r.hl === g.hl[0])) cards.set(r.app_id, r);
    if (r.snapshot_date >= shift(D, -V.full_window_days) && (r.hl === g.hl[0] || !cardHist.get(r.app_id)?.has(r.snapshot_date))) {
      if (!cardHist.has(r.app_id)) cardHist.set(r.app_id, new Map());
      cardHist.get(r.app_id).set(r.snapshot_date, r);
    }
  }
  // Карточка того же приложения из другого гео — для полей, общих для Play: установки, дата
  // релиза, разработчик, сайт и политика (для рекламы). Заголовок локализован, поэтому
  // загруженность ASO считается только по карточкам своего гео.
  // Берутся только приложения выдачи ключей ядра без своей карточки: последняя карточка по
  // всей таблице (GROUP BY app_id с чтением полных строк) после добора карточек шла 9 минут.
  const anyCards = new Map();
  const needAny = new Set();
  for (const list of snaps.values()) for (const s of list) for (const x of s.list) if (!cards.has(x.app)) needAny.add(x.app);
  if (needAny.size) {
    for (const r of d.prepare(
      `SELECT p.app_id, p.snapshot_date, p.hl, p.max_installs, p.score, p.ratings_count, p.released, p.updated_ts, p.title, p.summary,
              p.developer_id, p.developer_website, p.privacy_policy, p.genre_id
         FROM raw_app_page p
        WHERE p.app_id IN (SELECT value FROM json_each(?))
          AND p.snapshot_date=(SELECT MAX(x.snapshot_date) FROM raw_app_page x WHERE x.app_id=p.app_id AND x.snapshot_date<=?)`
    ).all(JSON.stringify([...needAny]), D)) {
      if (!anyCards.has(r.app_id)) anyCards.set(r.app_id, r);
    }
  }
  const cardOf = (id) => cards.get(id) || anyCards.get(id);
  const installsOf = (id) => {
    const c = cardOf(id);
    if (!c || c.max_installs == null) return null;
    if (c.ratings_count != null && c.ratings_count > c.max_installs) return null; // артефакт Play, как в niche-doors
    return c.max_installs;
  };
  const ageOf = (id) => { const c = cardOf(id); return c ? ageMonthsAt(c.released, c.hl, D) : null; };

  tick('cards');
  // Метрики приложений на день и история установок (канонический источник, A2).
  const appRows = d.prepare(
    `SELECT m.*, s.reject_reason AS screen_reject, s.snapshot_date AS screen_date
       FROM metrics_app_geo m ${screenAsOf('s', 'm', 'LEFT JOIN')}
      WHERE m.geo=? AND m.snapshot_date=?`
  ).all(geo, D);
  const metricsById = new Map(appRows.map((r) => [r.app_id, r]));
  const instHist = new Map();
  for (const r of d.prepare(
    `SELECT app_id, snapshot_date, installs, installs_source_geo FROM metrics_app_geo
      WHERE geo=? AND snapshot_date<=? AND snapshot_date>=? ORDER BY snapshot_date`
  ).all(geo, D, shift(D, -V.full_window_days))) {
    if (!instHist.has(r.app_id)) instHist.set(r.app_id, []);
    instHist.get(r.app_id).push({ date: r.snapshot_date, installs: r.installs, src: r.installs_source_geo ?? null });
  }

  // Прирост за окно: самый старый снимок в пределах 30 дней, но не ближе 14 (П1 и 3.3 ТЗ).
  const deltaCache = new Map();
  const delta30 = (id) => {
    if (deltaCache.has(id)) return deltaCache.get(id);
    let series = instHist.get(id);
    if (!series?.length) {
      const h = cardHist.get(id);
      series = h ? [...h.values()].sort((a, b) => (a.snapshot_date < b.snapshot_date ? -1 : 1))
        .map((c) => ({ date: c.snapshot_date, installs: c.max_installs, src: null })) : [];
    }
    let out = null;
    const now = series[series.length - 1];
    const span = now ? daysBetween(series[0].date, now.date) : 0;
    if (now && now.installs != null) {
      const past = series.find((p) => p.installs != null && daysBetween(p.date, now.date) >= V.min_window_days);
      if (past && (past.src ?? null) === (now.src ?? null)) {
        const w = daysBetween(past.date, now.date);
        out = { delta: ((now.installs - past.installs) * V.full_window_days) / w, w, partial: w < V.full_window_days ? 1 : 0, span, series };
      }
    }
    if (!out) out = { delta: null, w: null, partial: null, span, series };
    deltaCache.set(id, out);
    return out;
  };

  // Предварительная дельта (решение заказчика 17.09: «где прошло мало времени — всё равно
  // посчитать»). Окно — от самого раннего снимка за 30 дней до последнего, любой длины от
  // preview_min_window_days. Установки у приложения общие для всех гео (совпадают у 96 %
  // приложений в один день), поэтому ряд собирается из карточек любого гео — так окно длиннее,
  // чем по истории одного гео. Официальный installs_delta_30d (окно ≥ 14 дней) не меняется:
  // на нём держатся курс, 3b и рекомендуемый скор; предварительная — только для просмотра.
  const previewHist = new Map();
  for (const r of d.prepare(
    `SELECT app_id, snapshot_date, MAX(max_installs) AS installs, MAX(ratings_count) AS ratings FROM raw_app_page
      WHERE app_id IN (SELECT value FROM json_each(?)) AND snapshot_date<=? AND snapshot_date>=? AND max_installs IS NOT NULL
      GROUP BY app_id, snapshot_date ORDER BY snapshot_date`
  ).all(JSON.stringify(appRows.map((r) => r.app_id)), D, shift(D, -V.full_window_days))) {
    if (r.ratings != null && r.ratings > r.installs) continue; // артефакт Play, как в installsOf
    if (!previewHist.has(r.app_id)) previewHist.set(r.app_id, []);
    previewHist.get(r.app_id).push(r);
  }
  const deltaPreview = (id) => {
    const s = previewHist.get(id);
    if (!s || s.length < 2) return { delta: null, raw: null, w: null, from: null };
    const past = s[0], now = s[s.length - 1];
    const w = daysBetween(past.snapshot_date, now.snapshot_date);
    if (w < (V.preview_min_window_days ?? 1)) return { delta: null, raw: null, w: null, from: null };
    const raw = now.installs - past.installs;
    return { delta: (raw * V.full_window_days) / w, raw, w, from: past.snapshot_date };
  };

  tick('metrics+history');
  // ---------- органика: ступени и улика ----------
  const ads = loadAdsEvidence(d);
  const orgCache = new Map();
  const organicOf = (id) => {
    if (orgCache.has(id)) return orgCache.get(id);
    const c = cardOf(id);
    let gg = null;
    if (c) {
      for (const h of [hostOf(c.developer_website), hostOf(c.privacy_policy)]) {
        if (h && ads.google.has(h)) { gg = { host: h, ...ads.google.get(h) }; break; }
      }
      // Своего домена нет (бесплатный хостинг) — проверка Google по имени разработчика
      // (check-ads --scope dev-name), ключ «dev:<developer_id>».
      const byName = !gg && c.developer_id ? ads.google.get('dev:' + c.developer_id) : null;
      if (byName) gg = { host: 'по имени разработчика', ...byName };
    }
    const mm = ads.meta.get(id) || null;
    const tr = ads.tracking.get(id) || null;
    const ap = ads.apk.get(id) || null;
    const attribution = ap ? ap.attribution_sdk : (tr && tr.found ? 1 : null);
    const gF = gg ? gg.found : null, mF = mm ? mm.found : null;
    const adsFound = gF === 1 && mF === 1 ? 'both' : gF === 1 ? 'google' : mF === 1 ? 'meta'
      : (gF === 0 && mF === 0 ? 'none' : 'unchecked');
    let level = 'unchecked', evidenceDate = null, evidenceAge = null;
    if (['google', 'meta', 'both'].includes(adsFound) || attribution === 1) level = 'found';
    else if (adsFound === 'none') {
      evidenceDate = gg.checked < mm.checked ? gg.checked : mm.checked;
      evidenceAge = Math.max(0, daysBetween(evidenceDate, D));
      const fresh = evidenceAge <= V.evidence_ttl_days;
      if (ap && ap.attribution_sdk === 0) level = fresh ? 'confirmed' : 'stale';
      else if (tr && tr.found === 0) level = fresh ? 'no_signs' : 'stale';
    }
    const out = {
      level, evidenceDate, evidenceAge, adsFound,
      // Реклама проверена: закупка найдена или обе библиотеки пусты со свежей уликой.
      // Скан трекера для этого не нужен — он отличает «признаков нет» от «не проверено».
      adsKnown: level === 'found' || (adsFound === 'none' && evidenceAge <= V.evidence_ttl_days),
      google: gF, googleChecked: gg?.checked ?? null, googleHost: gg?.host ?? null,
      googleCreatives: gg?.found ? gg.creatives : null, googleFirst: gg?.found ? gg.first : null, googleLast: gg?.found ? gg.last : null,
      googleActive: gg?.found && gg.last && gg.withAds ? (daysBetween(gg.last, gg.withAds) <= V.ads_active_days ? 1 : 0) : (gF === 0 ? 0 : null),
      meta: mF, metaChecked: mm?.checked ?? null,
      ever: gF === 1 || mF === 1 ? 1 : 0,
      attribution, trackingNames: tr?.found ? tr.matched_names : null, apkParsed: ap ? 1 : 0,
    };
    orgCache.set(id, out);
    return out;
  };
  const organicLevels = new Set(['confirmed', 'no_signs']);

  tick('ads-evidence');
  // ---------- ключи ядра ----------
  const kwMetric = new Map(); // kw -> {door_key, door_app, cards, paid, checkedShare, serpDate}
  for (const kw of allKeywords) {
    const s = latest(kw);
    if (!s) { kwMetric.set(kw, { door_key: null, door_app: null, cards: 0, paid: null, checkedShare: null, serpDate: null }); continue; }
    const top10 = s.list.filter((x) => x.pos <= 10).map((x) => x.app);
    const vals = top10.map((a) => ({ a, v: installsOf(a) })).filter((x) => x.v != null);
    const minRow = vals.length >= 3 ? vals.reduce((m, x) => (x.v < m.v ? x : m)) : null;
    // Трафик ключа делится между местами топ-10 по кривой CTR. Доля закупки — сколько этого
    // трафика уходит приложениям со ступенью «Закупка найдена» среди проверенных; покрытие —
    // какая доля трафика ключа приходится на проверенные приложения (П15 ТЗ).
    let ctrAll = 0, ctrKnown = 0, ctrPaid = 0;
    for (const x of s.list) {
      if (x.pos > 10) break;
      const o = organicOf(x.app);
      ctrAll += ctr(x.pos);
      if (o.adsKnown) ctrKnown += ctr(x.pos);
      if (o.level === 'found') ctrPaid += ctr(x.pos);
    }
    kwMetric.set(kw, {
      door_key: minRow ? minRow.v : null, door_app: minRow ? minRow.a : null, cards: vals.length,
      paid: top10.length ? (top10.some((a) => organicOf(a).level === 'found') ? 1 : 0) : null,
      paidShare: ctrKnown > 0 ? ctrPaid / ctrKnown : null,
      checkedShare: ctrAll > 0 ? ctrKnown / ctrAll : null,
      serpDate: s.date,
    });
  }
  const doorKeyP25 = quantile([...kwMetric.values()].map((k) => k.door_key), 0.25);

  tick('keywords');
  // ---------- вес приложения в поиске гео и курс ----------
  const weight = new Map(), kwContrib = new Map();
  for (const kw of allKeywords) {
    const s = latest(kw);
    if (!s || !sug(kw)) continue;
    for (const x of s.list) {
      const w = sug(kw) * ctr(x.pos);
      if (!w) continue;
      weight.set(x.app, (weight.get(x.app) || 0) + w);
      if (!kwContrib.has(x.app)) kwContrib.set(x.app, []);
      kwContrib.get(x.app).push({ kw, pos: x.pos, sug: round(sug(kw)), contrib: round(w) });
    }
  }
  const inTop10Core = new Set();
  for (const kw of allKeywords) { const s = latest(kw); if (s) for (const a of s.top10) inTop10Core.add(a); }
  const ratios = [];
  let maxWindow = 0;
  for (const id of inTop10Core) {
    const dl = delta30(id);
    maxWindow = Math.max(maxWindow, dl.span || 0);
    const m = metricsById.get(id);
    if (!organicLevels.has(organicOf(id).level) || ageOf(id) == null || m?.installs_consistency !== 1) continue;
    if (dl.delta == null || dl.delta <= 0 || !(weight.get(id) > 0)) continue;
    ratios.push(dl.delta / weight.get(id));
  }
  let calib;
  if (maxWindow < V.min_window_days) calib = { k: null, status: `копится история: ${maxWindow} из ${V.min_window_days} дней` };
  else if (ratios.length < V.calibration_min_obs) calib = { k: null, status: `мало наблюдений: ${ratios.length} из ${V.calibration_min_obs}` };
  else calib = { k: median(ratios), p25: quantile(ratios, 0.25), p75: quantile(ratios, 0.75), status: 'ok' };

  // ---------- приложения: прирост, источник трафика ----------
  const asoShare = new Map();
  for (const r of appRows) {
    const dl = delta30(r.app_id);
    if (calib.k == null || dl.delta == null || dl.delta <= 0) continue;
    const explained = calib.k * (weight.get(r.app_id) || 0);
    asoShare.set(r.app_id, { explained, share: Math.max(0, Math.min(1, explained / dl.delta)) });
  }
  const asoP25 = quantile([...asoShare.values()].map((x) => x.share), 0.25);

  tick('weight+calib');
  // ---------- УБТ по отзывам (ТЗ v2.2) ----------
  // Доля отзывов с упоминанием соцсетей и видео — на всех языках: отзыв хранится один раз, под
  // языком первого гео, где собиралось приложение, и у поздних гео своих отзывов почти нет
  // (IT — у 12 приложений из 255). Признак описывает само приложение; порог p75 — внутри гео.
  // У приложений, где площадка есть в названии, описании или ниша про видео, названия площадок
  // в отзывах — про функцию, а не про источник, поэтому для них считаются только фразы-источники
  // («увидел в тиктоке»).
  const ubtLex = ubtLexicon();
  const platformRe = new RegExp(ubtLex.platform_related_regex, 'iu');
  const relatedConcepts = new Set(ubtLex.platform_related_concepts || []);
  const relatedGenres = new Set(ubtLex.platform_related_genres || []);
  const ubtIds = new Set(appRows.map((a) => a.app_id));
  for (const kw of allKeywords) { const s = latest(kw); if (s) for (const a of s.top20) ubtIds.add(a); }
  // Два простых запроса вместо одного с вложенными EXISTS на каждую строку: тот шёл минутами
  // на миллионе отзывов, эти — доли секунды (число отзывов по индексу приложения, метки — по
  // версии классификатора, их единицы тысяч).
  const ubtRaw = new Map();
  for (const r of d.prepare(
    `SELECT app_id, COUNT(*) AS n FROM raw_reviews
      WHERE app_id IN (SELECT value FROM json_each(?)) GROUP BY app_id`
  ).all(JSON.stringify([...ubtIds]))) ubtRaw.set(r.app_id, { n: r.n, ph: 0, anyu: 0, reviews: new Map() });
  for (const r of d.prepare(
    `SELECT rv.app_id, rv.review_id, l.label FROM review_labels l JOIN raw_reviews rv ON rv.review_id=l.review_id
      WHERE l.classifier_version=?`
  ).all(ubtLex.version)) {
    const cur = ubtRaw.get(r.app_id);
    if (!cur) continue;
    const prev = cur.reviews.get(r.review_id) || { ph: 0 };
    if (r.label === 'ubt_phrase') prev.ph = 1;
    cur.reviews.set(r.review_id, prev);
  }
  for (const cur of ubtRaw.values()) {
    cur.anyu = cur.reviews.size;
    cur.ph = [...cur.reviews.values()].filter((x) => x.ph).length;
    cur.reviews = null;
  }
  const ubtCache = new Map();
  const ubtOf = (id) => {
    if (ubtCache.has(id)) return ubtCache.get(id);
    const c = cardOf(id);
    const concept = nicheById.get(metricsById.get(id)?.niche_id)?.concept;
    const related = (c && (platformRe.test(`${c.title || ''} ${c.summary || ''}`) || relatedGenres.has(c.genre_id))) || relatedConcepts.has(concept) ? 1 : 0;
    const r = ubtRaw.get(id);
    const n = r ? r.n : 0;
    const mentions = r ? (related ? r.ph : r.anyu) : 0;
    const out = { n, mentions, related, share: n >= V.ubt_min_reviews ? mentions / n : null, signal: null };
    ubtCache.set(id, out);
    return out;
  };
  // Порог — p75 среди приложений, у которых упоминания вообще есть: у большинства доля нулевая,
  // и квантиль по всем выродился бы в ноль, то есть «одно упоминание — уже УБТ».
  const ubtP75 = quantile(appRows.map((a) => ubtOf(a.app_id).share).filter((s) => s != null && s > 0), 0.75);
  const ubtSignal = (id) => {
    const u = ubtOf(id);
    if (u.share == null || ubtP75 == null) return null;
    return u.mentions >= V.ubt_min_mentions && u.share > 0 && u.share >= ubtP75 ? 1 : 0;
  };

  tick('ubt');
  // ---------- ниши ----------
  const firstSeenTop10 = (core) => {
    // Первое появление в топ-10 ядра и входы: в топ-10 на снимке, которого не было ни на одном
    // более раннем снимке этого ключа в окне; присутствовавшие на первом снимке — не входы.
    const first = new Map(), entries = new Map(), atStart = new Set();
    let coreFirst = null;
    for (const kw of core) {
      const list = snaps.get(kw) || [];
      if (list.length && (!coreFirst || list[0].date < coreFirst)) coreFirst = list[0].date;
      const seen = new Set();
      list.forEach((s, i) => {
        for (const a of s.top10) {
          if (!first.has(a) || s.date < first.get(a)) first.set(a, s.date);
          if (seen.has(a)) continue;
          if (i === 0) atStart.add(a);
          else if (!entries.has(a) || s.date < entries.get(a)) entries.set(a, s.date);
          seen.add(a);
        }
      });
    }
    for (const a of atStart) entries.delete(a);
    return { first, entries, coreFirst };
  };

  const nicheRows = [];
  for (const n of niches) {
    const core = cores.get(n.niche_id) || [];
    const head = core.includes(n.head_keyword) ? n.head_keyword : core[0] || n.head_keyword;
    const km = core.map((kw) => ({ kw, s: sug(kw), ...kwMetric.get(kw) }));
    const withDoor = km.filter((k) => k.door_key != null);
    const sugSum = km.reduce((a, k) => a + k.s, 0);
    const sugP50 = quantile(km.map((k) => k.s), 0.5);
    for (const k of km) k.is_free = k.door_key != null && doorKeyP25 != null && k.door_key <= doorKeyP25 && k.s > 0 && k.s >= sugP50 ? 1 : 0;
    const doorEnough = core.length > 0 && withDoor.length >= core.length / 2;
    const free = km.filter((k) => k.is_free);
    const freeKeysCount = doorEnough ? free.length : null;
    const freeDemandShare = doorEnough && sugSum > 0 ? free.reduce((a, k) => a + k.s, 0) / sugSum : null;

    let doorHead = null, doorTail = null;
    if (core.length >= 4) {
      const bySug = km.slice().sort((a, b) => b.s - a.s);
      const cut = Math.ceil(core.length / 4);
      doorHead = median(bySug.slice(0, cut).map((k) => k.door_key));
      doorTail = median(bySug.slice(cut).map((k) => k.door_key));
    }
    const vel = withDoor.map((k) => delta30(k.door_app).delta).filter((v) => v != null);
    const doorVelocity = vel.length ? median(vel) : null;

    const demandPerApp = n.demand_installs != null && n.apps_count ? n.demand_installs / n.apps_count : null;

    const headSnap = latest(head);
    const headTop10 = headSnap ? headSnap.list.filter((x) => x.pos <= 10) : [];
    const headCards = headTop10.filter((x) => cards.has(x.app));
    const headToks = tokens(head);
    const asoSaturation = headCards.length >= 5 && headToks.length
      ? headCards.filter((x) => headToks.every((t) => String(cards.get(x.app).title || '').toLowerCase().includes(t))).length / headCards.length
      : null;

    const { first, entries, coreFirst } = firstSeenTop10(core);
    const historyDays = coreFirst ? daysBetween(coreFirst, D) : 0;
    const entryOk = historyDays >= V.min_window_days;
    const entryDates = [...entries.values()];
    const entryRate = entryOk ? entryDates.length : null;
    const lastEntryDays = entryOk && entryDates.length ? daysBetween(entryDates.sort().pop(), D) : null;

    let changed = 0, fresh = 0, turnoverWindow = null;
    for (const kw of core) {
      const list = snaps.get(kw) || [];
      const now = list[list.length - 1];
      if (!now) continue;
      const target = shift(D, -V.full_window_days);
      let past = [...list].reverse().find((s) => s.date <= target);
      if (!past) past = list.find((s) => daysBetween(s.date, now.date) >= V.min_window_days);
      if (!past || past === now) continue;
      turnoverWindow = Math.max(turnoverWindow ?? 0, daysBetween(past.date, now.date));
      for (const a of now.top10) {
        if (past.top10.has(a)) continue;
        changed++;
        if (!past.top50.has(a)) fresh++;
      }
    }
    const turnoverUpNew = turnoverWindow == null ? null : (changed ? fresh / changed : 0);

    const headAny = headTop10.filter((x) => cardOf(x.app));
    const ttd = headAny.map((x) => {
      const age = ageOf(x.app), inst = installsOf(x.app);
      if (age == null || !inst || n.door == null || age <= 0) return null;
      return Math.min(n.door / (inst / age), age);
    });
    const ttdKnown = ttd.filter((v) => v != null);
    const timeToDoor = headAny.length && ttdKnown.length >= headAny.length / 2 ? median(ttdKnown) : null;

    const headInst = headTop10.map((x) => installsOf(x.app)).filter((v) => v != null);
    const wall = headInst.reduce((a, v) => a + v, 0);
    const hhi = wall > 0 ? headInst.reduce((a, v) => a + (v / wall) ** 2, 0) : null;

    const union50 = new Set(), union20 = new Set();
    for (const kw of core) { const s = latest(kw); if (s) { for (const a of s.top50) union50.add(a); for (const a of s.top20) union20.add(a); } }
    const devOf = (a) => cardOf(a)?.developer_id || null;
    const devKnown = [...union50].filter(devOf);
    let cloneDensity = null;
    if (union50.size && devKnown.length >= union50.size / 2) {
      const cnt = new Map();
      for (const a of devKnown) cnt.set(devOf(a), (cnt.get(devOf(a)) || 0) + 1);
      cloneDensity = devKnown.filter((a) => cnt.get(devOf(a)) >= V.clone_min_apps || factories.has(devOf(a))).length / devKnown.length;
    }

    // Чистота: доля спроса ядра, который уходит не закупающим приложениям, — взвешенно и по
    // спросу ключа, и по месту в топ-10. Покрытие проверки считается так же.
    const wOf = (k) => (sugSum > 0 ? k.s : 1);
    const wSum = km.reduce((a, k) => a + (k.checkedShare == null ? 0 : wOf(k)), 0);
    const coverage = wSum ? km.reduce((a, k) => a + (k.checkedShare == null ? 0 : wOf(k) * k.checkedShare), 0) / wSum : null;
    const wKnown = km.reduce((a, k) => a + (k.paidShare == null ? 0 : wOf(k)), 0);
    const purity = coverage != null && coverage >= V.purity_min_checked_share && wKnown > 0
      ? 1 - km.reduce((a, k) => a + (k.paidShare == null ? 0 : wOf(k) * k.paidShare), 0) / wKnown : null;
    const top10AdsShare = headTop10.length ? headTop10.filter((x) => organicOf(x.app).level === 'found').length / headTop10.length : null;

    // Молодые органики (решение заказчика: < 12 мес) и срок входа.
    const u20 = [...union20];
    const ageKnown = u20.filter((a) => ageOf(a) != null);
    let youngCount = null, youngInstalls = null, youngApps = [], tto = null, ttoKind = null;
    if (u20.length && ageKnown.length >= u20.length / 2) {
      youngApps = ageKnown.filter((a) => ageOf(a) < V.young_months && organicLevels.has(organicOf(a).level));
      youngCount = youngApps.length;
      youngInstalls = youngApps.reduce((s, a) => s + (installsOf(a) || 0), 0);
      const measured = entryOk ? youngApps.filter((a) => entries.has(a)).map((a) => ageOf(a) - daysBetween(entries.get(a), D) / 30.44) : [];
      const upper = youngApps.filter((a) => first.has(a)).map((a) => ageOf(a) - daysBetween(first.get(a), D) / 30.44);
      if (measured.length) { tto = median(measured); ttoKind = 'measured'; }
      else if (upper.length) { tto = median(upper); ttoKind = 'upper'; }
    }

    const cand = appRows.filter((r) => r.niche_id === n.niche_id && r.screen_date && r.screen_reject == null);
    const candPaid = cand.filter((r) => organicOf(r.app_id).level === 'found').length;

    // УБТ ниши: доля приложений топ-20 ядра и кандидатов с признаком — среди тех, где отзывов
    // на языках гео достаточно для доли.
    const ubtPool = new Set([...union20, ...cand.map((r) => r.app_id)]);
    const ubtLabeled = [...ubtPool].filter((a) => ubtSignal(a) != null);
    const ubtNicheShare = ubtLabeled.length >= V.ubt_niche_min_apps
      ? ubtLabeled.filter((a) => ubtSignal(a) === 1).length / ubtLabeled.length : null;

    const headMetrics = headTop10.map((x) => metricsById.get(x.app)).filter(Boolean);
    const monetKnown = headMetrics.filter((m) => m.monetization_proof != null);
    const monetizedShare = monetKnown.length >= 5 ? monetKnown.filter((m) => m.monetization_proof >= 1).length / monetKnown.length : null;
    const top3 = headTop10.slice(0, 3).map((x) => metricsById.get(x.app)).filter((m) => m && m.pain_money != null);
    const leadersPain = top3.length ? {
      money: round(median(top3.map((m) => m.pain_money))), ads: round(median(top3.map((m) => m.pain_ads))),
      broken: round(median(top3.map((m) => m.pain_broken))),
    } : null;

    nicheRows.push({
      n, core, head, km, freeKeysCount, freeDemandShare, doorHead, doorTail, doorVelocity, demandPerApp,
      asoSaturation, historyDays, entryRate, lastEntryDays, turnoverUpNew, turnoverWindow, timeToDoor, hhi, cloneDensity,
      purity, coverage, top10AdsShare, youngCount, youngInstalls, youngApps, tto, ttoKind,
      candidates: cand.length, candPaid, monetizedShare, leadersPain,
      ubtNicheShare, ubtLabeledCount: ubtLabeled.length,
      headTop10: headTop10.map((x) => {
        const o = organicOf(x.app), m = metricsById.get(x.app), age = ageOf(x.app);
        return {
          pos: x.pos, app_id: x.app, title: cardOf(x.app)?.title ?? null, installs: installsOf(x.app),
          age: round(age, 3), level: o.level, young: age != null && age < V.young_months ? 1 : 0,
          passed: m && m.screen_date && m.screen_reject == null ? 1 : 0,
        };
      }),
    });
  }

  tick('niches-loop');
  // ---------- индекс свободы ----------
  const W = V.freedom_weights;
  const comp = [
    ['free_demand_share', (r) => r.freeDemandShare, null],
    ['relevance_gap', (r) => r.n.relevance_gap_pct, 'up'],
    ['aso_saturation', (r) => r.asoSaturation, 'down'],
    ['demand_per_app', (r) => (r.demandPerApp == null ? null : Math.log10(1 + r.demandPerApp)), 'up'],
    ['entry_rate', (r) => r.entryRate, 'up'],
    ['turnover_up_new', (r) => r.turnoverUpNew, 'up'],
    ['clone_density', (r) => r.cloneDensity, 'down'],
  ];
  const bounds = {};
  for (const [name, get, dir] of comp) {
    if (!dir) continue;
    const vals = nicheRows.map(get);
    bounds[name] = { p10: quantile(vals, 0.1), p90: quantile(vals, 0.9) };
  }
  for (const r of nicheRows) {
    let sum = 0, wsum = 0;
    const parts = [], missing = [];
    for (const [name, get, dir] of comp) {
      const raw = num(get(r));
      let nv = null;
      if (raw != null) {
        if (!dir) nv = Math.max(0, Math.min(1, raw));
        else {
          const b = norm(raw, bounds[name].p10, bounds[name].p90);
          nv = b == null ? null : (dir === 'down' ? 1 - b : b);
        }
      }
      if (nv == null) { missing.push(name); parts.push({ name, raw: round(raw), n: null, w: W[name], contrib: null }); continue; }
      sum += nv * W[name]; wsum += W[name];
      parts.push({ name, raw: round(raw), n: round(nv), w: W[name], contrib: null });
    }
    r.freedomRaw = wsum >= V.freedom_min_weight ? sum / wsum : null;
    for (const p of parts) if (p.n != null && r.freedomRaw != null) p.contrib = round((p.n * p.w) / wsum);
    r.components = parts;
    r.missing = missing;
  }
  const freedomPct = percentileOf(nicheRows.map((r) => r.freedomRaw));
  const purityP50 = quantile(nicheRows.map((r) => r.purity), 0.5);
  const fdsP75 = quantile(nicheRows.map((r) => r.freeDemandShare), 0.75);
  const lastEntryP90 = quantile(nicheRows.map((r) => r.lastEntryDays), 0.9);
  const purityMedian = purityP50;

  for (const r of nicheRows) {
    r.freedomPct = r.freedomRaw == null ? null : freedomPct(r.freedomRaw);
    r.closed = r.historyDays >= V.entry_window_days && r.lastEntryDays != null && lastEntryP90 != null && r.lastEntryDays > lastEntryP90 ? 1 : 0;
    const capSum = r.km.filter((k) => k.is_free).reduce((a, k) => a + k.s, 0) * ctr(V.capacity_position);
    r.capacity = calib.k != null && r.freeKeysCount != null ? calib.k * capSum : null;
    r.capacityLo = r.capacity != null ? calib.p25 * capSum : null;
    r.capacityHi = r.capacity != null ? calib.p75 * capSum : null;
  }
  const capMedian = median(nicheRows.map((r) => r.capacity));
  const basis = calib.k != null ? 'full' : 'no_capacity';
  for (const r of nicheRows) {
    const incomplete = [...r.missing];
    // Ниша из одного-двух ключей (остаток концепта): доля свободного спроса там 0 или 1, и
    // индекс свободы по ней шумный. Ранг считается, но данные помечаются неполными.
    if (r.core.length < 3) incomplete.push('core_keywords');
    if (r.freedomPct == null) { r.rank = null; }
    else {
      let p = r.purity;
      if (p == null) { incomplete.push('organic_purity'); p = purityMedian ?? 1; }
      let rank = r.freedomPct * p;
      if (basis === 'full') {
        let cap = r.capacity;
        if (cap == null) { incomplete.push('organic_capacity'); cap = capMedian; }
        if (cap != null) rank *= Math.log10(1 + cap);
      }
      r.rank = rank;
    }
    r.incomplete = incomplete;
    if (r.freedomPct == null || r.purity == null || purityP50 == null) r.quadrant = 'undetermined';
    else if (r.freedomPct >= 75) r.quadrant = r.purity >= purityP50 ? 'target' : 'bought';
    else r.quadrant = r.purity >= purityP50 ? 'mature' : 'pass';
    r.tailClean = r.quadrant === 'bought' && r.freeDemandShare != null && fdsP75 != null && r.freeDemandShare >= fdsP75 ? 1 : 0;
  }
  const rankPct = percentileOf(nicheRows.map((r) => r.rank));

  // УБТ-ниша: доля приложений с признаком не ниже p75 ниш гео и больше нуля.
  const ubtNicheP75 = quantile(nicheRows.map((r) => r.ubtNicheShare), 0.75);
  for (const r of nicheRows) {
    r.ubtFlag = r.ubtNicheShare == null || ubtNicheP75 == null ? null : (r.ubtNicheShare > 0 && r.ubtNicheShare >= ubtNicheP75 ? 1 : 0);
  }

  // Рекомендуемый топ ниш (ТЗ v2.2): упор на свободные ключи. Квадрант «Мимо» и закрытые ниши
  // не рекомендуются. Части — доли 0–1; пустые исключаются вместе с весом.
  const R = V.recommended;
  const pctFreeKeys = percentileOf(nicheRows.map((r) => r.freeKeysCount));
  const pctYoung = percentileOf(nicheRows.map((r) => r.youngCount));
  const pctCap = calib.k != null ? percentileOf(nicheRows.map((r) => r.capacity)) : percentileOf(nicheRows.map((r) => r.n.suggest_score_sum));
  for (const r of nicheRows) {
    if (r.quadrant === 'pass' || r.closed) { r.rec = null; r.recParts = null; continue; }
    const fk = R.free_keys_parts, nw = R.niche_weights;
    const pct01 = (f, v) => { const p = f(v); return p == null ? null : p / 100; };
    const parts = [
      weighted([[r.freeDemandShare, fk.free_demand_share], [pct01(pctFreeKeys, r.freeKeysCount), fk.free_keys_count]]),
      r.freedomPct == null ? null : r.freedomPct / 100,
      r.purity,
      pct01(pctYoung, r.youngCount),
      r.monetizedShare,
      pct01(pctCap, calib.k != null ? r.capacity : r.n.suggest_score_sum),
    ];
    const ws = [nw.free_keys, nw.freedom, nw.purity, nw.young_organic, nw.monetized, nw.capacity];
    r.rec = weighted(parts.map((v, i) => [v, ws[i]]));
    r.recParts = parts.map((v) => round(v, 3));
  }
  const recNichePct = percentileOf(nicheRows.map((r) => r.rec));

  tick('freedom+rank+rec-niches');
  // ---------- семь проверок ----------
  const tertile = (vals) => quantile(vals, 2 / 3);
  const weakT = tertile(niches.map((n) => n.weak_share));
  const gapT = tertile(niches.map((n) => n.index_gap_leader));
  const wallP90 = quantile(niches.map((n) => n.wall_installs), 0.9);
  const wallRP90 = quantile(niches.map((n) => n.wall_ratings), 0.9);
  const updP90 = qv(null, geo, 'days_since_update', D, 'p90', { nicheFirst: false });
  const leaderDaysByNiche = new Map();
  for (const r of nicheRows) {
    const headApps = r.headTop10.filter((x) => x.installs != null);
    const leader = headApps.length ? headApps.reduce((m, x) => (x.installs > m.installs ? x : m)) : null;
    const upd = leader ? cardOf(leader.app_id)?.updated_ts : null;
    leaderDaysByNiche.set(r.n.niche_id, upd ? (Date.parse(D) - upd) / DAY : null);
  }
  const fmt = (v, p = 2) => (v == null ? '—' : Number(v).toFixed(p));

  const appOut = [];
  const recIn = [];
  for (const m of appRows) {
    const o = organicOf(m.app_id);
    const card = cards.get(m.app_id);
    const age = ageOf(m.app_id);
    const dl = delta30(m.app_id);
    const aso = asoShare.get(m.app_id) || null;
    const traffic = aso ? (asoP25 != null && aso.share < asoP25 ? 'external' : 'search') : null;
    const n = m.niche_id ? nicheById.get(m.niche_id) : null;
    const notes = [];

    let c1 = null;
    const p95src = qv(m.niche_id, geo, 'src_ads_pct', D, 'p95');
    if ((m.demand != null && m.demand < 0.25) || (m.src_ads_pct != null && p95src != null && m.src_ads_pct > p95src)) c1 = 0;
    else if (m.demand != null && m.demand >= 0.5 && m.src_ads_pct != null && p95src != null) c1 = 1;
    notes.push(`demand ${fmt(m.demand)} (≥ 0,50 / < 0,25); src_ads_pct ${fmt(m.src_ads_pct)} при p95 ниши ${fmt(p95src)}`);

    const leaderDays = n ? leaderDaysByNiche.get(n.niche_id) : null;
    // «Верхняя треть» по доле, где у большинства ниш ноль, начиналась бы с нуля и включала всех.
    const sig = [
      n?.weak_share != null && weakT != null ? n.weak_share >= weakT && n.weak_share > 0 : null,
      n?.index_gap_leader != null && gapT != null ? n.index_gap_leader >= gapT && n.index_gap_leader > 0 : null,
      leaderDays != null && updP90 != null ? leaderDays > updP90 : null,
    ];
    const c2 = sig.some((v) => v === true) ? 1 : sig.every((v) => v === false) ? 0 : null;
    notes.push(`weak_share ${fmt(n?.weak_share)} (верхняя треть ≥ ${fmt(weakT)}); index_gap_leader ${fmt(n?.index_gap_leader)} (≥ ${fmt(gapT)}); лидер не обновлялся ${fmt(leaderDays, 0)} дн. (p90 гео ${fmt(updP90, 0)})`);

    const c3 = o.level === 'confirmed' ? 1 : o.level === 'found' ? 0 : null;
    notes.push(`ступень органики: ${o.level}`);
    const c3b = ['confirmed', 'no_signs', 'stale'].includes(o.level) && traffic ? (traffic === 'search' ? 1 : 0) : null;
    notes.push(aso ? `aso_share ${fmt(aso.share)} при p25 гео ${fmt(asoP25)}` : `aso_share пуст: ${calib.k == null ? calib.status : 'нет прироста за окно'}`);
    const c4 = m.feasibility == null ? null : m.feasibility >= 0.75 ? 1 : m.feasibility <= 0.25 ? 0 : null;
    notes.push(`feasibility ${fmt(m.feasibility)} (≥ 0,75 / ≤ 0,25)`);
    const c5 = m.monetization_proof == null ? null : m.monetization_proof >= 1 ? 1 : 0;
    notes.push(`monetization_proof ${fmt(m.monetization_proof, 1)}`);
    const c6 = m.policy_ok === 1 ? 1 : m.policy_ok === 0 && m.policy_auto_ok === 0 ? 0 : null;
    notes.push(`policy_ok ${m.policy_ok ?? '—'}, автогейт ${m.policy_auto_ok ?? '—'}`);
    const checks = [c1, c2, c3, c3b, c4, c5, c6];

    const disq = [];
    if (o.level === 'found') disq.push('paid');
    if (traffic === 'external') disq.push('external');
    if (m.fraud_ok === 0) disq.push('fraud');
    if (n && ((n.wall_installs != null && wallP90 != null && n.wall_installs > wallP90) || (n.wall_ratings != null && wallRP90 != null && n.wall_ratings > wallRP90))) disq.push('wall');

    // Всплески без обновления листинга и без рекламы (УБТ-сигнал). Нужны дневные точки.
    let spike = null;
    const series = dl.series.filter((p) => p.installs != null);
    if (series.length > V.spike_min_points) {
      const diffs = [];
      for (let i = 1; i < series.length; i++) {
        const gap = daysBetween(series[i - 1].date, series[i].date) || 1;
        const ca = cardHist.get(m.app_id)?.get(series[i - 1].date), cb = cardHist.get(m.app_id)?.get(series[i].date);
        const sameListing = ca && cb && ca.title_hash === cb.title_hash && ca.short_desc_hash === cb.short_desc_hash && ca.listing_hash === cb.listing_hash;
        diffs.push({ v: (series[i].installs - series[i - 1].installs) / gap, sameListing });
      }
      const p95 = quantile(diffs.map((x) => x.v), 0.95);
      spike = o.level === 'found' ? null : diffs.filter((x) => x.v > p95 && x.sameListing).length / diffs.length;
    }

    appOut.push({
      app_id: m.app_id, niche_id: m.niche_id ?? null, passed_funnel: m.screen_date && m.screen_reject == null ? 1 : 0,
      released: card ? parseReleased(card.released, card.hl) : null, age_months: round(age, 4),
      young: age != null && age < V.young_months ? 1 : 0,
      organic_level: o.level, evidence_date: o.evidenceDate, evidence_age_days: o.evidenceAge,
      ads_found: o.adsFound, ads_google: o.google, ads_google_checked: o.googleChecked, ads_google_host: o.googleHost,
      ads_google_creatives: o.googleCreatives, ads_google_first_seen: o.googleFirst, ads_google_last_seen: o.googleLast,
      ads_google_active: o.googleActive, ads_meta: o.meta, ads_meta_checked: o.metaChecked, ads_ever_found: o.ever,
      attribution_sdk: o.attribution, tracking_names: o.trackingNames, apk_parsed: o.apkParsed,
      installs: m.installs ?? null, installs_delta_30d: round(dl.delta), delta_window_days: dl.w, delta_partial: dl.partial,
      ...(() => { const p = deltaPreview(m.app_id); return { delta_preview: round(p.delta), delta_preview_raw: p.raw, delta_preview_w: p.w, delta_preview_from: p.from }; })(),
      search_weight: round(weight.get(m.app_id) ?? null), explained: round(aso?.explained ?? null), aso_share: round(aso?.share ?? null),
      traffic_source: traffic, exogenous_spike_rate: round(spike),
      keywords_json: JSON.stringify((kwContrib.get(m.app_id) || []).sort((a, b) => b.contrib - a.contrib).slice(0, 15)),
      checks: JSON.stringify(checks), check_notes: JSON.stringify(notes),
      passed: checks.filter((v) => v === 1).length, failed: checks.filter((v) => v === 0).length,
      unknown: checks.filter((v) => v == null).length, disq: JSON.stringify(disq),
      ubt_mentions: ubtOf(m.app_id).mentions, ubt_reviews: ubtOf(m.app_id).n, ubt_share: round(ubtOf(m.app_id).share),
      ubt_signal: ubtSignal(m.app_id), ubt_related: ubtOf(m.app_id).related,
      rec_score: null, rec_pct: null, rec_parts: null,
    });
    recIn.push({ m, o, age, delta: dl.delta, traffic, disq, passed: checks.filter((v) => v === 1).length });
  }

  tick('apps-loop');
  // Рекомендуемый топ приложений (ТЗ v2.2): упор на рост из поиска (ASO) и свободу ниши.
  // Нормировки — по прошедшим воронку в гео. Закупка, накрутка и стена авторитета не
  // рекомендуются; непроверенная органика понижается множителем.
  const nicheRowById = new Map(nicheRows.map((r) => [r.n.niche_id, r]));
  const recPop = recIn.filter((x) => x.m.screen_date && x.m.screen_reject == null);
  const pctWeight = percentileOf(recPop.map((x) => weight.get(x.m.app_id) ?? null));
  const kwLo = quantile(recPop.map((x) => x.m.kw_top10_count), 0.1), kwHi = quantile(recPop.map((x) => x.m.kw_top10_count), 0.9);
  const ageLo = quantile(recPop.map((x) => x.age), 0.1), ageHi = quantile(recPop.map((x) => x.age), 0.9);
  const pctDelta = percentileOf(recPop.map((x) => x.delta));
  recIn.forEach((x, i) => {
    const out = appOut[i];
    if (!out.passed_funnel || x.o.level === 'found' || x.disq.includes('fraud') || x.disq.includes('wall')) return;
    const aw = R.app_weights, ap = R.aso_parts, fp = R.freedom_parts, yp = R.youth_parts;
    const nr = x.m.niche_id ? nicheRowById.get(x.m.niche_id) : null;
    const wPct = pctWeight(weight.get(x.m.app_id) ?? null);
    const ageN = norm(x.age, ageLo, ageHi);
    const dPct = pctDelta(x.delta);
    const parts = [
      weighted([[wPct == null ? null : wPct / 100, ap.search_weight], [norm(x.m.kw_top10_count, kwLo, kwHi), ap.top10_keys],
        [x.traffic === 'search' ? 1 : x.traffic === 'external' ? 0 : null, ap.traffic_source]]),
      nr ? weighted([[nr.freeDemandShare, fp.free_demand_share], [nr.freedomPct == null ? null : nr.freedomPct / 100, fp.freedom_pct]]) : null,
      x.passed / 7,
      x.m.prescore == null ? null : x.m.prescore / 100,
      weighted([[ageN == null ? null : 1 - ageN, yp.age], [dPct == null ? null : dPct / 100, yp.growth]]),
      x.m.monetization_proof,
    ];
    const ws = [aw.aso, aw.freedom, aw.checks, aw.prescore, aw.youth, aw.monetization];
    const base = weighted(parts.map((v, j) => [v, ws[j]]));
    if (base == null) return;
    out.rec_score = round(base * (R.level_factor[x.o.level] ?? 0.6));
    out.rec_parts = JSON.stringify(parts.map((v) => round(v, 3)));
  });
  const recAppPct = percentileOf(appOut.map((a) => a.rec_score));
  for (const a of appOut) a.rec_pct = a.rec_score == null ? null : round(recAppPct(a.rec_score), 3);

  tick('rec-apps');
  // ---------- запись ----------
  const insKw = d.prepare(`INSERT OR REPLACE INTO metrics_keyword_geo
    (geo, snapshot_date, niche_id, keyword, is_head, suggest_score, serp_date, top10_cards, door_key, door_app_id, is_free, paid_in_top10, paid_ctr_share, ads_checked_share)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const nicheCols = ['niche_id', 'geo', 'snapshot_date', 'niche_date', 'concept', 'head_keyword', 'keywords_count', 'door', 'wall_installs',
    'free_keys_count', 'free_demand_share', 'door_head', 'door_tail', 'door_velocity', 'demand_per_app', 'aso_saturation', 'relevance_gap_pct',
    'entry_rate_90d', 'last_entry_days', 'history_days', 'time_to_door_median', 'turnover_up_new', 'turnover_window_days', 'hhi_top10', 'clone_density',
    'freedom_components', 'freedom_raw', 'freedom_pct', 'closed_flag', 'organic_capacity', 'organic_capacity_lo', 'organic_capacity_hi',
    'money_ratio', 'money_capacity', 'organic_purity', 'purity_coverage', 'top10_ads_share',
    'young_organic_count', 'young_organic_installs', 'young_organic_apps', 'time_to_organic', 'time_to_organic_kind',
    'candidates_count', 'candidates_organic_count', 'candidates_paid_count', 'monetized_share', 'leaders_pain', 'head_top10',
    'niche_rank', 'rank_basis', 'rank_pct', 'quadrant', 'tail_clean', 'incomplete', 'partial_window',
    'ubt_share', 'ubt_apps', 'ubt_flag', 'rec_score', 'rec_pct', 'rec_parts'];
  const insNiche = d.prepare(`INSERT OR REPLACE INTO metrics_niche_v2 (${nicheCols.join(',')}) VALUES (${nicheCols.map((c) => '@' + c).join(',')})`);
  const appCols = Object.keys(appOut[0] || { app_id: 1 });
  const insApp = appOut.length ? d.prepare(`INSERT OR REPLACE INTO metrics_app_v2 (geo, snapshot_date, ${appCols.join(',')})
    VALUES (@geo, @snapshot_date, ${appCols.map((c) => '@' + c).join(',')})`) : null;
  const insQ = d.prepare(`INSERT OR REPLACE INTO niche_quantiles
    (scope, scope_id, geo, metric, snapshot_date, p01, p10, p25, p50, p75, p90, p95, p99, n) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  d.transaction(() => {
    for (const t of ['metrics_keyword_geo', 'metrics_niche_v2', 'metrics_app_v2']) {
      d.prepare(`DELETE FROM ${t} WHERE geo=? AND snapshot_date=?`).run(geo, D);
    }
    for (const r of nicheRows) {
      for (const k of r.km) {
        insKw.run(geo, D, r.n.niche_id, k.kw, k.kw === r.head ? 1 : 0, round(k.s), k.serpDate, k.cards, k.door_key, k.door_app,
          k.is_free, k.paid, round(k.paidShare), round(k.checkedShare));
      }
      const partial = (r.historyDays < V.entry_window_days && r.entryRate != null) || (r.turnoverWindow != null && r.turnoverWindow < V.full_window_days) ? 1 : 0;
      insNiche.run({
        niche_id: r.n.niche_id, geo, snapshot_date: D, niche_date: nicheDate, concept: r.n.concept ?? null, head_keyword: r.head,
        keywords_count: r.core.length, door: r.n.door ?? null, wall_installs: r.n.wall_installs ?? null,
        free_keys_count: r.freeKeysCount, free_demand_share: round(r.freeDemandShare), door_head: r.doorHead == null ? null : Math.round(r.doorHead),
        door_tail: r.doorTail == null ? null : Math.round(r.doorTail), door_velocity: round(r.doorVelocity), demand_per_app: round(r.demandPerApp),
        aso_saturation: round(r.asoSaturation), relevance_gap_pct: round(r.n.relevance_gap_pct),
        entry_rate_90d: r.entryRate, last_entry_days: r.lastEntryDays, history_days: r.historyDays, time_to_door_median: round(r.timeToDoor),
        turnover_up_new: round(r.turnoverUpNew), turnover_window_days: r.turnoverWindow, hhi_top10: round(r.hhi), clone_density: round(r.cloneDensity),
        freedom_components: JSON.stringify(r.components), freedom_raw: round(r.freedomRaw), freedom_pct: round(r.freedomPct, 3), closed_flag: r.closed,
        organic_capacity: round(r.capacity), organic_capacity_lo: round(r.capacityLo), organic_capacity_hi: round(r.capacityHi),
        money_ratio: round(moneyRatio), money_capacity: round(r.capacity != null && moneyRatio != null ? r.capacity * moneyRatio : null),
        organic_purity: round(r.purity), purity_coverage: round(r.coverage), top10_ads_share: round(r.top10AdsShare),
        young_organic_count: r.youngCount, young_organic_installs: r.youngInstalls,
        young_organic_apps: JSON.stringify(r.youngApps.slice(0, 30).map((a) => ({ app_id: a, title: cardOf(a)?.title ?? null, age: round(ageOf(a), 3), installs: installsOf(a), level: organicOf(a).level }))),
        time_to_organic: round(r.tto, 3), time_to_organic_kind: r.ttoKind,
        candidates_count: r.candidates, candidates_organic_count: r.candidates - r.candPaid, candidates_paid_count: r.candPaid,
        monetized_share: round(r.monetizedShare), leaders_pain: r.leadersPain ? JSON.stringify(r.leadersPain) : null,
        head_top10: JSON.stringify(r.headTop10),
        niche_rank: round(r.rank), rank_basis: r.rank == null ? null : basis, rank_pct: round(r.rank == null ? null : rankPct(r.rank), 3),
        quadrant: r.quadrant, tail_clean: r.tailClean, incomplete: JSON.stringify(r.incomplete), partial_window: partial,
        ubt_share: round(r.ubtNicheShare), ubt_apps: r.ubtLabeledCount, ubt_flag: r.ubtFlag,
        rec_score: round(r.rec), rec_pct: r.rec == null ? null : round(recNichePct(r.rec), 3),
        rec_parts: r.recParts ? JSON.stringify(r.recParts) : null,
      });
    }
    for (const a of appOut) insApp.run({ geo, snapshot_date: D, ...a });
    d.prepare(`INSERT OR REPLACE INTO metrics_geo_calibration (geo, snapshot_date, k_geo, k_p25, k_p75, n_obs, n_candidates, window_days, status)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(geo, D, round(calib.k), round(calib.p25 ?? null), round(calib.p75 ?? null), ratios.length, inTop10Core.size, maxWindow, calib.status);
    const qSets = {
      door_key: [...kwMetric.values()].map((k) => k.door_key),
      free_keys_count: nicheRows.map((r) => r.freeKeysCount), free_demand_share: nicheRows.map((r) => r.freeDemandShare),
      relevance_gap_pct: nicheRows.map((r) => r.n.relevance_gap_pct), aso_saturation: nicheRows.map((r) => r.asoSaturation),
      demand_per_app_log: nicheRows.map((r) => (r.demandPerApp == null ? null : Math.log10(1 + r.demandPerApp))),
      entry_rate_90d: nicheRows.map((r) => r.entryRate), turnover_up_new: nicheRows.map((r) => r.turnoverUpNew),
      clone_density: nicheRows.map((r) => r.cloneDensity), organic_purity: nicheRows.map((r) => r.purity),
      last_entry_days: nicheRows.map((r) => r.lastEntryDays), freedom_raw: nicheRows.map((r) => r.freedomRaw),
      wall_installs: niches.map((n) => n.wall_installs), wall_ratings: niches.map((n) => n.wall_ratings),
      aso_share: [...asoShare.values()].map((x) => x.share),
      ubt_share: appRows.map((a) => ubtOf(a.app_id).share),
      // Порог признака УБТ — p75 среди упоминаемых (доля > 0), как в ubtSignal.
      ubt_share_mentioned: appRows.map((a) => ubtOf(a.app_id).share).filter((s) => s != null && s > 0),
      ubt_niche_share: nicheRows.map((r) => r.ubtNicheShare),
    };
    for (const [metric, vals] of Object.entries(qSets)) {
      const q = quantileSet(vals);
      if (q) insQ.run('geo', `${geo}:v2`, geo, metric, D, q.p01, q.p10, q.p25, q.p50, q.p75, q.p90, q.p95, q.p99, q.n);
    }
  })();

  const withFreedom = nicheRows.filter((r) => r.freedomRaw != null).length;
  const quad = nicheRows.reduce((acc, r) => { acc[r.quadrant] = (acc[r.quadrant] || 0) + 1; return acc; }, {});
  const levels = appOut.reduce((acc, a) => { acc[a.organic_level] = (acc[a.organic_level] || 0) + 1; return acc; }, {});
  const agePct = appOut.length ? Math.round((100 * appOut.filter((a) => a.age_months != null).length) / appOut.length) : 0;
  const ubtApps = appOut.filter((a) => a.ubt_signal === 1).length, ubtKnown = appOut.filter((a) => a.ubt_signal != null).length;
  const notes = `день ${D} (ниши ${nicheDate}); ниш ${nicheRows.length}, со свободой ${withFreedom}; квадранты ${JSON.stringify(quad)}; ` +
    `курс: ${calib.status}; приложений ${appOut.length}, возраст ${agePct} %, органика ${JSON.stringify(levels)}; ` +
    `УБТ ${ubtApps} из ${ubtKnown} с разметкой, УБТ-ниш ${nicheRows.filter((r) => r.ubtFlag === 1).length}; ` +
    `рекомендуемых приложений ${appOut.filter((a) => a.rec_score != null).length}, ниш ${nicheRows.filter((r) => r.rec != null).length}`;
  finishRun(runId, 'radar-v2', geo, { notes });
  log(`  ${geo}: ${notes}`);
  return { niches: nicheRows.length, apps: appOut.length, date: D };
}
