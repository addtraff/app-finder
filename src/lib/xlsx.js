// Чтение .xlsx без зависимостей: книга — это zip, лист внутри — xml.
//
// Ставить ради одного формата стороннюю библиотеку не хочется: в проекте три зависимости,
// и каждая новая — это ещё один источник обновлений и уязвимостей в конвейере, который
// ходит в сеть. Нужного здесь мало: распаковать два файла из архива и вытащить значения
// ячеек, это полсотни строк на zlib из стандартной библиотеки.
//
// Читается центральный каталог архива, а не локальные заголовки: у файлов, записанных
// потоком, в локальном заголовке размеры стоят нулями, и по ним ничего не найти.
import fs from 'node:fs';
import zlib from 'node:zlib';

function unzip(file) {
  const buf = fs.readFileSync(file);
  // Хвост архива: сигнатура конца центрального каталога, ищем с конца.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('не похоже на zip: не найден конец центрального каталога');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // Локальный заголовок: длины имени и «extra» там свои, тело идёт сразу за ними.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + compSize);
    out.set(name, method === 0 ? body : zlib.inflateRawSync(body));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => (s == null ? null : s
  .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (m, e) => ENTITIES[e]));

// Строки листа как объекты {буква колонки: значение}. Числа остаются строками — решение,
// что считать числом, принимает вызывающий: у Asodesk в числовой колонке попадается слово
// «Calculating», и превращать его в ноль нельзя.
export function readSheet(file, sheetPath = null) {
  const files = unzip(file);
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    for (const m of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join(''));
    }
  }
  const path = sheetPath || [...files.keys()].find((k) => /^xl\/worksheets\/sheet1\.xml$/.test(k))
    || [...files.keys()].find((k) => /^xl\/worksheets\/.*\.xml$/.test(k));
  if (!path) throw new Error('в книге не найден лист');
  const xml = files.get(path).toString('utf8');

  const rows = [];
  for (const r of xml.split(/<row[ >]/).slice(1)) {
    const cells = {};
    for (const m of r.matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const [, col, attrs, body] = m;
      const t = /t="s"/.test(attrs);
      const inline = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      let val = null;
      if (t && v) val = shared[Number(v[1])] ?? null;
      else if (inline) val = decode(inline[1]);
      else if (v) val = decode(v[1]);
      if (val != null && val !== '') cells[col] = val;
    }
    if (Object.keys(cells).length) rows.push(cells);
  }
  return rows;
}

// Заголовок → {название колонки: буква}. Сравнение без регистра и лишних пробелов.
export function headerMap(row) {
  const map = {};
  for (const [col, name] of Object.entries(row)) map[String(name).trim().toLowerCase()] = col;
  return map;
}
