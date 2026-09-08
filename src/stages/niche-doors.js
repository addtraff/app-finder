// D8 (этап 3) + door. Кластеризация ключей в ниши и расчёт метрик ниши.
// Критично: берётся САМАЯ СВЕЖАЯ выдача по каждому ключу, а не сегодняшний срез —
// иначе ниши строятся из случайной дневной горсти ключей и не сопоставимы между днями (ТЗ 8, риск 3).
import { db, startRun, finishRun, logEvent } from '../lib/db.js';
import { config, geoConf } from '../lib/config.js';
import { qv } from './quantiles.js';
import { setWatchLevel } from '../lib/registry.js';
import { UnionFind, jaccard, median, md5, quantile, log } from '../lib/util.js';

const DAY_MS = 86400000;

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 2);
}

export async function run({ geo, date, runId, cycle = 'discovery' }) {
  const d = db();
  startRun(runId, 'niche-doors', geo, cycle, date);
  const cl = config().scoring.clustering;
  const g = geoConf(geo);

  // 1. Самая свежая выдача по каждому ключу.
  const serp = d.prepare(
    `SELECT r.keyword, r.position, r.app_id
       FROM raw_search r
       JOIN (SELECT keyword, MAX(snapshot_date) AS md FROM raw_search WHERE geo=? GROUP BY keyword) f
         ON f.keyword = r.keyword AND f.md = r.snapshot_date
      WHERE r.geo=? ORDER BY r.keyword, r.position`
  ).all(geo, geo);
  if (!serp.length) {
    finishRun(runId, 'niche-doors', geo, { status: 'skipped', notes: 'нет выдачи' });
    return { niches: 0 };
  }

  const brand = new Set(d.prepare(`SELECT keyword FROM disc_keywords WHERE geo=? AND is_brand=1`).all(geo).map((r) => r.keyword));
  const sugScore = new Map(d.prepare(`SELECT keyword, suggest_score, suggest_depth, intent_type, concept FROM disc_keywords WHERE geo=?`).all(geo)
    .map((r) => [r.keyword, r]));

  const byKw = new Map();
  for (const row of serp) {
    // Навигационные (брендовые) ключи в ядро не входят и в door не участвуют.
    if (brand.has(row.keyword)) continue;
    if (!byKw.has(row.keyword)) byKw.set(row.keyword, []);
    byKw.get(row.keyword).push(row);
  }
  const keywords = [...byKw.keys()];
  if (keywords.length < cl.min_cluster_keywords) {
    finishRun(runId, 'niche-doors', geo, { status: 'skipped', notes: 'слишком мало небрендовых ключей' });
    return { niches: 0 };
  }

  // 2. Удаляем вездесущие приложения: без этого несвязанные запросы слипаются через одно популярное.
  // Считается по тому же окну, по которому потом склеиваются ключи, — топ-10.
  // По топ-50 «вездесущим» оказывается почти любое приличное приложение, и из выдачи
  // вычищается ровно то, что нишу и определяет.
  const appFreq = new Map();
  for (const [kw, rows] of byKw) {
    const inTop10 = new Set(rows.filter((r) => r.position <= 10).map((r) => r.app_id));
    for (const a of inTop10) appFreq.set(a, (appFreq.get(a) || 0) + 1);
  }
  const ubiqLimit = Math.max(cl.ubiquitous_min_abs, Math.floor(cl.ubiquitous_pct * keywords.length));
  const ubiquitous = new Set([...appFreq].filter(([, c]) => c > ubiqLimit).map(([a]) => a));

  const top10 = new Map(), top5 = new Map(), top20 = new Map(), top10raw = new Map();
  for (const [kw, rows] of byKw) {
    const sorted = rows.slice().sort((a, b) => a.position - b.position);
    const clean = sorted.filter((r) => !ubiquitous.has(r.app_id));
    // Кластеризация идёт по очищенным спискам, door — по сырому топ-10:
    // удаление вездесущих это приём склейки ключей, а не измерение ширины входа.
    top10raw.set(kw, sorted.slice(0, 10).map((r) => r.app_id));
    top10.set(kw, clean.slice(0, 10).map((r) => r.app_id));
    top5.set(kw, clean.slice(0, 5).map((r) => r.app_id));
    top20.set(kw, clean.slice(0, 20).map((r) => r.app_id));
  }

  // 3. Union-find: >= 4 общих в топ-10 и Jaccard >= 0,25.
  const uf = new UnionFind();
  for (const kw of keywords) uf.find(kw);
  for (let i = 0; i < keywords.length; i++) {
    const a = top10.get(keywords[i]);
    if (!a.length) continue;
    for (let j = i + 1; j < keywords.length; j++) {
      const b = top10.get(keywords[j]);
      if (!b.length) continue;
      const setB = new Set(b);
      let shared = 0;
      for (const x of a) if (setB.has(x)) shared++;
      if (shared >= cl.min_shared_top10 && jaccard(a, b) >= cl.min_jaccard) uf.union(keywords[i], keywords[j]);
    }
  }
  const clusters = uf.groups().filter((c) => c.length >= cl.min_cluster_keywords);

  // Установки по последней известной карточке гео.
  // Строки, где оценок больше, чем установок, — артефакт Play, а не измерение:
  // так выглядят приложения с ограниченным распространением (Google Recorder на Pixel
  // отдаёт «1+ установок» при 15 793 оценках). Оценок не может быть больше установок,
  // поэтому такие строки в door не участвуют — иначе один OEM-эксклюзив обнуляет нишу.
  const installs = new Map(d.prepare(
    `SELECT p.app_id, p.max_installs, p.score, p.ratings_count, p.released, p.updated_ts, p.title, p.summary
       FROM raw_app_page p
       JOIN (SELECT app_id, MAX(snapshot_date) md FROM raw_app_page WHERE geo=? GROUP BY app_id) f
         ON f.app_id=p.app_id AND f.md=p.snapshot_date
      WHERE p.geo=?`
  ).all(geo, geo).map((r) => [r.app_id, r]));

  const implausible = new Set();
  for (const [id, r] of installs) {
    if (r.max_installs != null && r.ratings_count != null && r.ratings_count > r.max_installs) implausible.add(id);
  }
  const installsForDoor = (id) => (implausible.has(id) ? null : installs.get(id)?.max_installs ?? null);

  const p25_score = qv(null, geo, 'score', date, 'p25', { nicheFirst: false });
  const p75_upd = qv(null, geo, 'days_since_update', date, 'p75', { nicheFirst: false });

  // Стабильность id ниши между днями: новая ниша наследует id старой при пересечении ядер >= 0,5.
  const prev = d.prepare(
    `SELECT n.niche_id, n.label_manual, n.name,
            (SELECT GROUP_CONCAT(keyword, char(10)) FROM keyword_cores kc WHERE kc.niche_id=n.niche_id AND kc.geo=n.geo) AS kws
       FROM niches n WHERE n.geo=?`
  ).all(geo).map((r) => ({ ...r, set: new Set((r.kws || '').split('\n').filter(Boolean)) }));

  const insNiche = d.prepare(`INSERT INTO niches (niche_id, geo, name, head_keyword, concept, label_manual, core_version, created_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(niche_id, geo) DO UPDATE SET name=excluded.name, head_keyword=excluded.head_keyword, concept=excluded.concept, core_version=excluded.core_version`);
  const delCore = d.prepare(`DELETE FROM keyword_cores WHERE niche_id=? AND geo=?`);
  const insCore = d.prepare(`INSERT OR REPLACE INTO keyword_cores (niche_id, geo, keyword, intent_type, is_head, active, core_version) VALUES (?,?,?,?,?,1,?)`);
  const insMetric = d.prepare(`INSERT OR REPLACE INTO metrics_niche_geo (
      niche_id, geo, snapshot_date, name, head_keyword, keywords_count, apps_count, door, best_door,
      wall_installs, wall_ratings, demand_installs, weak_share, new_share_18m, leader_share,
      exact_in_title, jaccard_top5_median, relevance_gap_pct, generic_demand_share, suggest_score_sum,
      top10_turnover_30d, index_gap_leader, top_apps, concept,
      top10_turnover_7d, top10_turnover_14d, partial_window)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const upAppNiche = d.prepare(`UPDATE apps SET niche_id=? WHERE app_id=?`);

  const coreVersion = `${date}:${md5(keywords.sort().join('|')).slice(0, 8)}`;
  const usedIds = new Set();
  const doors = [];
  let nicheCount = 0;

  for (const core of clusters) {
    // Головной ключ: больше всего подсказочного веса, при равенстве — самый короткий.
    const head = [...core].sort((a, b) => {
      const sa = sugScore.get(a)?.suggest_score || 0, sb = sugScore.get(b)?.suggest_score || 0;
      return sb - sa || a.length - b.length;
    })[0];

    // Концепт ниши — самый частый среди ключей ядра. Он же связывает нишу между гео.
    const conceptCount = new Map();
    for (const kw of core) {
      const c = sugScore.get(kw)?.concept;
      if (c) conceptCount.set(c, (conceptCount.get(c) || 0) + 1);
    }
    const concept = [...conceptCount].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const coreSet = new Set(core);
    let match = null, bestJ = 0;
    for (const p of prev) {
      if (usedIds.has(p.niche_id)) continue;
      const j = jaccard([...coreSet], [...p.set]);
      if (j > bestJ) { bestJ = j; match = p; }
    }
    const nicheId = bestJ >= 0.5 && match ? match.niche_id : `${geo}-${md5(head).slice(0, 10)}`;
    usedIds.add(nicheId);

    // --- door: медиана по ключам ядра от минимальных установок в топ-10 ---
    const perKwMin = [];
    for (const kw of core) {
      const vals = top10raw.get(kw).map(installsForDoor).filter((v) => v != null);
      if (vals.length >= 3) perKwMin.push(Math.min(...vals));
    }
    const door = perKwMin.length ? Math.round(median(perKwMin)) : null;

    const headTop10 = top10.get(head) || [];
    const headApps = headTop10.map((id) => installs.get(id)).filter(Boolean);
    const wall = headApps.reduce((s, a) => s + (a.max_installs || 0), 0) || null;
    const wallRatings = headApps.reduce((s, a) => s + (a.ratings_count || 0), 0) || null;
    const leader = Math.max(0, ...headApps.map((a) => a.max_installs || 0));
    const leaderShare = wall ? leader / wall : null;

    const allApps = new Set();
    for (const kw of core) for (const id of top20.get(kw)) allApps.add(id);
    const demandInstalls = [...allApps].reduce((s, id) => s + (installs.get(id)?.max_installs || 0), 0) || null;

    const weak = headApps.filter((a) => {
      const daysUpd = a.updated_ts ? (Date.now() - a.updated_ts) / 86400000 : null;
      return (p25_score != null && a.score != null && a.score < p25_score) ||
             (p75_upd != null && daysUpd != null && daysUpd > p75_upd);
    }).length;
    const weakShare = headApps.length ? weak / headApps.length : null;

    const young = headApps.filter((a) => a.released && (Date.now() - Date.parse(a.released)) / 86400000 < 548).length;
    const newShare = headApps.length ? young / headApps.length : null;

    const headToks = tokens(head);
    const exactInTitle = headApps.length
      ? headApps.filter((a) => headToks.every((t) => String(a.title || '').toLowerCase().includes(t))).length / headApps.length
      : null;

    const pairs = [];
    for (let i = 0; i < core.length; i++) for (let j = i + 1; j < core.length; j++) {
      pairs.push(jaccard(top5.get(core[i]), top5.get(core[j])));
    }
    const jac5 = pairs.length ? median(pairs) : null;

    // Прокси плотности выдачи: доля топ-20, где в заголовке/кратком описании нет ни одного токена ядра.
    const coreToks = new Set(core.flatMap(tokens));
    const irrelevant = [...allApps].filter((id) => {
      const a = installs.get(id);
      if (!a) return false;
      const text = `${a.title || ''} ${a.summary || ''}`.toLowerCase();
      return ![...coreToks].some((t) => text.includes(t));
    }).length;
    const relevanceGap = allApps.size ? irrelevant / allApps.size : null;

    const genericShare = core.filter((k) => (sugScore.get(k)?.intent_type || 'generic') === 'generic').length / core.length;
    const sugSum = core.reduce((s, k) => s + (sugScore.get(k)?.suggest_score || 0), 0);

    // index_gap лидера: по скольким ключам ядра лидер вообще в топ-50.
    const leaderId = headApps.length ? headTop10[headApps.findIndex((a) => (a.max_installs || 0) === leader)] : null;
    let indexGapLeader = null;
    if (leaderId) {
      const inTop = core.filter((kw) => (byKw.get(kw) || []).some((r) => r.app_id === leaderId && r.position <= 50)).length;
      indexGapLeader = 1 - inTop / core.length;
    }

    // C3 (дополнение). До 30-го дня считаются окна 7 и 14 дней с явной пометкой в имени.
    // Если снимка ровно на границе окна нет, берётся ближайший более старый и ставится partial_window.
    let partialWindow = 0;
    const turnoverOver = (days) => {
      const target = new Date(Date.parse(date) - days * DAY_MS).toISOString().slice(0, 10);
      const snap = d.prepare(
        `SELECT snapshot_date FROM raw_search WHERE geo=? AND keyword=? AND snapshot_date <= ?
          ORDER BY snapshot_date DESC LIMIT 1`
      ).get(geo, head, target);
      if (!snap) return null;
      const past = d.prepare(
        `SELECT app_id FROM raw_search WHERE geo=? AND keyword=? AND snapshot_date=? AND position<=10
          ORDER BY position`
      ).all(geo, head, snap.snapshot_date).map((r) => r.app_id);
      if (past.length < 5) return null;
      const drift = Math.abs((Date.parse(target) - Date.parse(snap.snapshot_date)) / DAY_MS);
      if (drift > 3) partialWindow = 1;
      return 1 - jaccard(headTop10, past);
    };
    const turnover7 = turnoverOver(7);
    const turnover14 = turnoverOver(14);
    const turnover = turnoverOver(30);

    const bestDoorPrev = d.prepare(`SELECT MIN(door) m FROM metrics_niche_geo WHERE niche_id=? AND geo=? AND door IS NOT NULL`).get(nicheId, geo)?.m;
    const bestDoor = door == null ? bestDoorPrev ?? null : (bestDoorPrev == null ? door : Math.min(bestDoorPrev, door));

    const topAppsJson = JSON.stringify(headTop10.slice(0, 10).map((id) => ({
      app_id: id, title: installs.get(id)?.title || null, installs: installs.get(id)?.max_installs ?? null,
      score: installs.get(id)?.score ?? null,
    })));

    d.transaction(() => {
      insNiche.run(nicheId, geo, match && bestJ >= 0.5 ? match.name || head : head, head, concept, match?.label_manual ?? null, coreVersion, date);
      delCore.run(nicheId, geo);
      for (const kw of core) insCore.run(nicheId, geo, kw, sugScore.get(kw)?.intent_type || 'generic', kw === head ? 1 : 0, coreVersion);
      insMetric.run(nicheId, geo, date, head, head, core.length, allApps.size, door, bestDoor,
        wall, wallRatings, demandInstalls, weakShare, newShare, leaderShare, exactInTitle, jac5,
        relevanceGap, genericShare, sugSum, turnover, indexGapLeader, topAppsJson, concept,
        turnover7, turnover14, partialWindow);
      // Приложение относится к нише, где у него лучшая позиция.
      for (const id of allApps) {
        const cur = d.prepare(`SELECT niche_id FROM apps WHERE app_id=?`).get(id);
        if (!cur?.niche_id) upAppNiche.run(nicheId, id);
      }
    })();

    if (door != null) doors.push(door);
    nicheCount++;
  }

  // Ниша с door выше p90 по гео -> все её приложения уровня C (вход слишком широк = слишком дорог).
  if (doors.length >= 5) {
    const p90 = quantile(doors, 0.9);
    const wide = d.prepare(`SELECT niche_id, door FROM metrics_niche_geo WHERE geo=? AND snapshot_date=? AND door > ?`).all(geo, date, p90);
    for (const w of wide) {
      const apps = d.prepare(`SELECT app_id FROM apps WHERE niche_id=? AND watch_level IN ('A','B')`).all(w.niche_id);
      for (const a of apps) setWatchLevel(a.app_id, 'C', `door ниши ${w.door} выше p90 (${Math.round(p90)})`, date, geo);
      if (apps.length) logEvent('niche_door_above_p90', { date, geo, nicheId: w.niche_id, detail: `door=${w.door}, p90=${Math.round(p90)}` });
    }
  }

  finishRun(runId, 'niche-doors', geo, {
    notes: `${nicheCount} ниш из ${keywords.length} ключей, вездесущих отброшено ${ubiquitous.size} (лимит ${ubiqLimit}), из door исключено ${implausible.size} строк с оценок > установок`,
  });
  log(`  ${geo}: ниш ${nicheCount}, ключей ${keywords.length}, вездесущих отброшено ${ubiquitous.size}, из door исключено ${implausible.size} артефактов`);
  return { niches: nicheCount, keywords: keywords.length, ubiquitous: ubiquitous.size };
}
