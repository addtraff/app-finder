// Минимальный читатель ZIP: APK — это ZIP. Нужен список записей и распаковка отдельных
// файлов. Внешних зависимостей нет, декомпиляции нет — только состав архива.
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CDIR = 0x02014b50;
const LOCAL = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

export function listEntries(filePath) {
  const buf = fs.readFileSync(filePath);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('не ZIP: не найден конец центрального каталога');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CDIR) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

export function readEntry(buf, entry) {
  const off = entry.localOffset;
  if (buf.readUInt32LE(off) !== LOCAL) throw new Error(`битая запись ${entry.name}`);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`метод сжатия ${entry.method} не поддержан (${entry.name})`);
}
