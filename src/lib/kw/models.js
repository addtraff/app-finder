// Калибровка (разделы 6–8): изотоническая регрессия, квантильный бустинг, кривая CTR, бакеты.
//
// Всё на чистом JS, без Python: объёмы обучения здесь — сотни и тысячи строк (6.1–6.2),
// а модель должна храниться в той же базе, что и сигналы, и применяться той же стадией.
import { quantile, spearman } from '../util.js';

// ---------- 6.1 изотоническая регрессия (PAV) ----------
// Монотонно неубывающая зависимость y от x. Порядок слов никогда не нарушается — ровно то,
// что нужно пользователю, выбирающему между двумя словами.
export function isotonicFit(xs, ys, ws = null) {
  const pts = xs.map((x, i) => ({ x, y: ys[i], w: ws ? ws[i] : 1 }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.w > 0)
    .sort((a, b) => a.x - b.x);
  // Равные x сливаются заранее: у функции одно значение в точке.
  const merged = [];
  for (const p of pts) {
    const last = merged[merged.length - 1];
    if (last && last.x === p.x) { last.sy += p.y * p.w; last.w += p.w; }
    else merged.push({ x: p.x, sy: p.y * p.w, w: p.w });
  }
  const blocks = [];
  for (const p of merged) {
    blocks.push({ xMin: p.x, xMax: p.x, sy: p.sy, w: p.w });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sy / a.w < b.sy / b.w) break;   // равные соседние блоки тоже сливаются: функция та же, модель короче
      blocks.splice(blocks.length - 2, 2, { xMin: a.xMin, xMax: b.xMax, sy: a.sy + b.sy, w: a.w + b.w });
    }
  }
  return { kind: 'isotonic', blocks: blocks.map((b) => [b.xMin, b.xMax, b.sy / b.w, b.w]) };
}

// Внутри блока — его значение, между блоками — линейно, за краями — крайнее значение.
export function isotonicPredict(model, x) {
  const B = model.blocks;
  if (!B.length || !Number.isFinite(x)) return null;
  if (x <= B[0][1]) return B[0][2];
  for (let k = 1; k < B.length; k++) {
    const [xMin, xMax, y] = B[k];
    if (x < xMin) {
      const [, pxMax, py] = B[k - 1];
      return py + (y - py) * (x - pxMax) / (xMin - pxMax);
    }
    if (x <= xMax) return y;
  }
  return B[B.length - 1][2];
}

// ---------- 6.2 квантильный градиентный бустинг ----------
// Гистограммные деревья (как HistGradientBoostingRegressor): признаки режутся на bins
// квантильных корзин, пропуск — отдельная корзина, которая уходит в ту сторону сплита,
// где выигрыш больше. Потеря — pinball на квантиле alpha: псевдоостаток alpha или alpha−1,
// значение листа — alpha-квантиль остатков в листе (шаг Ньютона для pinball не определён).
function binEdges(values, bins) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [];
  const edges = [];
  for (let k = 1; k < bins; k++) {
    const e = v[Math.min(v.length - 1, Math.floor((k * v.length) / bins))];
    if (!edges.length || e > edges[edges.length - 1]) edges.push(e);
  }
  return edges;
}

// 0 — пропуск; 1..edges.length+1 — корзины (x < edges[0] -> 1).
function binOf(edges, x) {
  if (x == null || !Number.isFinite(x)) return 0;
  let lo = 0, hi = edges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x < edges[mid]) hi = mid; else lo = mid + 1; }
  return lo + 1;
}

export function gbmFit(X, y, { alpha = 0.5, nEstimators = 300, learningRate = 0.05, maxDepth = 3, minLeaf = 20, bins = 32 } = {}) {
  const n = y.length;
  const p = n ? X[0].length : 0;
  const edges = [];
  const B = [];
  for (let j = 0; j < p; j++) {
    const col = X.map((row) => row[j]);
    const e = binEdges(col, bins);
    edges.push(e);
    B.push(Uint16Array.from(col, (x) => binOf(e, x)));
  }
  const init = quantile(y, alpha);
  const F = new Float64Array(n).fill(init);
  const g = new Float64Array(n);
  const trees = [];

  const leaf = (idx) => {
    const r = idx.map((i) => y[i] - F[i]);
    return { v: quantile(r, alpha) ?? 0, idx };
  };

  const build = (idx, depth) => {
    if (depth >= maxDepth || idx.length < 2 * minLeaf) return leaf(idx);
    let S = 0;
    for (const i of idx) S += g[i];
    const N = idx.length;
    let best = null;
    for (let j = 0; j < p; j++) {
      const nb = edges[j].length + 2;
      const sum = new Float64Array(nb), cnt = new Uint32Array(nb);
      const col = B[j];
      for (const i of idx) { sum[col[i]] += g[i]; cnt[col[i]]++; }
      const missS = sum[0], missN = cnt[0];
      let cumS = 0, cumN = 0;
      for (let t = 1; t < nb - 1; t++) {
        cumS += sum[t]; cumN += cnt[t];
        for (const missLeft of [false, true]) {
          const lS = cumS + (missLeft ? missS : 0), lN = cumN + (missLeft ? missN : 0);
          const rS = S - lS, rN = N - lN;
          if (lN < minLeaf || rN < minLeaf) continue;
          const gain = (lS * lS) / lN + (rS * rS) / rN - (S * S) / N;
          if (!best || gain > best.gain + 1e-12) best = { j, t, missLeft, gain };
        }
      }
    }
    if (!best || best.gain <= 1e-12) return leaf(idx);
    const L = [], R = [];
    const col = B[best.j];
    for (const i of idx) {
      const b = col[i];
      ((b === 0 ? best.missLeft : b <= best.t) ? L : R).push(i);
    }
    return { j: best.j, t: best.t, m: best.missLeft ? 1 : 0, l: build(L, depth + 1), r: build(R, depth + 1) };
  };

  // Лист хранит индексы строк только на время обучения, в модель уходит значение.
  const strip = (node) => (node.idx ? { v: node.v } : { j: node.j, t: node.t, m: node.m, l: strip(node.l), r: strip(node.r) });
  const applyLeaves = (node) => {
    if (node.idx) { for (const i of node.idx) F[i] += learningRate * node.v; return; }
    applyLeaves(node.l); applyLeaves(node.r);
  };

  const all = Array.from({ length: n }, (_, i) => i);
  for (let m = 0; m < nEstimators; m++) {
    for (let i = 0; i < n; i++) g[i] = y[i] - F[i] > 0 ? alpha : alpha - 1;
    const tree = build(all, 0);
    applyLeaves(tree);
    trees.push(strip(tree));
  }
  return { kind: 'gbm', alpha, init, lr: learningRate, edges, trees };
}

export function gbmPredict(model, x) {
  let f = model.init;
  for (const tree of model.trees) {
    let node = tree;
    while (node.v === undefined) {
      const b = binOf(model.edges[node.j], x[node.j]);
      node = (b === 0 ? node.m === 1 : b <= node.t) ? node.l : node.r;
    }
    f += model.lr * node.v;
  }
  return f;
}

// ---------- 7 кривая CTR ----------
// CTR(p) = CTR₁ / p^α по наблюдениям (позиция, показы карточки, посетители):
// log CTR = log CTR₁ − α log p, МНК с весом = показы. Мало данных или позиций — приор.
export function fitCtrCurve(rows, { priorCtr1 = 0.28, priorAlpha = 0.9, minRows = 30, minPositions = 3 } = {}) {
  const obs = rows.filter((r) => r.position >= 1 && r.impressions > 0 && r.visitors > 0 && r.visitors <= r.impressions);
  const positions = new Set(obs.map((r) => r.position)).size;
  if (obs.length < minRows || positions < minPositions) {
    return { ctr1: priorCtr1, alpha: priorAlpha, n: obs.length, positions, source: 'prior' };
  }
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const r of obs) {
    const w = r.impressions, x = Math.log(r.position), yv = Math.log(r.visitors / r.impressions);
    sw += w; sx += w * x; sy += w * yv; sxx += w * x * x; sxy += w * x * yv;
  }
  const den = sw * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return { ctr1: priorCtr1, alpha: priorAlpha, n: obs.length, positions, source: 'prior' };
  const slope = (sw * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / sw;
  const alpha = Math.min(2, Math.max(0.3, -slope));
  const ctr1 = Math.min(1, Math.max(0.01, Math.exp(intercept)));
  return { ctr1, alpha, n: obs.length, positions, source: 'fit' };
}

export const ctrAt = (curve, position) => curve.ctr1 / Math.pow(Math.max(1, position), curve.alpha);

// ---------- 8 бакеты ----------
const BUCKET_LABELS = ['до 100', '100–500', '500–1К', '1–5К', '5–20К', '20–100К', 'свыше 100К'];
export function bucketIndex(monthly, edges = [100, 500, 1000, 5000, 20000, 100000]) {
  if (monthly == null || !Number.isFinite(monthly)) return null;
  let k = 0;
  while (k < edges.length && monthly >= edges[k]) k++;
  return k;
}
export const bucketLabel = (k) => (k == null ? null : `${BUCKET_LABELS[k]} в мес`);

// ---------- 6.3 метрики валидации ----------
export function validationMetrics(pairs, { edges } = {}) {
  // pairs: [{ pred, actual, app }] — дневные объёмы
  const ok = pairs.filter((p) => Number.isFinite(p.pred) && Number.isFinite(p.actual));
  const rho = ok.length >= 5 ? spearman(ok.map((p) => p.pred), ok.map((p) => p.actual)) : null;
  const hit = ok.length
    ? ok.filter((p) => bucketIndex(p.pred * 30, edges) === bucketIndex(p.actual * 30, edges)).length / ok.length
    : null;
  const byApp = new Map();
  for (const p of ok) {
    const a = byApp.get(p.app) || { pred: 0, actual: 0 };
    a.pred += p.pred; a.actual += p.actual;
    byApp.set(p.app, a);
  }
  const ratios = [...byApp.values()].filter((a) => a.actual > 0).map((a) => a.pred / a.actual);
  return { spearman: rho, bucket_hit: hit, sum_ratio: ratios.length ? quantile(ratios, 0.5) : null, n: ok.length };
}
