// Кандидаты в новые темы: спрос, который ни одна из заведённых ниш не покрывает.
//
// 72 концепта заведены руками, и вопрос «что мы не видим» до сих пор решался тоже руками.
// Здесь он решается измерением: берутся ключи с замеренным спросом, выбрасываются те, что
// уже в ядре какой-нибудь ниши, и остаток чистится от навигационных.
//
// Чистка нужна жёстко. В сыром остатке США первая дюжина по спросу — instagram, duolingo,
// call of duty, soundcloud: это не темы, куда заходят, а названия. Готовый признак бренда
// в выгрузке ненадёжен — он метит instagram, но пропускает grok, workday и photoshop,
// поэтому рядом стоит вторая проверка: совпадение ключа с названием реального приложения
// из нашей же базы. Она ловит ровно тот класс, который признак бренда упускает.
//
// Что это НЕ делает: не объединяет ключи в темы. Для этого нужна своя выдача по ключу, а она
// есть лишь у 12 из 386 непокрытых ключей США — съём по ним не велся, потому что съём идёт
// по ядрам заведённых ниш. Поэтому вывод инструмента — список на съём, а не готовые темы.
import { db } from '../src/lib/db.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const GEO = args.geo || 'US';
const LIMIT = Number(args.limit || 40);

const d = db();

// Названия приложений: ключ, совпавший с названием, почти наверняка навигационный.
const titles = new Set(d.prepare(`SELECT LOWER(TRIM(title)) t FROM apps WHERE title IS NOT NULL`)
  .all().map((r) => r.t).filter(Boolean));

const rows = d.prepare(`
  SELECT h.keyword, h.daily_impressions imp, h.difficulty dif, h.brand_app brand, h.apps_ranked apps
    FROM (SELECT geo, keyword, MAX(snapshot_date) d FROM raw_external_keyword_hist WHERE geo=? GROUP BY keyword) l
    JOIN raw_external_keyword_hist h ON h.geo=? AND h.keyword=l.keyword AND h.snapshot_date=l.d
   WHERE h.daily_impressions > 0
     AND NOT EXISTS (SELECT 1 FROM keyword_cores c WHERE c.geo=? AND c.keyword=h.keyword AND c.active=1)
   ORDER BY h.daily_impressions DESC`).all(GEO, GEO, GEO);

const byBrand = rows.filter((r) => r.brand);
const byTitle = rows.filter((r) => !r.brand && titles.has(r.keyword.trim().toLowerCase()));
const left = rows.filter((r) => !r.brand && !titles.has(r.keyword.trim().toLowerCase()));

const sum = (a) => Math.round(a.reduce((s, r) => s + r.imp, 0));
const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + ' %' : '—');
const total = sum(rows);

console.log(`Непокрытый спрос, ${GEO}: ${rows.length} ключей, ${total.toLocaleString('ru')} показов в день`);
console.log(`  отсеяно как бренд из выгрузки : ${byBrand.length} ключей, ${sum(byBrand).toLocaleString('ru')} (${pct(sum(byBrand), total)})`);
console.log(`  отсеяно по совпадению с названием приложения: ${byTitle.length}, ${sum(byTitle).toLocaleString('ru')} (${pct(sum(byTitle), total)})`);
console.log(`  осталось кандидатов           : ${left.length} ключей, ${sum(left).toLocaleString('ru')} (${pct(sum(left), total)})`);
console.log('');
console.log(`Список на съём — ${Math.min(LIMIT, left.length)} самых крупных. Пока по ним нет своей выдачи,`);
console.log('сказать, тема это или ещё одно название, нельзя: отсев выше отбрасывает явные, не все.');
console.log('');
for (const r of left.slice(0, LIMIT)) {
  console.log(`  ${String(Math.round(r.imp)).padStart(7)}  ${r.keyword.slice(0, 46).padEnd(47)}` +
    `${r.dif != null ? 'сложность ' + Math.round(r.dif) : ''}`);
}
