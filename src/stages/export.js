// 11. Экспорт листов. Колонки помечены классом score / descr в column_class.csv.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from '../lib/db.js';
import { log } from '../lib/util.js';

// Классы колонок по сводной таблице D дополнения к ТЗ.
const SCORE_COLUMNS = new Set([
  'demand', 'growth_s', 'weakness', 'openness', 'feasibility', 'organic',
  'fraud_ok', 'policy_ok', 'monetization_proof', 'index_gap', 'door',
  'weak_share', 'leader_share', 'new_share_18m', 'prescore', 'copy_score_gp',
  'installs', 'installs_per_rating', 'policy_penalty', 'geo_multiplier', 'fake',
  'localized_geo_count',   // A1: заменил locales_count
  'review_lang_mismatch',  // A4: новое определение, гейт fraud_ok
  'ads_found',             // B1
]);

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(dir, name, rows) {
  const file = path.join(dir, `${name}.csv`);
  if (!rows.length) { fs.writeFileSync(file, '', 'utf8'); return 0; }
  const cols = Object.keys(rows[0]);
  const out = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
  fs.writeFileSync(file, out.join('\n'), 'utf8');
  return rows.length;
}

export async function run({ geo, date }) {
  const d = db();
  const dir = path.join(ROOT, 'out', 'export');
  fs.mkdirSync(dir, { recursive: true });

  const sheets = {
    'данные': `SELECT * FROM metrics_app_geo WHERE geo='${geo}' ORDER BY snapshot_date DESC, prescore DESC`,
    'последний-снимок': `SELECT m.*, a.title, a.developer FROM metrics_app_geo m JOIN apps a ON a.app_id=m.app_id
                          WHERE m.geo='${geo}' AND m.snapshot_date='${date}' ORDER BY m.prescore DESC`,
    'дельты-7-30': `SELECT app_id, snapshot_date, installs, installs_delta_1d, installs_growth_1d,
                           installs_growth_7d, installs_growth_30d, ratings_delta_24h, listing_changed
                      FROM metrics_app_geo WHERE geo='${geo}' ORDER BY snapshot_date DESC`,
    'ниши': `SELECT * FROM metrics_niche_geo WHERE geo='${geo}' ORDER BY snapshot_date DESC, door ASC`,
    'гео-арбитраж': `SELECT * FROM metrics_geo_arbitrage ORDER BY snapshot_date DESC, geo_arbitrage DESC`,
    'кросс-гео': `SELECT n.head_keyword, n.geo, n.door, n.wall_installs, n.weak_share, n.snapshot_date
                    FROM metrics_niche_geo n ORDER BY n.head_keyword, n.geo`,
    'кандидаты-обхода': `SELECT da.app_id, da.geo, da.first_seen_via, da.discovery_paths_count, da.first_seen,
                                a.title, a.status, a.reject_reason, a.watch_level
                           FROM disc_apps da JOIN apps a ON a.app_id=da.app_id WHERE da.geo='${geo}'
                          ORDER BY da.discovery_paths_count DESC`,
    'очередь-на-проверку': `SELECT s.app_id, a.title, s.prescore, m.policy_auto_ok, m.verification_level,
                                   m.ads_found, m.organic, m.installs, m.installs_growth_1d, m.niche_id
                              FROM screen_result s JOIN apps a ON a.app_id=s.app_id
                              LEFT JOIN metrics_app_geo m ON m.app_id=s.app_id AND m.geo=s.geo AND m.snapshot_date=s.snapshot_date
                             WHERE s.geo='${geo}' AND s.snapshot_date='${date}' AND s.reject_reason IS NULL
                             ORDER BY COALESCE(m.policy_auto_ok,0) DESC, s.prescore DESC`,
    'размеченная-выборка': `SELECT * FROM organic_labels ORDER BY labeled_at DESC`,
    'валидация-признаков': `SELECT * FROM feature_validation ORDER BY snapshot_date DESC, feature`,
    'квантили-ниш': `SELECT * FROM niche_quantiles WHERE geo='${geo}' ORDER BY snapshot_date DESC, scope, scope_id, metric`,
    'события': `SELECT * FROM events WHERE geo='${geo}' OR geo IS NULL ORDER BY id DESC LIMIT 5000`,
    'журнал-прогонов': `SELECT * FROM runs ORDER BY started_at DESC`,
    'воронка': `SELECT s.*, a.title FROM screen_result s JOIN apps a ON a.app_id=s.app_id
                 WHERE s.geo='${geo}' AND s.snapshot_date='${date}' ORDER BY s.stage_reached, s.reject_reason`,
    // C1: лист для пакетного подтверждения policy_ok. Обратно — import-policy --file.
    'e7-политики': `SELECT m.app_id, a.title, m.policy_auto_ok, '' AS policy_ok, m.prescore,
                           m.permissions_risky, m.policy_risk_category, m.content_rating,
                           m.monetization_type, m.installs
                      FROM metrics_app_geo m JOIN apps a ON a.app_id=m.app_id
                      ${screenAsOf()}
                     WHERE m.geo='${geo}' AND m.snapshot_date='${date}' AND s.reject_reason IS NULL
                       AND m.app_id NOT IN (SELECT app_id FROM organic_labels WHERE evidence='policy')
                     ORDER BY COALESCE(m.policy_auto_ok,0) DESC, m.prescore DESC`,
    'apk-разбор': `SELECT * FROM raw_apk ORDER BY checked_at DESC`,
    'keyword-planner': `SELECT * FROM raw_external_keyword_planner ORDER BY avg_monthly_searches DESC`,
    'trends': `SELECT * FROM raw_external_trends ORDER BY keyword, point_date`,
  };

  let total = 0;
  for (const [name, sql] of Object.entries(sheets)) {
    try {
      const rows = d.prepare(sql).all();
      total += writeCsv(dir, name, rows);
    } catch (e) {
      log(`  лист "${name}" не выгружен: ${e.message}`);
    }
  }

  // Легенда классов колонок.
  const cols = d.prepare(`SELECT name FROM pragma_table_info('metrics_app_geo')`).all();
  writeCsv(dir, 'column_class', cols.map((c) => ({
    table: 'metrics_app_geo', column: c.name, class: SCORE_COLUMNS.has(c.name) ? 'score' : 'descr',
  })));

  log(`  экспорт: ${Object.keys(sheets).length + 1} листов, ${total} строк -> out/export/`);
  return { sheets: Object.keys(sheets).length + 1, rows: total };
}
