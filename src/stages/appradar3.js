// AppRadar 3 — отчёт «стоит ли это повторять», ТЗ docs/tz-appradar-3.md.
//
// Отличие от AppRadar 2 в вопросе, а не в оформлении. AppRadar 2 отвечает «что сейчас
// выглядит интересно» и сводит всё в один индекс копируемости. AppRadar 3 отвечает «стоит
// ли это повторять» и намеренно НЕ сводит: рынок, органика, импульс, риск, повторяемость и
// слабость инкумбента показываются рядом, каждый со своим основанием.
//
// Чего здесь нет и почему. Нет вероятностей и прогноза на 30/60/90 дней: у нас 13–16 дней
// истории и ноль приложений с тридцатидневной меткой, поэтому любая «вероятность 71 %»
// была бы оформлением догадки. Появится после первого backtest — не раньше 07.10 для
// месячного горизонта. До тех пор отчёт показывает измеренное и честно помечает неизвестное.
//
// Стадия ничего не пишет в базу и не трогает конвейер: все производные признаки (риск
// ложного срабатывания, повторяемость ниши, слабость инкумбента, диффузия по гео) считаются
// здесь же из готовых метрик.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from '../lib/db.js';
import { config } from '../lib/config.js';
import { log } from '../lib/util.js';
import { packRows, UNPACK_JS } from '../lib/pack.js';

const one = (d, sql, ...p) => d.prepare(sql).get(...p);
const all = (d, sql, ...p) => d.prepare(sql).all(...p);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Number(Number(v).toPrecision(4)));
const ROWS_PER_GEO = Number(process.env.RADAR3_ROWS || 150);

// Риск принять чужой рост за свой шанс. Каждый фактор — отдельная причина не верить строке;
// они не складываются в вероятность, а перечисляются, чтобы было видно, чего именно не хватает.
function riskFactors(r) {
  const f = [];
  if (!(r.w >= 14)) f.push('окно наблюдения короче двух недель');
  if (r.stale != null && r.stale >= 7) f.push('счётчик установок не обновлялся ' + r.stale + ' дн.');
  if (r.scope !== 'domain+name') f.push(r.scope ? 'реклама проверена только ' + (r.scope === 'domain' ? 'по домену' : 'по имени') : 'реклама не проверена');
  if (r.ocov != null && r.ocov < 0.6) f.push('покрытие улик ниже 60 %');
  if (r.age != null && r.age < 3) f.push('приложению меньше трёх месяцев');
  if (r.reviews != null && r.reviews < 20) f.push('меньше 20 отзывов');
  if ((r.kw50 ?? 0) < 3) f.push('меньше трёх ключей в топ-50');
  if (r.flags) f.push('сигналы антифрода: ' + r.flags);
  return f;
}

export async function run({ geo, date }) {
  const d = db();
  const cfg = { geos: config().geos, scoring: config().scoring };
  const geos = [];
  const rows = [];
  const niches = [];
  const rejected = [];

  for (const g of cfg.geos.geos) {
    const dt = one(d, `SELECT MAX(snapshot_date) m FROM metrics_app_v2 WHERE geo=?`, g.geo)?.m;
    if (!dt) { geos.push({ geo: g.geo, tier: g.tier, date: null, rows: 0 }); continue; }

    // Повторяемость темы: сколько независимых разработчиков уже сделали похожее приложение.
    // Сейчас воронка отбрасывает такие кучи как «фабрику клонов», но разбор от 23.09 прав —
    // несколько независимых команд в одной теме означают, что концепция уже доказала
    // повторяемость. Фабрика — это когда один разработчик наплодил двадцать штук; это
    // различается по числу РАЗНЫХ developer_id, а не по числу приложений.
    const repl = new Map();
    for (const r of all(d,
      `SELECT v.niche_id, a.developer_id, COUNT(*) apps, MAX(v.installs) installs, MIN(v.age_months) age
         FROM metrics_app_v2 v JOIN apps a ON a.app_id=v.app_id
        WHERE v.geo=? AND v.snapshot_date=? AND v.niche_id IS NOT NULL AND a.developer_id IS NOT NULL
        GROUP BY v.niche_id, a.developer_id`, g.geo, dt)) {
      const cur = repl.get(r.niche_id) || { devs: 0, young: 0, big: 0 };
      cur.devs++;
      if (r.age != null && r.age < 12) cur.young++;
      if (r.installs != null && r.installs >= 1e5) cur.big++;
      repl.set(r.niche_id, cur);
    }

    // Слабость инкумбента: рейтинг топ-3 ниши и доля жалоб у них. Низкий рейтинг лидера при
    // живом спросе — это не «плохая ниша», а доказанный спрос со слабым соперником.
    const weak = new Map();
    for (const r of all(d,
      `SELECT v.niche_id, AVG(p.score) rating, AVG(m.pain_money) money, AVG(m.pain_ads) ads,
              AVG(m.pain_broken) broken, AVG(m.pain_missing) missing, COUNT(*) n
         FROM metrics_app_v2 v
         JOIN metrics_app_geo m ON m.app_id=v.app_id AND m.geo=v.geo AND m.snapshot_date=v.snapshot_date
         LEFT JOIN (SELECT app_id, geo, MAX(snapshot_date) md, score FROM raw_app_page GROUP BY app_id, geo) p
           ON p.app_id=v.app_id AND p.geo=v.geo
        WHERE v.geo=? AND v.snapshot_date=? AND v.niche_id IS NOT NULL AND v.installs >= 100000
        GROUP BY v.niche_id`, g.geo, dt)) {
      weak.set(r.niche_id, r);
    }

    const cand = all(d,
      `SELECT v.app_id, v.niche_id, v.installs, v.age_months age, v.young, v.organic_level lvl,
              v.organic_score oscore, v.evidence_coverage ocov, v.ads_check_scope scope,
              v.installs_delta_30d off_delta, v.delta_window_days off_w,
              v.delta_preview prev, v.delta_preview_w prev_w, v.delta_flat flat,
              v.installs_stale_days stale, v.installs_est_ratings est,
              v.kw_top10_cmp k10, v.kw_top50_cmp k50, v.kw_top10_prev k10p, v.kw_top50_prev k50p,
              v.kw_momentum_days kwd, v.ubt_signal ubt, v.passed, v.failed,
              a.title, a.developer, a.developer_id,
              m.ratings_count reviews, m.fraud_ok, m.burst_flag, m.permissions_risky perm,
              m.policy_risk_category polrisk, m.pain_dominant pain,
              n.concept, n.head_keyword head, n.door, n.door_flow, n.freedom_pct freedom,
              n.organic_purity purity, n.free_keys_count free_keys, n.time_to_organic tto,
              COALESCE(n.quadrant_smooth, n.quadrant) quad, n.quadrant_days qdays, n.quadrant_seen qseen,
              n.freedom_margin fmargin, n.young_organic_count nyoung, n.closed_flag closed
         FROM metrics_app_v2 v
         JOIN apps a ON a.app_id=v.app_id
         JOIN metrics_app_geo m ON m.app_id=v.app_id AND m.geo=v.geo AND m.snapshot_date=v.snapshot_date
         LEFT JOIN metrics_niche_v2 n ON n.niche_id=v.niche_id AND n.geo=v.geo AND n.snapshot_date=v.snapshot_date
        WHERE v.geo=? AND v.snapshot_date=? AND v.passed_funnel=1 AND v.organic_level<>'found'`,
      g.geo, dt);

    const geoRows = [];
    for (const c of cand) {
      const official = c.off_delta != null;
      const w = official ? c.off_w : c.prev_w;
      const interp = official ? c.off_delta : c.prev;
      const flags = (c.fraud_ok === 0 ? 1 : 0) + (c.burst_flag === 1 ? 1 : 0);
      const rr = repl.get(c.niche_id) || null;
      const ww = weak.get(c.niche_id) || null;
      const row = {
        geo: g.geo, app_id: c.app_id, title: c.title, dev: c.developer,
        concept: c.concept, head: c.head, installs: c.installs, age: r4(c.age), young: c.young,
        // рынок
        door: c.door, door_flow: c.door_flow, freedom: r4(c.freedom), purity: r4(c.purity),
        free_keys: c.free_keys, tto: r4(c.tto), quad: c.quad, qdays: c.qdays, qseen: c.qseen,
        fmargin: r4(c.fmargin), nyoung: c.nyoung, closed: c.closed,
        // органика
        lvl: c.lvl, oscore: r4(c.oscore), ocov: r4(c.ocov), scope: c.scope, ubt: c.ubt === 1 ? 1 : 0,
        // импульс
        k10: c.k10, k50: c.k50, k10p: c.k10p, k50p: c.k50p, kwd: c.kwd,
        interp: r4(interp), est: r4(c.est), flat: c.flat === 1 ? 1 : 0, w, official: official ? 1 : 0, stale: c.stale,
        // повторяемость и соперник
        devs: rr ? rr.devs : null, devs_young: rr ? rr.young : null, devs_big: rr ? rr.big : null,
        inc_rating: r4(ww?.rating ?? null), inc_pain_money: r4(ww?.money ?? null),
        inc_pain_ads: r4(ww?.ads ?? null), inc_pain_broken: r4(ww?.broken ?? null),
        inc_pain_missing: r4(ww?.missing ?? null), inc_n: ww?.n ?? null,
        // стоимость входа
        perm: c.perm, polrisk: c.polrisk, checks_ok: c.passed, checks_bad: c.failed,
        reviews: c.reviews, pain: c.pain, flags,
      };
      row.risk = riskFactors(row);
      row.risk_n = row.risk.length;
      geoRows.push(row);
    }
    // Порядок: сперва то, что меньше всего похоже на самообман, затем по импульсу ключей.
    geoRows.sort((a, b) => a.risk_n - b.risk_n
      || ((b.k50 - b.k50p) || 0) - ((a.k50 - a.k50p) || 0)
      || (b.oscore || 0) - (a.oscore || 0));
    rows.push(...geoRows.slice(0, ROWS_PER_GEO));

    // Отсеянные воронкой, но говорящие. Разбор от 23.09 прав: три причины отсева выбрасывают
    // ровно то, что означает «спрос доказан, соперник слабый».
    //   broken  — низкий рейтинг при заметном числе оценок. Это не «плохое приложение», а
    //             недовольный спрос: люди ставят, пользуются и жалуются.
    //   factory — фабрика клонов. Но много РАЗНЫХ разработчиков в одной теме означает, что
    //             концепция уже доказала повторяемость, а не что она мусорная.
    //   too_big — инкумбент. Копировать его нечем, но он показывает масштаб спроса и служит
    //             якорем: вокруг него ищутся слабые конкуренты под конкретные сценарии.
    // Воронку при этом не трогаем: AppRadar 2 продолжает считать по-старому, чтобы его
    // цифры не поехали. Здесь отсеянные показываются отдельно, с причиной как признаком.
    // Причина «фабрика клонов» в вердиктах называется regional_clone; «заброшенное» (dead) —
    // это приложение с заметными установками, которое давно не обновляли: самый прямой
    // признак слабого соперника, какой есть.
    const REJECTED_KINDS = ['broken', 'regional_clone', 'too_big', 'dead'];
    for (const c of all(d,
      `SELECT v.app_id, v.niche_id, v.installs, v.age_months age, v.organic_level lvl,
              v.organic_score oscore, v.evidence_coverage ocov,
              v.kw_top50_cmp k50, v.kw_top50_prev k50p, v.installs_est_ratings est, v.delta_preview prev,
              a.title, a.developer, s.reject_reason reason,
              m.ratings_count reviews, m.pain_broken, m.pain_missing, m.pain_ads, m.pain_dominant pain,
              p.score rating,
              n.concept, n.head_keyword head, n.door, n.door_flow, n.freedom_pct freedom, n.organic_purity purity
         FROM metrics_app_v2 v
         JOIN apps a ON a.app_id=v.app_id
         JOIN screen_result s ON s.app_id=v.app_id AND s.geo=v.geo
           AND s.snapshot_date=(SELECT MAX(snapshot_date) FROM screen_result WHERE geo=v.geo)
         JOIN metrics_app_geo m ON m.app_id=v.app_id AND m.geo=v.geo AND m.snapshot_date=v.snapshot_date
         LEFT JOIN (SELECT app_id, geo, MAX(snapshot_date) md, score FROM raw_app_page GROUP BY app_id, geo) p
           ON p.app_id=v.app_id AND p.geo=v.geo
         LEFT JOIN metrics_niche_v2 n ON n.niche_id=v.niche_id AND n.geo=v.geo AND n.snapshot_date=v.snapshot_date
        WHERE v.geo=? AND v.snapshot_date=? AND v.passed_funnel=0
          AND s.reject_reason IN (${REJECTED_KINDS.map(() => '?').join(',')})`,
      g.geo, dt, ...REJECTED_KINDS)) {
      const rr = repl.get(c.niche_id) || null;
      rejected.push({
        geo: g.geo, app_id: c.app_id, title: c.title, dev: c.developer, reason: c.reason,
        concept: c.concept, head: c.head, installs: c.installs, age: r4(c.age),
        rating: r4(c.rating), reviews: c.reviews, pain: c.pain,
        pain_broken: r4(c.pain_broken), pain_missing: r4(c.pain_missing), pain_ads: r4(c.pain_ads),
        door: c.door, door_flow: c.door_flow, freedom: r4(c.freedom), purity: r4(c.purity),
        k50: c.k50, k50p: c.k50p, est: r4(c.est), prev: r4(c.prev),
        lvl: c.lvl, oscore: r4(c.oscore), ocov: r4(c.ocov),
        devs: rr ? rr.devs : null, devs_young: rr ? rr.young : null, devs_big: rr ? rr.big : null,
      });
    }

    for (const n of all(d,
      `SELECT niche_id, concept, head_keyword head, door, door_flow, freedom_pct freedom, organic_purity purity,
              free_keys_count free_keys, COALESCE(quadrant_smooth, quadrant) quad, quadrant_days qdays,
              quadrant_seen qseen, freedom_margin fmargin, young_organic_count nyoung, time_to_organic tto,
              closed_flag closed, organic_capacity cap
         FROM metrics_niche_v2 WHERE geo=? AND snapshot_date=?`, g.geo, dt)) {
      const rr = repl.get(n.niche_id) || null;
      const ww = weak.get(n.niche_id) || null;
      niches.push({
        geo: g.geo, niche_id: n.niche_id, concept: n.concept, head: n.head,
        door: n.door, door_flow: n.door_flow, freedom: r4(n.freedom), purity: r4(n.purity),
        free_keys: n.free_keys, quad: n.quad, qdays: n.qdays, qseen: n.qseen, fmargin: r4(n.fmargin),
        nyoung: n.nyoung, tto: r4(n.tto), closed: n.closed, cap: r4(n.cap),
        devs: rr ? rr.devs : null, devs_young: rr ? rr.young : null, devs_big: rr ? rr.big : null,
        inc_rating: r4(ww?.rating ?? null), inc_pain_broken: r4(ww?.broken ?? null), inc_pain_missing: r4(ww?.missing ?? null),
      });
    }
    geos.push({ geo: g.geo, tier: g.tier, date: dt, rows: geoRows.length, shown: Math.min(geoRows.length, ROWS_PER_GEO) });
  }

  const hist = one(d, `SELECT MIN(snapshot_date) lo, MAX(snapshot_date) hi, COUNT(DISTINCT snapshot_date) n FROM raw_app_page`);
  const data = {
    meta: {
      generated_at: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      date, rows_per_geo: ROWS_PER_GEO,
      history: { from: hist.lo, to: hist.hi, days: hist.n },
      // Сколько ждать до первых меток: 30 дней от начала наблюдений.
      labels30: new Date(Date.parse(hist.lo) + 30 * 864e5).toISOString().slice(0, 10),
      labels90: new Date(Date.parse(hist.lo) + 90 * 864e5).toISOString().slice(0, 10),
    },
    geos, rows, niches,
    // Отсеянные воронкой по трём причинам, которые на деле являются признаками.
    // Отсечка по каждой причине отдельно: при общей крупные («якоря спроса») вытесняли
    // из списка недовольный спрос и заброшенных, а именно они и интересны.
    rejected: (() => {
      const byKind = new Map();
      for (const r of rejected.sort((a, b) => ((b.k50 - b.k50p) || 0) - ((a.k50 - a.k50p) || 0))) {
        const list = byKind.get(r.reason) || [];
        if (list.length < 400) { list.push(r); byKind.set(r.reason, list); }
      }
      return [...byKind.values()].flat();
    })(),
  };

  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'report', 'appradar3.html'), 'utf8');
  const json = JSON.stringify(packRows(data)).replace(/</g, '\\u003c');
  const html = tpl.replace('__RADAR_DATA__', () => json).replace('__UNPACK_JS__', () => UNPACK_JS);
  const out = path.join(ROOT, 'out', 'appradar3.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  log(`  AppRadar 3: out/appradar3.html (${(Buffer.byteLength(html) / 1048576).toFixed(1)} МБ), гео ${geos.filter((g) => g.date).length}, кандидатов ${rows.length}, ниш ${niches.length}, отсеянных с сигналом ${data.rejected.length}`);
  return { rows: rows.length, niches: niches.length };
}
