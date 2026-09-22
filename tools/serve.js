// Локальный просмотр отчёта: node tools/serve.js [порт]
// По основному адресу отдаётся полная версия из out/full — она без отсечки строк, ради неё
// локальный просмотр и нужен. Версия с отсечкой (та, что уходит в артефакт) — /capped/<файл>.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const PORT = Number(process.argv[2] || 8777);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'appradar2.html';
  const capped = rel.startsWith('capped/');
  const name = capped ? rel.slice(7) : rel;
  const full = path.join(ROOT, 'full', name);
  const file = !capped && fs.existsSync(full) ? full : path.join(ROOT, name);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('нет файла: ' + rel);
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`полный отчёт на http://localhost:${PORT}/appradar2.html, с отсечкой — /capped/appradar2.html`));
