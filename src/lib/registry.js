import { db } from './db.js';

// Ничего не удаляется (принцип 8). Приложение один раз попадает в реестр и живёт там
// со статусом и причиной отсева.
export function registerApp(appId, geo, via, date, meta = {}) {
  const d = db();
  d.prepare(
    `INSERT INTO disc_apps (app_id, geo, first_seen_via, discovery_paths_count, geo_paths_count, first_seen)
     VALUES (?,?,?,1,1,?)
     ON CONFLICT(app_id, geo) DO UPDATE SET discovery_paths_count = discovery_paths_count + 1`
  ).run(appId, geo, via, date);

  d.prepare(
    // watch_level пишется явным NULL: в базах, созданных до отказа от DEFAULT 'C',
    // умолчание схемы иначе выдавало уровень «фон» приложениям, не проходившим воронку.
    `INSERT INTO apps (app_id, first_seen, first_seen_geo, installs_source_geo, title, developer, developer_id, genre_id, watch_level)
     VALUES (?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(app_id) DO UPDATE SET
       -- название не перезаписывается выдачей гео на её языке: английское ставит enrich-apps
       title = COALESCE(apps.title, excluded.title),
       developer = COALESCE(excluded.developer, apps.developer),
       developer_id = COALESCE(excluded.developer_id, apps.developer_id),
       genre_id = COALESCE(excluded.genre_id, apps.genre_id)`
  ).run(appId, date, geo, 'US', meta.title ?? null, meta.developer ?? null, meta.developerId ?? null, meta.genreId ?? null);
}

export function registerKeyword(geo, keyword, { lang, source, depth = 0, intent = 'generic', date, concept = null }) {
  // concept наследуется от семени, из которого ключ вырос: шаблон, подсказка и n-грамма
  // остаются в той же нише, и слой F видит её во всех гео как одну.
  db().prepare(
    `INSERT INTO disc_keywords (geo, keyword, lang, source, depth, intent_type, first_seen, concept)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(geo, keyword) DO UPDATE SET concept = COALESCE(disc_keywords.concept, excluded.concept)`
  ).run(geo, keyword.toLowerCase().trim(), lang, source, depth, intent, date, concept);
}

export function setWatchLevel(appId, level, reason, date, geo) {
  const cur = db().prepare(`SELECT watch_level FROM apps WHERE app_id=?`).get(appId);
  if (!cur || cur.watch_level === level) return false;
  db().prepare(`UPDATE apps SET watch_level=? WHERE app_id=?`).run(level, appId);
  db().prepare(
    `INSERT INTO events (snapshot_date, geo, app_id, kind, detail, created_at) VALUES (?,?,?,?,?,?)`
  ).run(date, geo, appId, 'watch_level_change', `${cur.watch_level ?? 'не оценено'} -> ${level}: ${reason}`, new Date().toISOString());
  return true;
}

export function lastFullDay(geo, table = 'raw_app_page') {
  const row = db().prepare(
    `SELECT snapshot_date FROM ${table} WHERE geo=? GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 1`
  ).get(geo);
  return row ? row.snapshot_date : null;
}
