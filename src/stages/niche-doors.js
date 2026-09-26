// D8 (этап 3) + door. Кластеризация ключей в ниши и расчёт метрик ниши.
// Критично: берётся САМАЯ СВЕЖАЯ выдача по каждому ключу, а не сегодняшний срез —
// иначе ниши строятся из случайной дневной горсти ключей и не сопоставимы между днями (ТЗ 8, риск 3).
import { db, startRun, finishRun, logEvent } from '../lib/db.js';
import { config, geoConf } from '../lib/config.js';
import { qv } from './quantiles.js';
import { setWatchLevel } from '../lib/registry.js';
import { UnionFind, jaccard, median, md5, quantile, log } from '../lib/util.js';
import { ageMonthsAt } from '../lib/dates.js';

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
  const sugScore = new Map(d.prepare(`SELECT keyword, suggest_score, suggest_depth, intent_type, concept, source FROM disc_keywords WHERE geo=?`).all(geo)
    .map((r) => [r.keyword, { ...r }]));

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

  // 2б. Концепт подсказки проверяется выдачей. Подсказки собираются по началу семени, и на
  // короткое начало Play подсказывает всё подряд: «control de gastos» → «control remoto
  // universal», «dokumente scannen» → «dokkan battle». Такая подсказка наследовала концепт
  // семени, уходила в нишу концепта, и к «учёту расходов» привязывались пульты для ТВ
  // (22.09: 2 595 из 5 325 подсказок, 2 291 из них в активных ядрах). Концепт остаётся, только
  // если в топ-20 подсказки есть не меньше concept_min_shared_top20 приложений из топ-20
  // семян того же концепта в этом гео. Иначе ключ без концепта: в ниши он попадает лишь по
  // своей выдаче. Семена не проверяются; без выдачи семени судить не о чем — концепт остаётся.
  // Выдача семени берётся и тогда, когда семя помечено брендом («document scanner» в US,
  // «angle meter» в GB — на первом месте одноимённое приложение): в кластеры такой ключ не идёт,
  // но его выдача тематична. Без этого у концепта не было выдачи для сверки, проверка
  // пропускалась, и в нишу «транспортир» попадали «angry birds» и «anglian water».
  const seedRows = new Map();
  for (const row of serp) {
    const s = sugScore.get(row.keyword);
    if (!s || s.source !== 'seed' || !s.concept) continue;
    if (!seedRows.has(row.keyword)) seedRows.set(row.keyword, []);
    seedRows.get(row.keyword).push(row);
  }
  const seedApps = new Map();
  for (const [kw, rows] of seedRows) {
    const c = sugScore.get(kw).concept;
    if (!seedApps.has(c)) seedApps.set(c, new Set());
    rows.slice().sort((a, b) => a.position - b.position).filter((r) => !ubiquitous.has(r.app_id))
      .slice(0, 20).forEach((r) => seedApps.get(c).add(r.app_id));
  }
  const minShared = cl.concept_min_shared_top20 ?? 2;
  const conceptCheck = { kept: 0, dropped: 0 };
  const upConcept = d.prepare(`UPDATE disc_keywords SET concept_ok=? WHERE geo=? AND keyword=?`);
  d.transaction(() => {
    for (const kw of keywords) {
      const s = sugScore.get(kw);
      if (!s || !s.concept || s.source === 'seed') continue;
      const pool = seedApps.get(s.concept);
      if (!pool || !pool.size) continue;
      const shared = (top20.get(kw) || []).filter((a) => pool.has(a)).length;
      const ok = shared >= minShared ? 1 : 0;
      upConcept.run(ok, geo, kw);
      s.concept_ok = ok;
      if (ok) conceptCheck.kept++;
      else { conceptCheck.dropped++; s.concept_failed = s.concept; s.concept = null; }
    }
  })();

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
  let clusters = uf.groups().filter((c) => c.length >= cl.min_cluster_keywords);

  // Чистка кластеров. Склейка по выдаче иногда сводит в один кластер разные темы: «пульт для
  // телевизора» попадает к «учёту расходов», потому что в топ-10 обоих стоят одни и те же
  // универсальные приложения. Из кластера с преобладающим концептом убираются ключи, которые
  // сверку с семенем этой темы не прошли, и ключи с другим подтверждённым концептом — вторые
  // уходят в кластер своей темы. Ключ без концепта остаётся: он попал сюда по общим
  // приложениям топ-10, а не по чужой подписи. Снятый ключ не может вернуться в тот же
  // кластер остатком (banned) — иначе чистка отменяла бы сама себя.
  const purge = { moved: 0, released: 0, clusters: 0 };
  const banned = new Map();
  if (cl.purify_clusters !== false) {
    const conceptOfKw = (k) => sugScore.get(k)?.concept || null;
    const mainConcept = (core) => {
      const cnt = new Map();
      for (const k of core) { const c = conceptOfKw(k); if (c) cnt.set(c, (cnt.get(c) || 0) + 1); }
      return [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    };
    const conceptOfCluster = clusters.map(mainConcept);
    // Дом для снятого ключа со своим концептом: кластер, где этого концепта больше всего.
    const homeOf = new Map();
    conceptOfCluster.forEach((c, i) => {
      if (!c) return;
      const n = clusters[i].filter((k) => conceptOfKw(k) === c).length;
      const best = homeOf.get(c);
      if (!best || n > best.n) homeOf.set(c, { i, n });
    });
    const moves = [];
    const kept = clusters.map((core, i) => {
      const c = conceptOfCluster[i];
      if (!c) return core;
      const keep = [], drop = [];
      for (const kw of core) {
        const s = sugScore.get(kw);
        if (!s) { keep.push(kw); continue; }
        if (s.concept === c) { keep.push(kw); continue; }        // семя темы или подтверждённый ключ
        if (s.concept_failed === c || s.concept) drop.push(kw);  // не прошёл сверку с темой / чужая тема
        else keep.push(kw);                                      // ключ без концепта — по выдаче
      }
      // Ядро не разбираем целиком: если после чистки кластер перестаёт быть нишей, оставляем как был.
      if (!drop.length || keep.length < cl.min_cluster_keywords) return core;
      purge.clusters++;
      for (const kw of drop) {
        if (!banned.has(kw)) banned.set(kw, new Set());
        banned.get(kw).add(i);
        const home = homeOf.get(conceptOfKw(kw));
        if (home && home.i !== i) { moves.push([home.i, kw]); purge.moved++; }
        else purge.released++;
      }
      return keep;
    });
    clusters = kept;
    for (const [i, kw] of moves) clusters[i].push(kw);
    if (purge.clusters) log(`  чистка ниш: ${purge.clusters} ядер, снято ${purge.moved + purge.released} ключей (в свою тему ${purge.moved}, в остаток ${purge.released})`);
  }

  // Остаток. Порог «от min_cluster_keywords ключей» оставлял в нишах только то, что склеилось
  // по выдаче: в US это 19 из 69 ниш каталога, остальные ключи молча выпадали. Ключ не
  // выбрасывается:
  //  - с концептом — присоединяется к кластеру, где ключей этого концепта больше всего,
  //    а если такого кластера нет, все оставшиеся ключи концепта образуют нишу концепта;
  //  - без концепта (подсказки по префиксу вроде «duplo world») — только к кластеру, с которым
  //    делит не меньше leftover_min_shared_top10 приложений топ-10. Иначе он остаётся вне
  //    ниш: из случайной подсказки получается шум, а не ниша.
  // Склейка по выдаче не меняется: кластеры остаются как были, к ним только добавляется остаток.
  const leftover = { to_cluster: 0, concept_niches: 0, by_serp: 0, dropped: 0 };
  if (cl.leftover_to_concept) {
    const inCluster = new Set(clusters.flat());
    const conceptOf = (k) => sugScore.get(k)?.concept || null;
    const clusterOfConcept = new Map();
    clusters.forEach((core, i) => {
      const cnt = new Map();
      for (const k of core) { const c = conceptOf(k); if (c) cnt.set(c, (cnt.get(c) || 0) + 1); }
      for (const [c, n] of cnt) {
        const best = clusterOfConcept.get(c);
        if (!best || n > best.n) clusterOfConcept.set(c, { i, n });
      }
    });
    const clusterApps = clusters.map((core) => new Set(core.flatMap((k) => top10.get(k) || [])));
    const conceptNiches = new Map();
    for (const kw of keywords) {
      if (inCluster.has(kw)) continue;
      const c = conceptOf(kw);
      if (c) {
        const best = clusterOfConcept.get(c);
        if (best) { clusters[best.i].push(kw); leftover.to_cluster++; }
        else {
          if (!conceptNiches.has(c)) conceptNiches.set(c, []);
          conceptNiches.get(c).push(kw);
        }
        continue;
      }
      let bestI = -1, bestShared = 0;
      const mine = top10.get(kw) || [];
      const ban = banned.get(kw);
      clusterApps.forEach((apps, i) => {
        if (ban && ban.has(i)) return;
        let shared = 0;
        for (const a of mine) if (apps.has(a)) shared++;
        if (shared > bestShared) { bestShared = shared; bestI = i; }
      });
      if (bestI >= 0 && bestShared >= cl.leftover_min_shared_top10) { clusters[bestI].push(kw); leftover.by_serp++; }
      else leftover.dropped++;
    }
    for (const core of conceptNiches.values()) clusters.push(core);
    leftover.concept_niches = conceptNiches.size;
  }

  // Установки по последней известной карточке гео.
  // Строки, где оценок больше, чем установок, — артефакт Play, а не измерение:
  // так выглядят приложения с ограниченным распространением (Google Recorder на Pixel
  // отдаёт «1+ установок» при 15 793 оценках). Оценок не может быть больше установок,
  // поэтому такие строки в door не участвуют — иначе один OEM-эксклюзив обнуляет нишу.
  const installs = new Map(d.prepare(
    `SELECT p.app_id, p.max_installs, p.score, p.ratings_count, p.released, p.hl, p.updated_ts, p.title, p.summary
       FROM raw_app_page p
       JOIN (SELECT app_id, MAX(snapshot_date) md FROM raw_app_page WHERE geo=? GROUP BY app_id) f
         ON f.app_id=p.app_id AND f.md=p.snapshot_date
      WHERE p.geo=?`
  ).all(geo, geo).map((r) => [r.app_id, { ...r, local: 1 }]));
  // Карточка того же приложения в другом гео — для чисел, общих для Play (установки, оценки,
  // рейтинг, дата релиза, обновление). Без неё door был пуст у половины ниш: в топ-10 ядра
  // много приложений, чья карточка снята только там, где их нашли впервые. Текстовые метрики
  // (ключ в заголовке, релевантность) по-прежнему только по карточке своего гео — заголовок
  // локализован.
  // Только для приложений выдачи этого гео без своей карточки: выбор последней карточки по всей
  // таблице с чтением полных строк после добора карточек шёл минутами.
  const anyCard = new Map();
  const needAny = new Set();
  for (const rows of byKw.values()) for (const r of rows) if (!installs.has(r.app_id)) needAny.add(r.app_id);
  if (needAny.size) {
    for (const r of d.prepare(
      `SELECT p.app_id, p.max_installs, p.score, p.ratings_count, p.released, p.hl, p.updated_ts, p.title, p.summary
         FROM raw_app_page p
        WHERE p.app_id IN (SELECT value FROM json_each(?))
          AND p.snapshot_date=(SELECT MAX(x.snapshot_date) FROM raw_app_page x WHERE x.app_id=p.app_id)`
    ).all(JSON.stringify([...needAny]))) {
      if (!anyCard.has(r.app_id)) anyCard.set(r.app_id, { ...r, local: 0 });
    }
  }
  const cardOf = (id) => installs.get(id) || anyCard.get(id);

  const implausible = new Set();
  for (const m of [installs, anyCard]) {
    for (const [id, r] of m) {
      if (r.max_installs != null && r.ratings_count != null && r.ratings_count > r.max_installs) implausible.add(id);
    }
  }
  const installsForDoor = (id) => (implausible.has(id) ? null : cardOf(id)?.max_installs ?? null);

  // ---------- door-flow: цена входа в потоке, а не в запасе ----------
  // Нынешняя дверь — это установки слабейшего в топ-10 за всё время жизни. Но приложение
  // пятилетней давности с 500 тыс. установок и трёхмесячное со 100 тыс. — совершенно разные
  // соперники: у первого может быть 100 установок в день, у второго 3 000. Запас говорит,
  // сколько накоплено, поток — сколько приходится отбивать сейчас.
  //
  // Поток считается по числу оценок: счётчик установок Play обновляет пачками раз в 3–6 дней,
  // а оценки меняются каждый день. Прирост оценок за окно переводится в установки через
  // «установок на оценку» у самого приложения. Это оценка, а не измерение.
  const flowOf = (() => {
    const hist = new Map();
    for (const r of d.prepare(
      `SELECT app_id, snapshot_date, MAX(max_installs) inst, MAX(ratings_count) rc FROM raw_app_page
        WHERE geo=? AND ratings_count IS NOT NULL AND max_installs IS NOT NULL
        GROUP BY app_id, snapshot_date ORDER BY app_id, snapshot_date`
    ).all(geo)) {
      if (!hist.has(r.app_id)) hist.set(r.app_id, []);
      hist.get(r.app_id).push(r);
    }
    const cache = new Map();
    return (id) => {
      if (cache.has(id)) return cache.get(id);
      const s = hist.get(id);
      let out = null;
      if (s && s.length >= 2) {
        const a = s[0], b = s[s.length - 1];
        const days = Math.round((Date.parse(b.snapshot_date) - Date.parse(a.snapshot_date)) / 864e5);
        const dRatings = b.rc - a.rc;
        if (days > 0 && dRatings >= 0 && b.rc > 0) {
          const ipr = b.inst / b.rc;
          out = Math.round((dRatings * ipr) / days);   // установок в день
        }
      }
      cache.set(id, out);
      return out;
    };
  })();

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
      top10_turnover_7d, top10_turnover_14d, partial_window, door_flow, door5, door_flow5, door3, door_flow3)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const upAppNiche = d.prepare(`UPDATE apps SET niche_id=? WHERE app_id=?`);

  const coreVersion = `${date}:${md5(keywords.sort().join('|')).slice(0, 8)}`;
  const usedIds = new Set();
  const doors = [];
  let nicheCount = 0;

  // Метрики ниш за этот день пересчитываются целиком. Без очистки при смене состава ниш
  // (новый порог, остаток по концептам) рядом с новыми нишами оставались бы строки ниш,
  // которых в этом дне уже нет, и отчёты показывали бы их дважды. Это производная таблица —
  // сырьё (выдача, карточки) не трогается.
  d.prepare(`DELETE FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`).run(geo, date);

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
    // Подпись ставится, только если концепт подтверждает не меньше трети ключей ядра. Иначе
    // одна случайная подсказка давала нише чужое имя: в отчёте стояло «учёт расходов» там,
    // где ядро про другое. Ниша без подписи показывается по головному ключу.
    const topConcept = [...conceptCount].sort((a, b) => b[1] - a[1])[0];
    const concept = topConcept && topConcept[1] / Math.max(1, core.length) >= (cl.concept_min_label_share ?? 0.34)
      ? topConcept[0] : null;

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
    //
    // Рядом считается дверь в топ-5 — по первой половине той же выдачи. Разница между ними
    // и есть цена верхних мест: по кривой CTR места 1–5 забирают вчетверо больше, чем 6–10,
    // поэтому «войти в десятку» и «войти в пятёрку» — два разных решения с разным бюджетом.
    // Порог знания тот же по сути: не меньше трёх приложений с известными установками, но
    // из пяти строк, а не из десяти, — то есть требование строже, и по редким ключам дверь
    // в топ-5 останется пустой там, где обычная посчиталась.
    const perKwMin = [], perKwFlow = [], perKwMin5 = [], perKwFlow5 = [], perKwMin3 = [], perKwFlow3 = [];
    for (const kw of core) {
      const raw = top10raw.get(kw);
      const raw5 = raw.slice(0, 5);
      const raw3 = raw.slice(0, 3);
      const vals = raw.map(installsForDoor).filter((v) => v != null);
      if (vals.length >= 3) perKwMin.push(Math.min(...vals));
      const vals5 = raw5.map(installsForDoor).filter((v) => v != null);
      if (vals5.length >= 3) perKwMin5.push(Math.min(...vals5));
      // Порог здесь два из трёх, а не три из трёх: та же доля, что у пятёрки, иначе по
      // редким ключам дверь в тройку пустовала бы там, где обе остальные посчитались.
      const vals3 = raw3.map(installsForDoor).filter((v) => v != null);
      if (vals3.length >= 2) perKwMin3.push(Math.min(...vals3));
      // Тот же расчёт, но в потоке: сколько установок в день у самого слабого из топ-10.
      const flows = raw.map(flowOf).filter((v) => v != null);
      if (flows.length >= 3) perKwFlow.push(Math.min(...flows));
      const flows5 = raw5.map(flowOf).filter((v) => v != null);
      if (flows5.length >= 3) perKwFlow5.push(Math.min(...flows5));
      const flows3 = raw3.map(flowOf).filter((v) => v != null);
      if (flows3.length >= 2) perKwFlow3.push(Math.min(...flows3));
    }
    const doorFlow = perKwFlow.length ? Math.round(median(perKwFlow)) : null;
    const door = perKwMin.length ? Math.round(median(perKwMin)) : null;
    const doorFlow5 = perKwFlow5.length ? Math.round(median(perKwFlow5)) : null;
    const door5 = perKwMin5.length ? Math.round(median(perKwMin5)) : null;
    const doorFlow3 = perKwFlow3.length ? Math.round(median(perKwFlow3)) : null;
    const door3 = perKwMin3.length ? Math.round(median(perKwMin3)) : null;

    const headTop10 = top10.get(head) || [];
    const headApps = headTop10.map((id) => cardOf(id)).filter(Boolean);
    const wall = headApps.reduce((s, a) => s + (a.max_installs || 0), 0) || null;
    const wallRatings = headApps.reduce((s, a) => s + (a.ratings_count || 0), 0) || null;
    const leader = Math.max(0, ...headApps.map((a) => a.max_installs || 0));
    const leaderShare = wall ? leader / wall : null;

    const allApps = new Set();
    for (const kw of core) for (const id of top20.get(kw)) allApps.add(id);
    const demandInstalls = [...allApps].reduce((s, id) => s + (cardOf(id)?.max_installs || 0), 0) || null;

    const weak = headApps.filter((a) => {
      const daysUpd = a.updated_ts ? (Date.now() - a.updated_ts) / 86400000 : null;
      return (p25_score != null && a.score != null && a.score < p25_score) ||
             (p75_upd != null && daysUpd != null && daysUpd > p75_upd);
    }).length;
    const weakShare = headApps.length ? weak / headApps.length : null;

    const young = headApps.filter((a) => { const m = ageMonthsAt(a.released, a.hl, date); return m != null && m < 18; }).length;
    const newShare = headApps.length ? young / headApps.length : null;

    const headToks = tokens(head);
    const headLocal = headApps.filter((a) => a.local);
    const exactInTitle = headLocal.length
      ? headLocal.filter((a) => headToks.every((t) => String(a.title || '').toLowerCase().includes(t))).length / headLocal.length
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
      app_id: id, title: cardOf(id)?.title || null, installs: cardOf(id)?.max_installs ?? null,
      score: cardOf(id)?.score ?? null,
    })));

    d.transaction(() => {
      insNiche.run(nicheId, geo, match && bestJ >= 0.5 ? match.name || head : head, head, concept, match?.label_manual ?? null, coreVersion, date);
      delCore.run(nicheId, geo);
      for (const kw of core) insCore.run(nicheId, geo, kw, sugScore.get(kw)?.intent_type || 'generic', kw === head ? 1 : 0, coreVersion);
      insMetric.run(nicheId, geo, date, head, head, core.length, allApps.size, door, bestDoor,
        wall, wallRatings, demandInstalls, weakShare, newShare, leaderShare, exactInTitle, jac5,
        relevanceGap, genericShare, sugSum, turnover, indexGapLeader, topAppsJson, concept,
        turnover7, turnover14, partialWindow, doorFlow, door5, doorFlow5, door3, doorFlow3);
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

  const leftoverNote = cl.leftover_to_concept
    ? `; концепт подсказок: подтверждён ${conceptCheck.kept}, снят ${conceptCheck.dropped}; остаток: в кластеры своего концепта ${leftover.to_cluster}, ниш концептов ${leftover.concept_niches}, по выдаче ${leftover.by_serp}, вне ниш ${leftover.dropped}`
    : '';
  finishRun(runId, 'niche-doors', geo, {
    notes: `${nicheCount} ниш из ${keywords.length} ключей, вездесущих отброшено ${ubiquitous.size} (лимит ${ubiqLimit}), из door исключено ${implausible.size} строк с оценок > установок${leftoverNote}`,
  });
  log(`  ${geo}: ниш ${nicheCount}, ключей ${keywords.length}, вездесущих отброшено ${ubiquitous.size}, из door исключено ${implausible.size} артефактов${leftoverNote}`);
  return { niches: nicheCount, keywords: keywords.length, ubiquitous: ubiquitous.size, leftover };
}
