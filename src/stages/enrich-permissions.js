// Разрешения — отдельный запрос, поэтому снимаются только для прошедших воронку
// (policy_risk_permissions на этапе 2 и policyPenalty в скоре).
//
// Запрашиваются ВСЕГДА на английском, каким бы ни был язык гео. Сами разрешения от языка
// витрины не зависят — зависят только их подписи, а разбираем мы именно подписи, английскими
// шаблонами из institutions.risky_permission_labels. Пока снимали языком гео, 2 200 списков
// из 3 391 пришли на иврите, арабском, китайском и португальском, шаблоны по ним молчали, и
// приложение получало «опасных разрешений нет» вместо «не проверено» — худшая из возможных
// ошибок, потому что выглядит как хорошая новость. См. src/lib/permissions.js.
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, primaryHl } from '../lib/config.js';
import { log } from '../lib/util.js';
import { parsePerms, permsLang } from '../lib/permissions.js';

export async function run({ geo, date, runId, cycle = 'discovery', scope = null }) {
  const d = db();
  startRun(runId, 'enrich-permissions', geo, cycle, date);
  const hl = primaryHl(geo);
  const budget = config().budget.discovery;

  // --scope funnel: все прошедшие воронку по последнему вердикту гео, на их последней карточке
  // гео и без лимита — кандидаты в основном уровня C, и обычный отбор (A/B, 100 на гео) их не
  // брал. Разрешения у приложения общие для всех гео: если они уже сняты в другой карточке,
  // копируются без запроса.
  //
  // --scope relang: то же самое, но берутся карточки, где список УЖЕ есть и снят на языке
  // витрины. Такие переснимаются на английском: иначе они навсегда остаются непроверяемыми.
  const relang = scope === 'relang';
  const todo = scope === 'funnel' || relang
    ? d.prepare(
      `SELECT p.app_id, p.snapshot_date, p.permissions FROM raw_app_page p
        WHERE p.geo=? AND p.hl=? AND p.permissions IS ${relang ? 'NOT NULL' : 'NULL'}
          AND p.app_id IN (SELECT s.app_id FROM screen_result s WHERE s.geo=? AND s.reject_reason IS NULL
                             AND s.snapshot_date=(SELECT MAX(snapshot_date) FROM screen_result WHERE geo=?))
          AND p.snapshot_date=(SELECT MAX(x.snapshot_date) FROM raw_app_page x WHERE x.app_id=p.app_id AND x.geo=p.geo AND x.hl=p.hl)
        ORDER BY p.max_installs DESC`
    ).all(geo, hl, geo, geo)
    : d.prepare(
      `SELECT p.app_id, p.snapshot_date, p.permissions FROM raw_app_page p JOIN apps a ON a.app_id=p.app_id
        WHERE p.geo=? AND p.snapshot_date=? AND p.hl=? AND p.permissions IS NULL
          AND a.watch_level IN ('A','B')
        ORDER BY p.max_installs DESC LIMIT ?`
    ).all(geo, date, hl, budget.permissions_max_apps);

  const up = d.prepare(`UPDATE raw_app_page SET permissions=? WHERE app_id=? AND geo=? AND snapshot_date=?`);
  // Копируется только английский список: копия на языке витрины не решает задачу, ради
  // которой запрос и делается.
  const known = d.prepare(`SELECT permissions FROM raw_app_page WHERE app_id=? AND permissions IS NOT NULL ORDER BY snapshot_date DESC LIMIT 5`);
  const knownEn = (appId) => known.all(appId).find((r) => permsLang(parsePerms(r.permissions)) === 'en') || null;
  let done = 0, copied = 0, errors = 0, skipped = 0;
  for (const { app_id: appId, snapshot_date: snap, permissions: had } of todo) {
    if (relang && permsLang(parsePerms(had)) === 'en') { skipped++; continue; }
    const have = scope === 'funnel' || relang ? knownEn(appId) : null;
    if (have) { up.run(have.permissions, appId, geo, snap); copied++; continue; }
    try {
      const perms = await play.permissions(appId, geo, 'en');
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
  log(`  ${geo}: разрешения сняты у ${done} приложений, скопированы у ${copied}, уже английских ${skipped}, ошибок ${errors}`);
  return { done, copied, skipped, errors };
}
