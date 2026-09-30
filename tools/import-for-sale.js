// Импорт витрины объявлений о продаже приложений.
//   node tools/import-for-sale.js <файл.xlsx> [--date 2026-09-30]
//
// Источник внешний и непроверяемый. Колонка «Органика» — это слова продавца, и ничего
// больше: сверить её с нашими данными нельзя, потому что две трети лотов на iOS, которого
// мы не собираем вовсе, а совпадение названий даёт однофамильцев, а не те же приложения.
// Проверка 30.09: из 45 объявлений «нашлось» 11, и все одиннадцать оказались чужими
// приложениями с похожим названием. Поэтому импорт кладёт заявление как заявление.
//
// Лист устроен разделами: строка из одной ячейки — заголовок раздела, дальше идут лоты.
// Внутри разделов встречается повторная шапка, её пропускаем. Смысл колонок I–L в разных
// разделах разный, поэтому «Органика» берётся только когда там слово, а не число.
import fs from 'node:fs';
import { db, ROOT } from '../src/lib/db.js';
import { readSheet } from '../src/lib/xlsx.js';
import { log, warn } from '../src/lib/util.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dateArg = (args.find((a) => a.startsWith('--date=')) || '').split('=')[1]
  || (args.includes('--date') ? args[args.indexOf('--date') + 1] : null);
const DATE = dateArg || new Date().toISOString().slice(0, 10);

if (!file || !fs.existsSync(file)) {
  warn('нужен путь к .xlsx: node tools/import-for-sale.js <файл> [--date 2026-09-30]');
  process.exit(1);
}

const num = (v) => {
  if (v == null || v === '' || String(v).trim() === 'н/д') return null;
  const n = Number(String(v).replace(/\s| /g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
// Заявление — только слово. Число в колонке «Органика» означает, что в этом разделе она не
// заполнялась и значение приехало из соседней: считать «18» заявлением об органике нельзя.
const word = (v) => {
  const s = String(v ?? '').trim();
  return s && !/^\d+([.,]\d+)?$/.test(s) ? s : null;
};
// Колонки «Подписки», «Data Verified» и «Балл» в разных разделах означают разное: в первом
// это «Да», в третьем — трёхзначные числа. Разобрать их мы не можем, поэтому сохраняем как
// есть и НЕ выводим в отчёт: подписать неизвестное число заголовком из шапки значило бы
// выдумать смысл. Сырьё лежит в базе — если смысл выяснится, выводить его не поздно.
const raw = (v) => { const s = String(v ?? '').trim(); return s || null; };

const rows = readSheet(file);
const d = db();
const ins = d.prepare(`INSERT OR REPLACE INTO apps_for_sale
  (snapshot_date, section, pos, title, platform, niche, revenue_month, profit_month, price,
   price_to_year_profit, organic_claim, subs_claim, verified, note, url, score, imported_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

let section = null, n = 0, skipped = 0;
const now = new Date().toISOString();
d.transaction(() => {
  for (const r of rows) {
    const filled = Object.values(r).filter((v) => String(v ?? '').trim()).length;
    if (filled <= 2 && r.A) { section = String(r.A).trim(); continue; }   // заголовок раздела
    if (!r.B || !r.G) { skipped++; continue; }
    if (String(r.B).trim() === 'Название') { skipped++; continue; }        // повторная шапка
    const price = num(r.G);
    if (price == null) { skipped++; continue; }
    ins.run(DATE, section, Number(r.A) || n + 1, String(r.B).trim(),
      word(r.C), word(r.D), num(r.E), num(r.F), price, num(r.H),
      word(r.I), raw(r.J), raw(r.K), word(r.L), raw(r.M), num(r.N), now);
    n++;
  }
})();

const stat = d.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT section) s,
    SUM(organic_claim IS NOT NULL) org, MIN(price) lo, MAX(price) hi
  FROM apps_for_sale WHERE snapshot_date=?`).get(DATE);
log(`  витрина продаж ${DATE}: лотов ${stat.n}, разделов ${stat.s}, с заявленной органикой ${stat.org}, ` +
    `цены ${Math.round(stat.lo).toLocaleString('ru')}–${Math.round(stat.hi).toLocaleString('ru')} $` +
    (skipped ? `, пропущено строк ${skipped}` : ''));
