// Расписание конвейера. План в отчёте и команда `plan` считают из одного места,
// поэтому нарисованный план и реальный всегда совпадают.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, db } from './db.js';
import { config, activeGeos } from './config.js';

let _s = null;
export function schedule() {
  if (!_s) _s = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'schedule.json'), 'utf8'));
  return _s;
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (dateIso, n) => iso(new Date(Date.parse(dateIso) + n * 86400000));

// Полный обход распределён по циклу: гео i идёт на (i mod cycle)-й день цикла,
// но не больше geos_per_day_max в один день.
export function fullCrawlSlots(geos, cycleDays, perDay) {
  const slots = new Map(); // dayOfCycle -> [geo]
  let day = 0;
  for (const g of geos) {
    while ((slots.get(day) || []).length >= perDay) day = (day + 1) % cycleDays;
    if (!slots.has(day)) slots.set(day, []);
    slots.get(day).push(g.geo);
    day = (day + 1) % cycleDays;
  }
  return slots;
}

// Днём цикла считается число дней от эпохи — так план не «съезжает» между запусками.
export function dayOfCycle(dateIso, cycleDays) {
  return Math.floor(Date.parse(dateIso) / 86400000) % cycleDays;
}

export function planForDays(fromDateIso, days = 30) {
  const s = schedule();
  const geos = activeGeos();
  const cycle = s.full_crawl.cycle_days;
  const slots = fullCrawlSlots(geos, cycle, s.full_crawl.geos_per_day_max);

  const d = db();
  // Последняя проверка K7 по уровням — от неё считается следующая.
  const lastK7 = d.prepare(`SELECT MAX(checked_at) m FROM raw_ads_meta`).get()?.m
    || d.prepare(`SELECT MAX(checked_at) m FROM raw_ads_google`).get()?.m || null;

  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDateIso, i);
    const dt = new Date(Date.parse(date));
    const weekday = dt.getUTCDay();
    const items = [];

    for (const g of geos) items.push({ kind: 'daily', geo: g.geo, hour: g.start_hour_utc });

    const doc = dayOfCycle(date, cycle);
    for (const geo of slots.get(doc) || []) items.push({ kind: 'full_crawl', geo });

    if (weekday === s.light_crawl.weekday) {
      for (const g of geos) items.push({ kind: 'light_crawl', geo: g.geo });
    }

    const sinceK7 = lastK7 ? Math.round((Date.parse(date) - Date.parse(lastK7)) / 86400000) : i;
    if (sinceK7 > 0 && sinceK7 % s.k7.level_a_days === 0) items.push({ kind: 'k7_a' });
    if (sinceK7 > 0 && sinceK7 % s.k7.level_b_days === 0) items.push({ kind: 'k7_b' });

    for (const m of s.monthly) {
      if (dt.getUTCDate() === m.day_of_month) items.push({ kind: 'monthly', key: m.key, title: m.title });
    }

    out.push({ date, weekday, items });
  }
  return out;
}

// Что положено сделать сегодня — этим пользуется и CLI, и отчёт.
export function dueToday(dateIso) {
  const plan = planForDays(dateIso, 1)[0];
  const byKind = {};
  for (const it of plan.items) {
    if (!byKind[it.kind]) byKind[it.kind] = [];
    byKind[it.kind].push(it);
  }
  return byKind;
}

// Зрелость данных: с какого дня наблюдения какие метрики становятся считаемыми.
export function maturity(geo, dateIso) {
  const d = db();
  const row = d.prepare(
    `SELECT MIN(snapshot_date) first_date, COUNT(DISTINCT snapshot_date) days FROM raw_app_page WHERE geo=?`
  ).get(geo);
  if (!row || !row.first_date) return { first_date: null, days: 0, stages: [] };
  const elapsed = Math.round((Date.parse(dateIso) - Date.parse(row.first_date)) / 86400000);
  return {
    first_date: row.first_date,
    snapshots: row.days,
    elapsed,
    stages: schedule().maturity.map((m) => ({
      ...m,
      available: elapsed >= m.day,
      eta: elapsed >= m.day ? null : addDays(row.first_date, m.day),
    })),
  };
}

// Остаток работы на сегодня — по тем же условиям, по которым стадии выбирают себе задачи.
export function pendingWork(geo, dateIso) {
  const d = db();
  const one = (sql, ...p) => d.prepare(sql).get(...p).c;
  return [
    {
      key: 'keyword-serp', title: 'ключей без сегодняшней выдачи',
      count: one(`SELECT COUNT(*) c FROM disc_keywords k WHERE k.geo=? AND k.active=1 AND k.dead=0
                    AND NOT EXISTS (SELECT 1 FROM raw_search s WHERE s.geo=k.geo AND s.keyword=k.keyword AND s.snapshot_date=?)`, geo, dateIso),
      cmd: `node src/cli.js stage keyword-serp --geo ${geo}`,
    },
    {
      key: 'enrich-apps', title: 'приложений A/B без карточки за сегодня',
      count: one(`SELECT COUNT(*) c FROM apps a WHERE a.watch_level IN ('A','B')
                    AND NOT EXISTS (SELECT 1 FROM raw_app_page p WHERE p.app_id=a.app_id AND p.geo=? AND p.snapshot_date=?)`, geo, dateIso),
      cmd: `node src/cli.js stage enrich-apps --geo ${geo}`,
    },
    {
      key: 'enrich-apps-c', title: 'приложений C без карточки за неделю',
      count: one(`SELECT COUNT(*) c FROM apps a WHERE a.watch_level='C'
                    AND NOT EXISTS (SELECT 1 FROM raw_app_page p WHERE p.app_id=a.app_id AND p.geo=? AND p.snapshot_date > date(?, '-7 day'))`, geo, dateIso),
      cmd: `node src/cli.js stage enrich-apps --geo ${geo} --cycle daily`,
    },
    {
      key: 'discovered', title: 'найдено обходом, но ещё без карточки',
      count: one(`SELECT COUNT(*) c FROM disc_apps da WHERE da.geo=?
                    AND NOT EXISTS (SELECT 1 FROM raw_app_page p WHERE p.app_id=da.app_id AND p.geo=da.geo)`, geo),
      cmd: `node src/cli.js stage enrich-apps --geo ${geo}`,
    },
    {
      key: 'enrich-reviews', title: 'A/B без отзывов за 3 дня',
      count: one(`SELECT COUNT(*) c FROM apps a WHERE a.watch_level IN ('A','B')
                    AND NOT EXISTS (SELECT 1 FROM raw_reviews r WHERE r.app_id=a.app_id AND r.geo=? AND r.fetched_at > date(?, '-3 day'))`, geo, dateIso),
      cmd: `node src/cli.js stage enrich-reviews --geo ${geo}`,
    },
    {
      key: 'enrich-permissions', title: 'A/B без снятых разрешений',
      count: one(`SELECT COUNT(*) c FROM apps a JOIN raw_app_page p ON p.app_id=a.app_id AND p.geo=? AND p.snapshot_date=?
                   WHERE a.watch_level IN ('A','B') AND p.permissions IS NULL`, geo, dateIso),
      cmd: `node src/cli.js stage enrich-permissions --geo ${geo}`,
    },
    {
      key: 'enrich-developer', title: 'разработчиков без снимка за неделю',
      count: one(`SELECT COUNT(DISTINCT p.developer_id) c FROM raw_app_page p JOIN apps a ON a.app_id=p.app_id
                   WHERE p.geo=? AND p.developer_id IS NOT NULL AND a.watch_level IN ('A','B','C')
                     AND NOT EXISTS (SELECT 1 FROM raw_developer rd WHERE rd.developer_id=p.developer_id AND rd.snapshot_date > date(?, '-7 day'))`, geo, dateIso),
      cmd: `node src/cli.js stage enrich-developer --geo ${geo}`,
    },
    {
      key: 'check-ads', title: 'A/B с непроверенной рекламой (K7)',
      count: one(`SELECT COUNT(*) c FROM metrics_app_geo m JOIN apps a ON a.app_id=m.app_id
                   WHERE m.geo=? AND m.snapshot_date=? AND a.watch_level IN ('A','B') AND m.ads_found='unchecked'`, geo, dateIso),
      cmd: `node src/cli.js stage check-ads --geo ${geo}`,
    },
    {
      key: 'policy', title: 'прошедших воронку без ручного гейта policy_ok',
      count: one(`SELECT COUNT(*) c FROM screen_result s
                   WHERE s.geo=? AND s.snapshot_date=? AND s.reject_reason IS NULL
                     AND s.app_id NOT IN (SELECT app_id FROM organic_labels WHERE evidence='policy')`, geo, dateIso),
      cmd: `node src/cli.js set-policy --app <id> --ok 1`,
    },
  ];
}
