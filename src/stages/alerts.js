// 12. Дайджест раз в день. Алерты не дублируются: ключ = вид + приложение + дата.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, startRun, finishRun } from '../lib/db.js';
import { qv } from './quantiles.js';
import { log } from '../lib/util.js';

const TITLES = {
  listing_changed: 'сменился хеш листинга у приложения уровня A',
  installs_source_changed: 'сменилось installs_source_geo — дельта за день и за окна, пересекающие смену, пустая',
  installs_consistency: 'maxInstalls расходится между гео больше чем на 1 %',
  installs_spike: 'прирост установок выше p99 при базе от 50K',
  burst: 'всплеск отзывов (burst_flag)',
  top10_in: 'вход в топ-10 по головному ключу',
  top10_out: 'выход из топ-10 по головному ключу',
  ads_found: 'обнаружена реклама у приложения уровня A/B',
  day_partial: 'день помечен partial — снимок меньше 60 % вчерашнего',
  suspect: 'больше 10 % пустых ответов на стадии',
  new_geo: 'приложение появилось в новом гео',
  new_since_last_run: 'новое приложение с прошлого обхода',
  watch_level_change: 'смена уровня наблюдения',
  k7_captcha: 'капча в K7 — проверка остановлена',
  k7_rate_limited: '429 в K7 — партия остановлена, пауза 30 минут',
  apk_attribution_sdk: 'в APK найден SDK атрибуции — прямой признак закупки',
  fraud_gate: 'сработал гейт fraud_ok',
  niche_door_above_p90: 'door ниши выше p90 — приложения понижены до C',
};

export async function run({ geo, date, runId, cycle = 'daily' }) {
  const d = db();
  startRun(runId, 'alerts', geo, cycle, date);

  const rows = d.prepare(
    `SELECT e.kind, e.app_id, e.niche_id, e.detail, a.title, a.watch_level
       FROM events e LEFT JOIN apps a ON a.app_id=e.app_id
      WHERE e.snapshot_date=? AND (e.geo=? OR e.geo IS NULL)
      ORDER BY e.kind, e.id`
  ).all(date, geo);

  // Всплеск установок выше p99 — считается из метрик, а не из событий.
  const p99growth = qv(null, geo, 'installs_growth_1d', date, 'p99', { nicheFirst: false });
  const spikes = d.prepare(
    `SELECT m.app_id, a.title, m.installs, m.installs_growth_1d
       FROM metrics_app_geo m JOIN apps a ON a.app_id=m.app_id
      WHERE m.geo=? AND m.snapshot_date=? AND m.installs >= 50000
        AND m.installs_growth_1d IS NOT NULL AND m.installs_growth_1d > COALESCE(?, 0.10)
      ORDER BY m.installs_growth_1d DESC LIMIT 40`
  ).all(geo, date, p99growth);

  const suspects = d.prepare(
    `SELECT stage, status, empty_pct, notes FROM runs
      WHERE geo=? AND snapshot_date=? AND (status IN ('suspect','stopped-captcha') OR empty_pct > 0.1)`
  ).all(geo, date);

  const byKind = new Map();
  for (const r of rows) {
    // Хеш листинга интересен только у уровня A — иначе дайджест тонет в шуме.
    if (r.kind === 'listing_changed' && r.watch_level !== 'A') continue;
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }

  const lines = [`Play Radar · дайджест ${geo} · ${date}`, '='.repeat(52), ''];
  let total = 0;

  if (spikes.length) {
    lines.push(`ПРИРОСТ УСТАНОВОК ВЫШЕ p99 (${spikes.length})`);
    for (const s of spikes) {
      lines.push(`  ${(s.installs_growth_1d * 100).toFixed(2).padStart(7)}%  ${s.app_id}  ${s.title || ''}`);
    }
    lines.push('');
    total += spikes.length;
  }

  for (const [kind, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`${(TITLES[kind] || kind).toUpperCase()} (${list.length})`);
    for (const r of list.slice(0, 30)) {
      lines.push(`  ${r.app_id || r.niche_id || '—'}  ${r.title || ''}${r.detail ? '  · ' + r.detail : ''}`);
    }
    if (list.length > 30) lines.push(`  … ещё ${list.length - 30}`);
    lines.push('');
    total += list.length;
  }

  if (suspects.length) {
    lines.push(`КАЧЕСТВО ПРОГОНА (${suspects.length})`);
    for (const s of suspects) {
      lines.push(`  ${s.stage}: ${s.status}${s.empty_pct != null ? `, пустых ${(s.empty_pct * 100).toFixed(1)}%` : ''} ${s.notes || ''}`);
    }
    lines.push('');
    total += suspects.length;
  }

  if (!total) lines.push('Ничего, требующего внимания.');

  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `alerts-${geo}-${date}.txt`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');

  finishRun(runId, 'alerts', geo, { notes: `${total} записей` });
  log(`  ${geo}: дайджест ${total} записей -> out/alerts-${geo}-${date}.txt`);
  return { total, file };
}
