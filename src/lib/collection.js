// Сбор и планы: состояние дня по активным гео, план на 30 дней и расписание.
//
// Жило в стадии dashboard, которая строила замороженный отчёт Play Market Radar. Сама стадия
// удалена 27.09, а эти две функции остались: их читает AppRadar 2 на странице «Сбор и планы».
// Вынесены в lib именно поэтому — чтобы живой отчёт не зависел от мёртвой стадии, и чтобы
// удаление следующего замороженного отчёта не утащило за собой работающий экран.
import { config, activeGeos } from './config.js';
import { planForDays, maturity, pendingWork, schedule } from './schedule.js';

const one = (d, sql, ...p) => d.prepare(sql).get(...p);
const all = (d, sql, ...p) => d.prepare(sql).all(...p);

// Готовность дня по одному гео: собрано, собирается или данных нет — и почему именно так.
function collectStatus(d, geo, date) {
  const ds = one(d, `SELECT * FROM day_status WHERE geo=? AND snapshot_date=?`, geo, date);
  const runs = all(d, `SELECT stage, status, requests, errors, empty_pct, notes, started_at, finished_at
                         FROM runs WHERE geo=? AND snapshot_date=? ORDER BY started_at`, geo, date);
  const suspect = runs.some((r) => r.status === 'suspect' || (r.empty_pct != null && r.empty_pct > 0.1));
  const pending = pendingWork(geo, date);
  const blocking = pending.filter((p) => p.count > 0 && ['keyword-serp', 'enrich-apps'].includes(p.key));

  let readiness = 'собрано', why = 'все обязательные стадии дня закрыты';
  if (!ds || !ds.rows_today) { readiness = 'нет данных'; why = 'за сегодня нет ни одной карточки'; }
  else if (ds.partial) { readiness = 'недостаточно'; why = `снимок ${ds.rows_today} строк — меньше 60 % от вчерашних ${ds.rows_prev}, день помечен partial`; }
  else if (blocking.length) { readiness = 'собирается'; why = blocking.map((b) => `${b.title} — ${b.count}`).join('; '); }
  else if (suspect) { readiness = 'собирается'; why = 'на части стадий больше 10 % пустых ответов, стоит перезапустить'; }

  return {
    geo, readiness, why,
    rows_today: ds?.rows_today ?? 0, rows_prev: ds?.rows_prev ?? null,
    partial: ds?.partial ? 1 : 0, suspect: suspect ? 1 : 0,
    runs, pending, maturity: maturity(geo, date),
  };
}

export function collectCollection(d, date) {
  const cfg = config();
  const active = activeGeos();
  const s = schedule();
  const status = active.map((g) => collectStatus(d, g.geo, date));
  // Прогноз запросов в день на гео: карточки A/B плюс выдача по ядру.
  const levelAB = one(d, `SELECT COUNT(*) c FROM apps WHERE watch_level IN ('A','B')`).c;
  const keywordsByGeo = new Map(all(d, `SELECT geo, COUNT(*) c FROM disc_keywords GROUP BY geo`).map((r) => [r.geo, r.c]));
  const avgKeywords = active.length
    ? Math.round(active.reduce((a, g) => a + (keywordsByGeo.get(g.geo) || 0), 0) / active.length) : 0;
  const forecast = Math.max(1, Math.round(levelAB * 1.2) + avgKeywords);
  return {
    status,
    plan: planForDays(date, 30),
    schedule: {
      full_crawl_cycle: s.full_crawl.cycle_days,
      full_crawl_per_day: s.full_crawl.geos_per_day_max,
      light_crawl_weekday: s.light_crawl.weekday,
      k7_a: s.k7.level_a_days, k7_b: s.k7.level_b_days,
      monthly: s.monthly, quarterly: s.quarterly,
      forecast_requests_per_geo_day: forecast,
    },
    start_hour_utc: Object.fromEntries(cfg.geos.geos.map((g) => [g.geo, g.start_hour_utc])),
  };
}
