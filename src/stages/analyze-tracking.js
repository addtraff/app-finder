// Замена ручного разбора APK (B2 дополнения к ТЗ): ищет SDK атрибуции (AppsFlyer, Adjust,
// Branch, Kochava, Singular, Tenjin) не в байткоде, а в тексте, который Play и разработчик
// публикуют сами — краткое описание/полное описание карточки, страница privacy policy
// (внешняя ссылка, снимается отдельным запросом) и раздел Data Safety.
//
// Слабее прямого чтения APK: находка — прямая улика (организация написала про трекер не
// просто так), а вот отсутствие находки НЕ доказывает отсутствие интеграции — многие
// privacy policy не документированы или используют общие фразы вроде «third-party
// analytics providers» без имён. Поэтому found=1 -> attribution_sdk=1 (organic=0), а
// found=0 остаётся «не доказано», а не «подтверждена органика» (в отличие от raw_apk,
// где реальный разбор байткода даёт положительное доказательство отсутствия).
//
// Data Safety получить проще всего (один запрос), но методика уже проверяла его на
// исходной базе как прокси атрибуции: не разделяет группы (3 из 8 в обеих делятся
// рекламным ID). Поэтому Data Safety тут — только описательное поле
// (datasafety_ad_id_shared), в детектор трекера по имени не входит.
import { play } from '../lib/play.js';
import { fetchPageText } from '../lib/fetchtext.js';
import { db, ROOT, startRun, finishRun, logEvent } from '../lib/db.js';
import { config } from '../lib/config.js';
import { sleep, log, warn } from '../lib/util.js';
import fs from 'node:fs';
import path from 'node:path';

function buildMatchers() {
  const attribution = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'apk-prefixes.json'), 'utf8')).attribution;
  // Ищем и человеческое имя ("AppsFlyer"), и техническое (com.appsflyer) — оба всплывают в прозе.
  const names = [];
  for (const [prefix, human] of Object.entries(attribution)) {
    names.push({ human, re: new RegExp('\\b' + human.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') });
    const bare = prefix.split('.').pop();
    if (bare && bare.length > 3) names.push({ human, re: new RegExp('\\b' + bare + '\\b', 'i') });
  }
  return names;
}

function scanText(text, matchers) {
  if (!text) return [];
  const found = new Set();
  for (const m of matchers) if (m.re.test(text)) found.add(m.human);
  return [...found];
}

export async function run({ geo, date, runId, cycle = 'discovery', limit = null, force = false }) {
  const d = db();
  startRun(runId, 'analyze-tracking', geo, cycle, date);
  const matchers = buildMatchers();
  const hl = (config().geos.geos.find((g) => g.geo === geo) || {}).hl?.[0] || 'en';
  const budget = config().budget.discovery;

  // Уровни A/B, ещё не сканированные за 30 дней (тот же интервал, что был у APK-разбора).
  // Принудительный сбор (--force): добавляет C — сам факт наличия/отсутствия трекера
  // важен и для фона, а не только для отобранных — и снимает 30-дневное окно, потому
  // что privacy policy проверялась ДО расширения каталога и половина C-уровня вообще
  // никогда не сканировалась. watch_level общий для приложения, не per-geo — без
  // отсечки «уже просканировано сегодня» этот запрос повторился бы на всех 30 гео
  // одним и тем же списком и заново сходил бы за той же privacy policy 30 раз.
  let todo = d.prepare(
    force
      ? `SELECT a.app_id FROM apps a
          WHERE a.watch_level IN ('A','B','C')
            AND NOT EXISTS (SELECT 1 FROM raw_tracking_scan s WHERE s.app_id=a.app_id AND s.checked_at=?)`
      : `SELECT a.app_id FROM apps a
          WHERE a.watch_level IN ('A','B')
            AND NOT EXISTS (SELECT 1 FROM raw_tracking_scan s WHERE s.app_id=a.app_id AND s.checked_at > date(?, '-30 day'))`
  ).all(date).map((r) => r.app_id);
  if (limit) todo = todo.slice(0, limit);

  // watch_level общий для приложения, а не per-geo: B-уровень мог быть обнаружен в любом
  // из 30 гео и не иметь карточки конкретно в переданном geo или в US.
  const cardStmt = d.prepare(
    `SELECT description, summary, privacy_policy FROM raw_app_page
      WHERE app_id=? AND geo=? ORDER BY snapshot_date DESC LIMIT 1`
  );
  const cardAnyGeo = d.prepare(
    `SELECT description, summary, privacy_policy FROM raw_app_page
      WHERE app_id=? ORDER BY snapshot_date DESC LIMIT 1`
  );
  const ins = d.prepare(`INSERT OR REPLACE INTO raw_tracking_scan
    (app_id, checked_at, found, matched_names, matched_in, privacy_policy_url,
     privacy_fetch_ok, privacy_fetch_status, datasafety_ad_id_shared, datasafety_purposes, note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insLabel = d.prepare(`INSERT OR REPLACE INTO organic_labels (app_id, label, evidence, labeled_at, note) VALUES (?,?,?,?,?)`);

  let scanned = 0, found = 0, privacyFetched = 0, errors = 0;
  for (const appId of todo) {
    const card = cardStmt.get(appId, geo) || cardStmt.get(appId, 'US') || cardAnyGeo.get(appId);
    if (!card) continue;

    const descFound = scanText(`${card.summary || ''} ${card.description || ''}`, matchers);
    const matchedIn = descFound.length ? ['description'] : [];
    let allFound = new Set(descFound);

    let privacyOk = null, privacyStatus = null;
    if (card.privacy_policy) {
      try {
        const r = await fetchPageText(card.privacy_policy);
        privacyOk = r ? (r.ok ? 1 : 0) : null;
        privacyStatus = r ? r.status : null;
        if (r && r.ok && r.text) {
          privacyFetched++;
          const pf = scanText(r.text, matchers);
          if (pf.length) { matchedIn.push('privacy_policy'); pf.forEach((n) => allFound.add(n)); }
        }
      } catch (e) {
        errors++;
      }
      await sleep(300); // вежливая пауза к чужим доменам, не к Play
    }

    // Data Safety: описательно, не входит в found. Ищем факт передачи рекламного ID.
    let adIdShared = null, purposes = null, dsRaw = null;
    try {
      dsRaw = await play.datasafety(appId, geo, hl);
    } catch (e) {
      dsRaw = null;
    }
    if (dsRaw) {
      const shared = [...(dsRaw.sharedData || [])];
      const adRow = shared.find((r) => /device or other ids/i.test(r.data || '') && /advertising/i.test(r.purpose || ''));
      adIdShared = adRow ? 1 : 0;
      purposes = [...new Set(shared.map((r) => r.purpose).filter(Boolean))].join('; ') || null;
    }

    const foundList = [...allFound];
    ins.run(appId, date, foundList.length ? 1 : 0, foundList.join(', ') || null, matchedIn.join(',') || null,
      card.privacy_policy || null, privacyOk, privacyStatus, adIdShared, purposes, null);

    if (foundList.length) {
      // Прямая улика: имя трекера не появляется в описании/политике просто так.
      insLabel.run(appId, 'buys', 'tracking_scan', date, `найдено: ${foundList.join(', ')} (${matchedIn.join(', ')})`);
      logEvent('tracking_sdk_found', { date, geo, appId, detail: foundList.join(', ') });
      found++;
    }
    scanned++;
    if (scanned % 20 === 0) log(`  скан трекеров: ${scanned}/${todo.length}`);
  }

  finishRun(runId, 'analyze-tracking', geo, {
    requests: privacyFetched, errors,
    notes: `${scanned} приложений, трекер найден у ${found}, privacy policy получена у ${privacyFetched}`,
  });
  log(`  ${geo}: скан трекеров — ${scanned} приложений, найдено у ${found}, privacy policy получена у ${privacyFetched}`);
  return { scanned, found, privacyFetched, errors };
}
