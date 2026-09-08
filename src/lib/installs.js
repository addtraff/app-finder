// A2 (дополнение к ТЗ). «Домашняя страна установок» — не поле Play: на чужой базе она
// возникала как артефакт запроса без явного country. Мы запрашиваем с явным gl, поэтому
// страна источника известна по построению и фиксируется в реестре как installs_source_geo.
import { db, logEvent } from './db.js';
import { config, referenceGeo } from './config.js';

// Порядок гео из раздела 3.1: первый доступный становится источником, если референс недоступен.
function geoOrder() {
  const ref = referenceGeo();
  const list = config().geos.geos.map((g) => g.geo);
  return [ref, ...list.filter((g) => g !== ref)];
}

// Возвращает Map: app_id -> { source_geo, installs, consistency, spread, geos }
export function resolveInstallsSource(date) {
  const d = db();
  const order = geoOrder();
  const rank = new Map(order.map((g, i) => [g, i]));

  // Один снимок на (приложение, гео) за день — по первому hl гео.
  const rows = d.prepare(
    `SELECT p.app_id, p.geo, p.max_installs, p.available
       FROM raw_app_page p
       JOIN (SELECT app_id, geo, MIN(hl) AS hl FROM raw_app_page
              WHERE snapshot_date = ? GROUP BY app_id, geo) f
         ON f.app_id = p.app_id AND f.geo = p.geo AND f.hl = p.hl
      WHERE p.snapshot_date = ?`
  ).all(date, date);

  const byApp = new Map();
  for (const r of rows) {
    if (!byApp.has(r.app_id)) byApp.set(r.app_id, []);
    byApp.get(r.app_id).push(r);
  }

  const current = new Map(
    d.prepare(`SELECT app_id, installs_source_geo FROM apps`).all().map((r) => [r.app_id, r.installs_source_geo])
  );
  const upSource = d.prepare(`UPDATE apps SET installs_source_geo=? WHERE app_id=?`);

  const out = new Map();
  const tx = d.transaction(() => {
    for (const [appId, list] of byApp) {
      const available = list.filter((r) => r.available !== 0 && r.max_installs != null);
      const pool = available.length ? available : list.filter((r) => r.max_installs != null);
      if (!pool.length) continue;

      pool.sort((a, b) => (rank.get(a.geo) ?? 99) - (rank.get(b.geo) ?? 99));
      const source = pool[0];

      // installs_consistency: maxInstalls снимается во всех гео как контроль.
      // Расхождение больше 1 % между максимумом и минимумом — повод пометить день suspect.
      const values = pool.map((r) => r.max_installs).filter((v) => v > 0);
      let consistency = null, spread = null;
      if (values.length >= 2) {
        const hi = Math.max(...values), lo = Math.min(...values);
        spread = hi > 0 ? (hi - lo) / hi : 0;
        consistency = spread > 0.01 ? 0 : 1;
      }

      const prev = current.get(appId);
      if (prev !== source.geo) {
        upSource.run(source.geo, appId);
        // Дельта за день смены источника и за окна, пересекающие смену, пустая.
        if (prev) logEvent('installs_source_changed', { date, geo: source.geo, appId, detail: `${prev} -> ${source.geo}` });
      }

      out.set(appId, {
        source_geo: source.geo,
        installs: source.max_installs,
        consistency, spread,
        geos: pool.length,
      });
    }
  });
  tx();
  return out;
}
