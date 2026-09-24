#!/usr/bin/env node
// Импорт выгрузки Asodesk: объём спроса и сложность по ключам.
//   node tools/import-asodesk.js <файл.xlsx> --geo US [--date 2026-09-24]
//
// Что берём из файла: Daily Impressions (дневные показы запроса в сторе), Difficulty
// (0–100), Total Apps (сколько приложений ранжируется) и Brand App (какое приложение
// держит запрос). Даты в шапке файла не трогаем: 90 колонок с датами — это позиции
// приложения, к которому привязан аккаунт Asodesk, а не история спроса.
//
// Два правила, без которых импорт врёт.
//
// Первое: «Calculating» записывается нулём, но помечается отдельно (imp_status).
// Решение владельца данных от 25.09: по таким ключам трафика около нуля. В самих данных
// видно другое — у 663 строк сервис написал явный ноль и посчитал им сложность, число
// приложений и бренд, а у 1 653 строк с «Calculating» не посчитано ничего, то есть до них
// очередь не дошла. Обе версии проверяются второй выгрузкой: если те же ключи снова придут
// «Calculating», значит сервис их не считает именно из-за малого трафика. Пометка нужна
// ровно для этого — чтобы решение можно было пересмотреть, не переписывая данные.
//
// Второе: источник записывается явно. Это не выгрузка Google Play Console, а модель
// Asodesk — оценка, а не факт. Для решений её достаточно, но когда дойдёт до проверки
// предсказаний, калибровка «по внешней модели» и «по факту» дают разную точность, и
// смешивать их в журнале нельзя.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/lib/db.js';
import { log, warn } from '../src/lib/util.js';
import { readSheet, headerMap } from '../src/lib/xlsx.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const optOf = (name, def = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const geo = String(optOf('geo', 'US')).toUpperCase();
const date = optOf('date', new Date().toISOString().slice(0, 10));
const source = optOf('source', 'asodesk');

if (!file || !fs.existsSync(file)) { warn('нужен путь к .xlsx: node tools/import-asodesk.js <файл> --geo US'); process.exit(1); }

const rows = readSheet(file);
if (rows.length < 2) { warn('в листе нет строк'); process.exit(1); }
const h = headerMap(rows[0]);
const need = ['keyword'];
for (const n of need) if (!h[n]) { warn(`в шапке нет колонки «${n}»; есть: ${Object.keys(h).join(', ')}`); process.exit(1); }
const cImp = h['daily impressions'], cDif = h.difficulty, cApps = h['total apps'], cBrand = h['brand app'];

const num = (v) => (v != null && /^-?[\d.]+$/.test(String(v).trim()) ? Number(v) : null);
const d = db();

const insHist = d.prepare(
  `INSERT INTO raw_external_keyword_hist
     (geo, keyword, snapshot_date, source, daily_impressions, difficulty, apps_ranked, brand_app, imported_at, imp_status)
   VALUES (?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT (geo, keyword, snapshot_date, source) DO UPDATE SET
     daily_impressions=excluded.daily_impressions, difficulty=excluded.difficulty,
     apps_ranked=excluded.apps_ranked, brand_app=excluded.brand_app, imported_at=excluded.imported_at,
     imp_status=excluded.imp_status`
);
// Текущее значение. Пустое (ещё не посчитанное) поле не затирает уже известное:
// COALESCE берёт новое, если оно есть, и оставляет старое, если нет.
const insCur = d.prepare(
  `INSERT INTO raw_external_keyword_planner
     (geo, keyword, avg_monthly_searches, imported_at, daily_impressions, competition_index,
      apps_ranked, brand_app, source, measured_at, imp_status)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT (geo, keyword) DO UPDATE SET
     avg_monthly_searches=COALESCE(excluded.avg_monthly_searches, avg_monthly_searches),
     daily_impressions=COALESCE(excluded.daily_impressions, daily_impressions),
     competition_index=COALESCE(excluded.competition_index, competition_index),
     apps_ranked=COALESCE(excluded.apps_ranked, apps_ranked),
     brand_app=COALESCE(excluded.brand_app, brand_app),
     source=excluded.source, imp_status=excluded.imp_status,
     measured_at=CASE WHEN excluded.avg_monthly_searches IS NOT NULL THEN excluded.measured_at ELSE measured_at END,
     imported_at=excluded.imported_at`
);

const now = new Date().toISOString().slice(0, 10);
let seen = 0, withImp = 0, withDif = 0, zero = 0, calculating = 0, brands = 0;

d.transaction(() => {
  for (const r of rows.slice(1)) {
    const kw = (r[h.keyword] || '').toLowerCase().trim();
    if (!kw) continue;
    seen++;
    const imp = cImp ? num(r[cImp]) : null;
    const dif = cDif ? num(r[cDif]) : null;
    const apps = cApps ? num(r[cApps]) : null;
    const brand = cBrand ? (r[cBrand] || null) : null;
    if (imp == null && cImp && r[cImp]) calculating++;
    if (imp != null) { withImp++; if (imp === 0) zero++; }
    if (dif != null) withDif++;
    if (brand) brands++;
    // «Calculating» — ноль по решению владельца данных, но со своей пометкой.
    const pending = imp == null && cImp && r[cImp];
    const impOut = imp != null ? imp : (pending ? 0 : null);
    const status = imp != null ? 'measured' : (pending ? 'calculating' : null);
    if (impOut == null && dif == null && apps == null && !brand) continue;
    insHist.run(geo, kw, date, source, impOut, dif, apps, brand, now, status);
    // Месячный объём — дневные показы × 30: поле в таблице месячное, а сервис даёт дневное.
    insCur.run(geo, kw, impOut == null ? null : Math.round(impOut * 30), now, impOut, dif, apps, brand, source, date, status);
  }
})();

log(`Asodesk → ${geo}, снимок ${date}, файл ${path.basename(file)}`);
log(`  строк ${seen}: объём измерен у ${withImp} (из них нулевых ${zero}), «Calculating» принято за ноль у ${calculating}, сложность у ${withDif}, бренд держит запрос у ${brands}`);

const core = d.prepare(`SELECT COUNT(DISTINCT keyword) n FROM keyword_cores WHERE geo=? AND active=1`).get(geo).n;
const covered = d.prepare(
  `SELECT COUNT(DISTINCT c.keyword) n FROM keyword_cores c
     JOIN raw_external_keyword_planner p ON p.geo=c.geo AND p.keyword=c.keyword
    WHERE c.geo=? AND c.active=1 AND p.daily_impressions IS NOT NULL`
).get(geo).n;
const real = d.prepare(
  `SELECT COUNT(DISTINCT c.keyword) n FROM keyword_cores c
     JOIN raw_external_keyword_planner p ON p.geo=c.geo AND p.keyword=c.keyword
    WHERE c.geo=? AND c.active=1 AND p.imp_status='measured'`
).get(geo).n;
const alive = d.prepare(
  `SELECT COUNT(DISTINCT c.keyword) n FROM keyword_cores c
     JOIN raw_external_keyword_planner p ON p.geo=c.geo AND p.keyword=c.keyword
    WHERE c.geo=? AND c.active=1 AND p.daily_impressions > 0`
).get(geo).n;
log(`  ядро ${geo}: ${core} ключей, значение есть у ${covered} (${core ? Math.round(covered / core * 100) : 0} %), из них измерено ${real}, с ненулевым спросом ${alive}`);

const snaps = d.prepare(`SELECT snapshot_date, COUNT(*) n FROM raw_external_keyword_hist WHERE geo=? GROUP BY snapshot_date ORDER BY snapshot_date`).all(geo);
log(`  снимков по ${geo}: ${snaps.map((s) => `${s.snapshot_date} (${s.n})`).join(', ')}`);
if (snaps.length < 2) log('  тренд спроса появится со второй выгрузки — сравнивать пока не с чем');
