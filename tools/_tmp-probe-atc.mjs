// Разовая проба: SearchSuggestions по имени и SearchCreatives по рекламодателю.
import path from 'node:path';
import fs from 'node:fs';
const { chromium } = await import('playwright');
const PROFILE_DIR = process.env.RADAR_BROWSER_PROFILE ||
  path.join(process.env.LOCALAPPDATA || process.env.HOME, 'play-radar', 'browser-profile');
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, locale: 'en-US', viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const seen = [];
page.on('request', (r) => { if (r.url().includes('/rpc/')) seen.push({ url: r.url().replace(/\?.*$/, ''), body: r.postData() }); });
await page.goto('https://adstransparency.google.com/?region=anywhere', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const rpc = (url, req) => page.evaluate(async ({ url, req }) => {
  const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'f.req=' + encodeURIComponent(req) });
  return { status: r.status, text: (await r.text()).slice(0, 3000) };
}, { url, req });
const S = 'https://adstransparency.google.com/anji/_/rpc/SearchService/SearchSuggestions';
const out = {};
for (const name of ['Codeway', 'Canva', 'Smart Tools', 'Simple Design Ltd', 'AppTitude Technologies']) {
  out[name] = await rpc(S, JSON.stringify({ 1: name, 2: 10, 3: 10, 5: { 1: 1 } }));
  await page.waitForTimeout(1500);
}
// Перехват настоящего запроса объявлений рекламодателя: вводим имя и открываем первую подсказку.
const input = await page.$('input');
if (input) {
  await input.click(); await input.type('Codeway', { delay: 90 });
  await page.waitForTimeout(3000);
  const opt = await page.$('[role="option"], material-select-item, .suggestion, li');
  if (opt) { await opt.click(); await page.waitForTimeout(6000); }
}
out.creativesRequests = seen.filter((s) => /SearchCreatives|GetAdvertiser/i.test(s.url)).slice(-4);
out.pageUrl = page.url();
fs.writeFileSync(path.join(process.cwd(), 'out', 'atc-suggest-probe.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
await ctx.close();
