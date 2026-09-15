// 10.1. Регекс-классификатор отзывов: пять типов жалоб (money / ads / broken / missing / trust),
// источник прихода, missing_language, повторное использование против одного сеанса.
// Метки пишутся с версией классификатора — переразметка задним числом возможна.
import { db, startRun, finishRun } from '../lib/db.js';
import { config, geoConf } from '../lib/config.js';
import { log } from '../lib/util.js';

const PAIN = ['money', 'ads', 'broken', 'missing', 'trust'];
const OTHER = ['crash', 'src_ugc', 'src_friend', 'src_store', 'src_ads', 'missing_language', 'repeat_use', 'single_session'];

function buildMatchers(lexicon) {
  const out = new Map();
  for (const [lang, cats] of Object.entries(lexicon.categories)) {
    const m = new Map();
    for (const [cat, words] of Object.entries(cats)) {
      const parts = words.map((w) => (/[\\|()\[\]{}+?^$]/.test(w) ? w : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      m.set(cat, new RegExp(`(${parts.join('|')})`, 'iu'));
    }
    out.set(lang, m);
  }
  return out;
}

export async function run({ geo, date, runId, cycle = 'discovery', force = false }) {
  const d = db();
  startRun(runId, 'analyze-pain', geo, cycle, date);
  const lex = config().lexicon;
  const version = lex.version;
  const matchers = buildMatchers(lex);

  // Отзывы — по языкам гео, как их агрегирует score: отзыв хранится под гео, где его сняли
  // первым, и разметка «только своих» оставляла строки того же языка из других гео без меток.
  const langs = geoConf(geo).review_langs;
  const langIn = `lang IN (${langs.map(() => '?').join(',')})`;
  const rows = force
    ? d.prepare(`SELECT review_id, lang, text, rating FROM raw_reviews WHERE ${langIn}`).all(...langs)
    : d.prepare(
        `SELECT r.review_id, r.lang, r.text, r.rating FROM raw_reviews r
          WHERE r.${langIn} AND NOT EXISTS (
            SELECT 1 FROM review_labels l WHERE l.review_id=r.review_id AND l.classifier_version=?)`
      ).all(...langs, version);

  const ins = d.prepare(`INSERT OR IGNORE INTO review_labels (review_id, label, classifier_version) VALUES (?,?,?)`);
  let labeled = 0, marks = 0;

  const chunk = 2000;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    d.transaction(() => {
      for (const r of slice) {
        const m = matchers.get(r.lang) || matchers.get('en');
        const text = r.text || '';
        if (!text) { ins.run(r.review_id, 'empty', version); labeled++; continue; }
        let any = false;
        for (const [cat, re] of m) {
          // Пять типов жалоб считаются только по негативным отзывам (1–3★).
          if (PAIN.includes(cat) && !(r.rating != null && r.rating <= 3)) continue;
          if (re.test(text)) { ins.run(r.review_id, cat, version); marks++; any = true; }
        }
        // Шаблонность: 5★ короче 30 символов.
        if (r.rating === 5 && text.trim().length < 30) { ins.run(r.review_id, 'template_short', version); marks++; any = true; }
        if (!any) ins.run(r.review_id, 'unclassified', version);
        labeled++;
      }
    })();
    if (i && i % 10000 === 0) log(`  разметка: ${i}/${rows.length}`);
  }

  finishRun(runId, 'analyze-pain', geo, { notes: `${labeled} отзывов, ${marks} меток, версия ${version}` });
  log(`  ${geo}: размечено ${labeled} отзывов (${marks} меток), классификатор ${version}`);
  return { labeled, marks, version };
}

export { PAIN, OTHER };
