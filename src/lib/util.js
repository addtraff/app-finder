import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function todayUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
export function daysAgoUTC(n, from = new Date()) {
  return new Date(from.getTime() - n * 86400000).toISOString().slice(0, 10);
}
export function daysBetween(aIso, bIso) {
  return (Date.parse(bIso) - Date.parse(aIso)) / 86400000;
}

export function md5(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

// ---- статистика ----
// Линейная интерполяция, как в numpy.percentile. Пустой вход -> null (принцип "пусто, а не ноль").
export function quantile(values, q) {
  const a = values.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function quantileSet(values) {
  const a = values.filter((v) => v != null && Number.isFinite(v));
  if (!a.length) return null;
  return {
    p01: quantile(a, 0.01), p10: quantile(a, 0.10), p25: quantile(a, 0.25),
    p50: quantile(a, 0.50), p75: quantile(a, 0.75), p90: quantile(a, 0.90),
    p95: quantile(a, 0.95), p99: quantile(a, 0.99), n: a.length,
  };
}

export const clamp = (x, lo = 0, hi = 1) => (x == null || !Number.isFinite(x) ? null : Math.max(lo, Math.min(hi, x)));

// norm(x, lo, hi) -> 0..1. Если lo==hi или что-то пусто — null, не 0.
export function norm(x, lo, hi) {
  if (x == null || lo == null || hi == null) return null;
  if (!Number.isFinite(x) || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (hi === lo) return null;
  return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
}

export function median(values) {
  return quantile(values, 0.5);
}

export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---- union-find для D8 ----
export class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) { this.p.set(x, x); return x; }
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const nx = this.p.get(x); this.p.set(x, r); x = nx; }
    return r;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
  groups() {
    const g = new Map();
    for (const k of this.p.keys()) {
      const r = this.find(k);
      if (!g.has(r)) g.set(r, []);
      g.get(r).push(k);
    }
    return [...g.values()];
  }
}

// ---- лог ----
const t0 = Date.now();
export function log(...args) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  console.log(`[${s}s]`, ...args);
}
export function warn(...args) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  console.warn(`[${s}s] !`, ...args);
}

export function parseSizeMb(sizeText) {
  if (!sizeText || typeof sizeText !== 'string') return null;
  const m = sizeText.replace(',', '.').match(/([\d.]+)\s*(k|m|g)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return unit === 'k' ? v / 1024 : unit === 'g' ? v * 1024 : v;
}

// "$1.99 - $49.99 per item" -> {min, max} в валюте карточки
export function parseIapRange(text) {
  if (!text || typeof text !== 'string') return { min: null, max: null };
  const nums = [...text.matchAll(/([\d]+[.,]?[\d]*)/g)].map((m) => parseFloat(m[1].replace(',', '.')));
  if (!nums.length) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}
