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

// Имена трёх трекеров — обычные английские слова: «Adjust the line size», «Branch office»,
// «singular value». На голом слове держалось 2 226 находок из 2 795, и 1 984 из них пришли
// из privacy policy, где «you may adjust your settings» стоит в каждом втором шаблоне.
// Поэтому для них засчитывается только техническая улика — имя пакета или домен трекера —
// либо голое имя рядом со словом из контекстного списка. У однозначных имён (AppsFlyer,
// Kochava, Tenjin) голого имени достаточно: в прозе они ничего другого не значат.
const SDK_RULES = {
  AppsFlyer: { strong: ['com.appsflyer', 'appsflyer.com', 'onelink.me'], bareOk: true },
  Kochava: { strong: ['com.kochava', 'kochava.com', 'kochava.net'], bareOk: true },
  Tenjin: { strong: ['com.tenjin', 'tenjin.io', 'tenjin.com'], bareOk: true },
  Adjust: { strong: ['com.adjust', 'adjust.com', 'adjust.io', 'adj.st'], bareOk: false },
  Branch: { strong: ['io.branch', 'branch.io', 'bnc.lt', 'app.link'], bareOk: false },
  Singular: { strong: ['com.singular', 'singular.net', 'sng.link'], bareOk: false },
};
// Слова, рядом с которыми голое имя перестаёт быть случайным.
const CONTEXT = /(sdk|attribution|attribute|mmp|analytics|tracking|tracker|third[\s-]?party|measurement|deep\s?link|install\s?referrer|advertising\s?partner|атрибуц|трекинг|трекер|аналитик|партн)/i;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildMatchers() {
  const attribution = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'apk-prefixes.json'), 'utf8')).attribution;
  const out = [];
  for (const human of new Set(Object.values(attribution))) {
    const rule = SDK_RULES[human] || { strong: [], bareOk: true };
    for (const s of rule.strong) out.push({ human, kind: 'strong', re: new RegExp(reEsc(s), 'i') });
    out.push({ human, kind: rule.bareOk ? 'name' : 'weak', re: new RegExp('\\b' + reEsc(human) + '\\b', 'i') });
  }
  return out;
}

// Возвращает [{ human, kind, snippet }]. Фрагмент нужен, чтобы находку можно было
// перепроверить, не ходя за текстом в интернет заново — раньше это было невозможно.
function scanText(text, matchers) {
  if (!text) return [];
  const hits = new Map();
  for (const m of matchers) {
    const found = m.re.exec(text);
    if (!found) continue;
    const at = found.index;
    const snippet = text.slice(Math.max(0, at - 70), at + found[0].length + 70).replace(/\s+/g, ' ').trim();
    if (m.kind === 'weak' && !CONTEXT.test(snippet)) continue;   // голое слово без контекста — не улика
    const prev = hits.get(m.human);
    if (!prev || (prev.kind !== 'strong' && m.kind === 'strong')) hits.set(m.human, { human: m.human, kind: m.kind, snippet });
  }
  return [...hits.values()];
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

    const descHits = scanText(`${card.summary || ''} ${card.description || ''}`, matchers);
    const matchedIn = descHits.length ? ['description'] : [];
    const allFound = new Set(descHits.map((h) => h.human));
    const evidence = descHits.map((h) => ({ where: 'description', sdk: h.human, kind: h.kind, snippet: h.snippet }));

    let privacyOk = null, privacyStatus = null;
    if (card.privacy_policy) {
      try {
        const r = await fetchPageText(card.privacy_policy);
        privacyOk = r ? (r.ok ? 1 : 0) : null;
        privacyStatus = r ? r.status : null;
        if (r && r.ok && r.text) {
          privacyFetched++;
          const pf = scanText(r.text, matchers);
          if (pf.length) {
            matchedIn.push('privacy_policy');
            pf.forEach((h) => { allFound.add(h.human); evidence.push({ where: 'privacy_policy', sdk: h.human, kind: h.kind, snippet: h.snippet }); });
          }
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
    // Фрагменты кладутся в note: находка должна быть перепроверяемой без повторного
    // похода за текстом — именно этого не хватало, когда метка держалась на слове.
    ins.run(appId, date, foundList.length ? 1 : 0, foundList.join(', ') || null, matchedIn.join(',') || null,
      card.privacy_policy || null, privacyOk, privacyStatus, adIdShared, purposes,
      evidence.length ? JSON.stringify(evidence).slice(0, 4000) : null);

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
