// Разрешения — отдельный запрос, поэтому снимаются только для прошедших воронку
// (policy_risk_permissions на этапе 2 и policyPenalty в скоре).
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, primaryHl } from '../lib/config.js';
import { log } from '../lib/util.js';

export async function run({ geo, date, runId, cycle = 'discovery', scope = null }) {
  const d = db();
  startRun(runId, 'enrich-permissions', geo, cycle, date);
  const hl = primaryHl(geo);
  const budget = config().budget.discovery;

  // --scope funnel: все прошедшие воронку по последнему вердикту гео, на их последней карточке
  // гео и без лимита — кандидаты в основном уровня C, и обычный отбор (A/B, 100 на гео) их не
  // брал. Разрешения у приложения общие для всех гео: если они уже сняты в другой карточке,
  // копируются без запроса.
  const todo = scope === 'funnel'
    ? d.prepare(
      `SELECT p.app_id, p.snapshot_date FROM raw_app_page p
        WHERE p.geo=? AND p.hl=? AND p.permissions IS NULL
          AND p.app_id IN (SELECT s.app_id FROM screen_result s WHERE s.geo=? AND s.reject_reason IS NULL
                             AND s.snapshot_date=(SELECT MAX(snapshot_date) FROM screen_result WHERE geo=?))
          AND p.snapshot_date=(SELECT MAX(x.snapshot_date) FROM raw_app_page x WHERE x.app_id=p.app_id AND x.geo=p.geo AND x.hl=p.hl)
        ORDER BY p.max_installs DESC`
    ).all(geo, hl, geo, geo)
    : d.prepare(
      `SELECT p.app_id, p.snapshot_date FROM raw_app_page p JOIN apps a ON a.app_id=p.app_id
        WHERE p.geo=? AND p.snapshot_date=? AND p.hl=? AND p.permissions IS NULL
          AND a.watch_level IN ('A','B')
        ORDER BY p.max_installs DESC LIMIT ?`
    ).all(geo, date, hl, budget.permissions_max_apps);

  const up = d.prepare(`UPDATE raw_app_page SET permissions=? WHERE app_id=? AND geo=? AND snapshot_date=?`);
  const known = d.prepare(`SELECT permissions FROM raw_app_page WHERE app_id=? AND permissions IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1`);
  let done = 0, copied = 0, errors = 0;
  for (const { app_id: appId, snapshot_date: snap } of todo) {
    const have = scope === 'funnel' ? known.get(appId) : null;
    if (have) { up.run(have.permissions, appId, geo, snap); copied++; continue; }
    try {
      const perms = await play.permissions(appId, geo, hl);
      const flat = Array.isArray(perms)
        ? perms.map((p) => (typeof p === 'string' ? p : `${p.type || ''}: ${p.permission || ''}`.trim()))
        : [];
      up.run(JSON.stringify(flat), appId, geo, snap);
      done++;
    } catch (e) {
      errors++;
    }
  }
  finishRun(runId, 'enrich-permissions', geo, { requests: done + errors, errors, notes: `${done} приложений, скопировано ${copied}` });
  log(`  ${geo}: разрешения сняты у ${done} приложений, скопированы у ${copied}, ошибок ${errors}`);
  return { done, copied, errors };
}
