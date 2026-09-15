// Общий кэш префиксов (4.3): «csgo » один на сотни фраз. Кэш — это сырьё радара raw_suggest
// плюс журнал raw_suggest_fetch, где отмечены и пустые ответы. Свежесть — suggest_cache_days:
// score меняется медленно, пересчёт раз в 2–4 недели.
//
// Строки raw_suggest, снятые радаром до появления журнала, тоже считаются кэшем: это те же
// ответы Play на тот же префикс в том же гео и на том же основном языке интерфейса.
import { play, CaptchaStop } from '../play.js';
import { daysAgoUTC } from '../util.js';
import { kwDb } from './schema.js';

export function suggestCache({ geo, hl, date, ttlDays = 21, offline = false }) {
  const d = kwDb();
  const since = daysAgoUTC(ttlDays, new Date(`${date}T12:00:00Z`));
  const qFetch = d.prepare(
    `SELECT snapshot_date FROM raw_suggest_fetch
      WHERE geo=? AND prefix=? AND ok=1 AND snapshot_date BETWEEN ? AND ?
      ORDER BY snapshot_date DESC LIMIT 1`);
  const qLegacy = d.prepare(
    `SELECT MAX(snapshot_date) md FROM raw_suggest WHERE geo=? AND prefix=? AND snapshot_date BETWEEN ? AND ?`);
  const qRows = d.prepare(
    `SELECT suggestion FROM raw_suggest WHERE geo=? AND prefix=? AND snapshot_date=? ORDER BY position`);
  const insFetch = d.prepare(
    `INSERT OR REPLACE INTO raw_suggest_fetch (snapshot_date, geo, hl, prefix, n, ok, error, fetched_at)
     VALUES (?,?,?,?,?,?,?,?)`);
  const delRows = d.prepare(`DELETE FROM raw_suggest WHERE snapshot_date=? AND geo=? AND prefix=?`);
  const insRow = d.prepare(
    `INSERT OR REPLACE INTO raw_suggest (snapshot_date, geo, prefix, position, suggestion) VALUES (?,?,?,?,?)`);

  const mem = new Map();
  const stats = { requests: 0, cache_hits: 0, errors: 0, shape_errors: 0, empty: 0 };

  const peek = (prefix) => {
    if (mem.has(prefix)) return mem.get(prefix);
    let day = qFetch.get(geo, prefix, since, date)?.snapshot_date;
    if (!day) day = qLegacy.get(geo, prefix, since, date)?.md;
    if (!day) return undefined;
    const values = qRows.all(geo, prefix, day).map((r) => r.suggestion);
    mem.set(prefix, values);
    return values;
  };

  const lookup = async (prefix) => {
    const hit = peek(prefix);
    if (hit !== undefined) { stats.cache_hits++; return { values: hit, cached: true }; }
    if (offline) return { values: null, cached: false };
    let values = null, ok = 1, error = null;
    try {
      const res = await play.suggest(prefix, geo, hl);
      stats.requests++;
      if (!Array.isArray(res) || res.some((v) => typeof v !== 'string')) {
        ok = 0; error = 'неожиданная форма ответа'; stats.shape_errors++;
      } else {
        values = res;
        if (!res.length) stats.empty++;
      }
    } catch (e) {
      if (e instanceof CaptchaStop) throw e;
      stats.requests++;
      ok = 0; error = String(e.message || e).slice(0, 300); stats.errors++;
    }
    d.transaction(() => {
      insFetch.run(date, geo, hl, prefix, values ? values.length : null, ok, error, new Date().toISOString());
      if (values) {
        // Повторный запрос того же префикса в тот же день заменяет список целиком:
        // иначе хвост более длинного утреннего ответа остался бы под новым.
        delRows.run(date, geo, prefix);
        values.forEach((v, i) => insRow.run(date, geo, prefix, i + 1, v));
      }
    })();
    if (values) mem.set(prefix, values);
    return { values, cached: false };
  };

  return { peek, lookup, stats };
}
