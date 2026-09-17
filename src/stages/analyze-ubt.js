// УБТ (условно-бесплатный трафик) — косвенный признак по отзывам: упоминания TikTok, YouTube,
// Instagram/Reels, блогеров и фразы-источники вида «увидел в тиктоке». Словарь и версия —
// config/ubt-lexicon.json. Метки пишутся в review_labels: ubt_platform (названа площадка)
// и ubt_phrase (фраза-источник). «Ничего не найдено» не пишется — прогресс хранится водяным
// знаком по rowid в label_progress, поэтому повторный запуск берёт только новые отзывы.
// Разметка общая для всех гео: стадия в плане каждого гео, но работу делает первый вызов дня.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, startRun, finishRun } from '../lib/db.js';
import { log } from '../lib/util.js';

export function ubtLexicon() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ubt-lexicon.json'), 'utf8'));
}

function matchers(lex) {
  const common = lex.common_platforms.map((s) => new RegExp(s, 'iu'));
  const out = new Map();
  for (const [lang, v] of Object.entries(lex.languages)) {
    out.set(lang, {
      platforms: [...common, ...v.platforms.map((s) => new RegExp(s, 'iu'))],
      phrases: v.phrases.map((s) => new RegExp(s, 'iu')),
    });
  }
  return out;
}

export async function run({ geo, date, runId, cycle = 'daily' }) {
  const d = db();
  startRun(runId, 'analyze-ubt', geo, cycle, date);
  const lex = ubtLexicon();
  const version = lex.version;
  const m = matchers(lex);
  const from = d.prepare(`SELECT max_rowid FROM label_progress WHERE classifier_version=?`).get(version)?.max_rowid || 0;
  const to = d.prepare(`SELECT MAX(rowid) m FROM raw_reviews`).get()?.m || 0;
  if (to <= from) {
    finishRun(runId, 'analyze-ubt', geo, { notes: `новых отзывов нет (до rowid ${from})` });
    return { scanned: 0, phrase: 0, platform: 0 };
  }

  const ins = d.prepare(`INSERT OR IGNORE INTO review_labels (review_id, label, classifier_version) VALUES (?,?,?)`);
  const setProgress = d.prepare(`INSERT OR REPLACE INTO label_progress (classifier_version, max_rowid, updated_at) VALUES (?,?,?)`);
  const page = d.prepare(`SELECT rowid AS rid, review_id, lang, text FROM raw_reviews WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 20000`);
  let cursor = from, scanned = 0, phrase = 0, platform = 0;
  const t0 = Date.now();
  for (;;) {
    const rows = page.all(cursor, to);
    if (!rows.length) break;
    d.transaction(() => {
      for (const r of rows) {
        const text = r.text;
        if (text) {
          const mm = m.get(String(r.lang || 'en').split('-')[0]) || m.get('en');
          if (mm.phrases.some((re) => re.test(text))) { ins.run(r.review_id, 'ubt_phrase', version); phrase++; }
          if (mm.platforms.some((re) => re.test(text))) { ins.run(r.review_id, 'ubt_platform', version); platform++; }
        }
        scanned++;
      }
      cursor = rows[rows.length - 1].rid;
      setProgress.run(version, cursor, new Date().toISOString());
    })();
    if (scanned % 200000 < 20000) log(`  УБТ-разметка: ${scanned} отзывов, фраз ${phrase}, площадок ${platform}`);
  }
  const notes = `${scanned} отзывов за ${((Date.now() - t0) / 1000).toFixed(0)} с; фраза-источник ${phrase}, площадка ${platform}; версия ${version}`;
  finishRun(runId, 'analyze-ubt', geo, { notes });
  log(`  УБТ-разметка: ${notes}`);
  return { scanned, phrase, platform };
}
