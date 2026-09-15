// Локальный сервис объёма поиска: node src/kw.js serve [--port 8790]
//
// Та же страница, что в артефакте, но живая: данные собираются из базы на каждый запрос,
// а в панели фразы работают «Оценить» (снимает префиксы новой фразы в Play) и «Отслеживать».
// Слушает только 127.0.0.1. Запросы к Play идут строго по очереди — тем же темпом, что у радара.
import http from 'node:http';
import { log, warn, todayUTC, md5 } from './lib/util.js';
import { kwDb, normTerm } from './lib/kw/schema.js';
import { packRows } from './lib/pack.js';
import { collect, render } from './stages/kw-report.js';
import * as signals from './stages/kw-signals.js';
import * as metrics from './stages/kw-metrics.js';

let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(new Error('тело запроса — не JSON')); } });
    req.on('error', reject);
  });
}

const send = (res, code, type, payload) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
};
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

export async function serve({ port = 8790 } = {}) {
  const d = kwDb();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const date = todayUTC();
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const page = render(collect(date), { live: true });
        return send(res, 200, 'text/html; charset=utf-8',
          `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${page}</body></html>`);
      }
      if (req.method === 'GET' && url.pathname === '/api/data') {
        return json(res, 200, packRows(collect(date)));
      }
      if (req.method === 'POST' && url.pathname === '/api/estimate') {
        const { geo, term } = await body(req);
        const t = normTerm(term);
        if (!geo || !t) return json(res, 400, { error: 'нужны geo и term' });
        if (Array.from(t).length > 60) return json(res, 400, { error: 'фраза длиннее 60 символов' });
        const out = await serial(async () => {
          const runId = `${date}-serve-${md5(String(Date.now())).slice(0, 6)}`;
          log(`оценка «${t}» ${geo}`);
          const r = await signals.run({ geo, date, runId, terms: [t], mode: 'binary', force: true });
          await metrics.run({ geo, date });
          return r;
        });
        if (out.stoppedBy) return json(res, 503, { error: out.stoppedBy });
        if (out.errors) return json(res, 502, { error: 'Play не ответил на часть префиксов — попробуйте позже' });
        return json(res, 200, { term: t, requests: out.stats.requests });
      }
      if (req.method === 'POST' && url.pathname === '/api/watch') {
        const { geo, term } = await body(req);
        const t = normTerm(term);
        if (!geo || !t) return json(res, 400, { error: 'нужны geo и term' });
        d.prepare(`INSERT OR IGNORE INTO kw_watch (geo, term, added_at, note) VALUES (?,?,?,?)`).run(geo, t, date, 'из сервиса');
        // Отслеживаемое слово считается полным способом; пересчёт — на следующем run, без запросов сейчас.
        d.prepare(`UPDATE kw_signals SET tracked=1 WHERE geo=? AND keyword_id=(SELECT keyword_id FROM keywords WHERE term=?)`).run(geo, t);
        return json(res, 200, { ok: true });
      }
      send(res, 404, 'text/plain; charset=utf-8', 'нет такой страницы');
    } catch (e) {
      warn(`сервис: ${e.message}`);
      json(res, 500, { error: e.message });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  log(`объём поиска: http://127.0.0.1:${port}/  (Ctrl+C — остановить)`);
  return server;
}
