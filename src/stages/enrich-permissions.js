// Разрешения — отдельный запрос, поэтому снимаются только для прошедших воронку
// (policy_risk_permissions на этапе 2 и policyPenalty в скоре).
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, primaryHl } from '../lib/config.js';
import { log } from '../lib/util.js';

export async function run({ geo, date, runId, cycle = 'discovery' }) {
  const d = db();
  startRun(runId, 'enrich-permissions', geo, cycle, date);
  const hl = primaryHl(geo);
  const budget = config().budget.discovery;

  const todo = d.prepare(
    `SELECT p.app_id FROM raw_app_page p JOIN apps a ON a.app_id=p.app_id
      WHERE p.geo=? AND p.snapshot_date=? AND p.hl=? AND p.permissions IS NULL
        AND a.watch_level IN ('A','B')
      ORDER BY p.max_installs DESC LIMIT ?`
  ).all(geo, date, hl, budget.permissions_max_apps).map((r) => r.app_id);

  const up = d.prepare(`UPDATE raw_app_page SET permissions=? WHERE app_id=? AND geo=? AND snapshot_date=?`);
  let done = 0, errors = 0;
  for (const appId of todo) {
    try {
      const perms = await play.permissions(appId, geo, hl);
      const flat = Array.isArray(perms)
        ? perms.map((p) => (typeof p === 'string' ? p : `${p.type || ''}: ${p.permission || ''}`.trim()))
        : [];
      up.run(JSON.stringify(flat), appId, geo, date);
      done++;
    } catch (e) {
      errors++;
    }
  }
  finishRun(runId, 'enrich-permissions', geo, { requests: done + errors, errors, notes: `${done} приложений` });
  log(`  ${geo}: разрешения сняты у ${done} приложений, ошибок ${errors}`);
  return { done, errors };
}
