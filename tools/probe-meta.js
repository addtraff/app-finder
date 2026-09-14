// Диагностика Meta Ad Library: почему check-ads находит рекламу у 5 приложений из 2555.
// Открывает библиотеку по нескольким запросам заведомых рекламодателей, ждёт с нарастанием,
// и считает, в какой форме на странице лежат ссылки на Play: сырой, с экранированными
// слешами из встроенного JSON, URL-кодированной через редирект l.facebook.com.
// Отдельный браузер без постоянного профиля — не мешает идущему check-ads.
//
//   node tools/probe-meta.js "idealista" "Gin Rummy" "UPDF PDF"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'meta-probe');
fs.mkdirSync(OUT, { recursive: true });

const queries = process.argv.slice(2);
if (!queries.length) queries.push('idealista', 'Gin Rummy', 'UPDF PDF', 'Photoroom', 'Remini');

const PATTERNS = {
  raw: /store\/apps\/details\?id=([A-Za-z0-9_.]+)/g,
  escaped: /store\\\/apps\\\/details\?id=([A-Za-z0-9_.]+)/g,
  urlencoded: /store%2Fapps%2Fdetails%3Fid%3D([A-Za-z0-9_.]+)/gi,
  double_encoded: /store%252Fapps%252Fdetails%253Fid%253D([A-Za-z0-9_.]+)/gi,
  any_id_param: /details(?:\?|%3F|\\u003F)id(?:=|%3D|\\u003D)([A-Za-z0-9_.]{3,})/gi,
};

function count(html) {
  const out = {};
  for (const [name, re] of Object.entries(PATTERNS)) {
    const ids = [...html.matchAll(re)].map((m) => m[1]);
    out[name] = { hits: ids.length, uniq: [...new Set(ids)].slice(0, 6) };
  }
  out.library_id_marks = (html.match(/Library ID|ID библиотеки|ID in der Bibliothek/g) || []).length;
  out.play_domain_text = (html.match(/play\.google\.com/gi) || []).length;
  out.login_wall = /log in to continue|войдите|anmelden, um fortzufahren/i.test(html);
  out.cookie_dialog = /allow (all )?cookies|разрешить (все )?файлы cookie|cookies erlauben/i.test(html);
  out.no_results = /no ads match|нет рекламы|keine werbeanzeigen/i.test(html);
  return out;
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

// Ответы GraphQL, в которых упоминается Play: это видно, даже если в DOM ссылки нет.
const gql = [];
page.on('response', async (res) => {
  if (!/\/api\/graphql|\/ads\/library\/async/.test(res.url())) return;
  try {
    const body = await res.text();
    if (/play\.google\.com|store\\?\/apps/i.test(body)) gql.push({ url: res.url().slice(0, 120), len: body.length, sample: count(body) });
  } catch { /* тело недоступно — пропускаем */ }
});

const report = [];
for (const q of queries) {
  const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&q=${encodeURIComponent(q)}&media_type=all`;
  const withSearchType = `${url}&search_type=keyword_unordered`;
  for (const [variant, target] of [['as_in_check_ads', url], ['search_type', withSearchType]]) {
    gql.length = 0;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const steps = {};
    for (const [label, ms] of [['2.5s', 2500], ['8s', 5500], ['15s', 7000]]) {
      await page.waitForTimeout(ms);
      steps[label] = count(await page.content());
    }
    // Прокрутка подгружает следующие карточки — проверяем, растёт ли число.
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(1200); }
    steps.after_scroll = count(await page.content());
    const file = path.join(OUT, `${q.replace(/[^\p{L}\p{N}]+/gu, '_')}-${variant}.html`);
    fs.writeFileSync(file, await page.content(), 'utf8');
    report.push({ query: q, variant, landed: page.url().slice(0, 140), steps, graphql_with_play: gql.slice(0, 5) });
    console.log(`\n=== ${q} [${variant}] ===`);
    for (const [label, s] of Object.entries(steps)) {
      console.log(`  ${label.padEnd(12)} карточек ${String(s.library_id_marks).padStart(3)} | play.google.com ${String(s.play_domain_text).padStart(3)} | ` +
        `raw ${s.raw.hits} esc ${s.escaped.hits} enc ${s.urlencoded.hits} dbl ${s.double_encoded.hits} any ${s.any_id_param.hits} ` +
        `| login ${s.login_wall} cookie ${s.cookie_dialog} empty ${s.no_results}`);
    }
    const any = steps.after_scroll.any_id_param.uniq;
    if (any.length) console.log(`  пакеты: ${any.join(', ')}`);
    console.log(`  graphql с Play: ${gql.length}`);
  }
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\nотчёт: out/meta-probe/report.json`);
await browser.close();
