// Ядро методики (раздел 4): popularity score из префиксной эмиссии подсказок Play.
//
//   score_raw(K) = Σ w_len(i) · w_pos(pos_i)   по префиксам K[0:i], где фраза есть в подсказках
//   w_len(i) = (L − i + 1) / L,   w_pos(p) = 1 / p^0.7
//
// Три способа снять лестницу префиксов (4.3):
//   exact  — все префиксы от min_prefix до min(L, 20);
//   binary — бинарный поиск минимального i, при котором фраза появляется: функция почти
//            монотонна, поэтому ~4–5 запросов вместо 13–18;
//   rough  — три префикса (начало, середина, конец) для разведочного словаря;
//   cache  — ни одного запроса, только то, что уже лежит в кэше.
//
// В binary и rough позиции на неснятых префиксах выводятся по снятым: берётся позиция
// ближайшего снятого префикса короче текущего. Более длинный префикс сужает список
// продолжений, фраза в нём стоит не ниже, поэтому такой вывод занижает score, а не завышает.
import { normTerm } from './schema.js';

export const wLen = (i, L) => (L - i + 1) / L;
export const wPos = (p, exponent = 0.7) => 1 / Math.pow(p, exponent);

export function positionOf(values, target) {
  if (!Array.isArray(values)) return null;
  const t = normTerm(target);
  const i = values.findIndex((v) => normTerm(v) === t);
  return i < 0 ? null : i + 1;
}

const SCRIPTS = [
  ['han', /\p{Script=Han}/u], ['hiragana', /\p{Script=Hiragana}/u], ['katakana', /\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u], ['arabic', /\p{Script=Arabic}/u], ['hebrew', /\p{Script=Hebrew}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u], ['latin', /\p{Script=Latin}/u],
];

// Письменность первой буквы фразы: по ней выбирается минимальная длина префикса
// (для иероглифов три знака — это уже целое слово).
export function scriptOf(text) {
  for (const ch of Array.from(String(text || ''))) {
    if (!/\p{L}/u.test(ch)) continue;
    for (const [name, re] of SCRIPTS) if (re.test(ch)) return name;
    return 'other';
  }
  return 'other';
}

export class ProbeError extends Error {}

// lookup(prefix) -> Promise<{ values: string[] | null, cached: boolean }>; values = null — ошибка запроса.
// peek(prefix)   -> string[] | undefined: то, что уже есть в кэше, без запроса.
export async function scorePhrase(phrase, {
  lookup, peek = null, mode = 'binary', minPrefix = 3, minPrefixByScript = {}, maxPrefix = 20, posExponent = 0.7,
}) {
  const target = normTerm(phrase);
  const chars = Array.from(target);
  const L = chars.length;
  const script = scriptOf(target);
  const M = Math.min(L, maxPrefix);
  const minI = Math.max(1, Math.min(minPrefixByScript[script] ?? minPrefix, M));
  const prefixAt = (i) => chars.slice(0, i).join('');

  const seen = new Map();   // i -> позиция или null (снято, фразы нет)
  let requests = 0;
  let cacheHits = 0;

  if (peek) {
    for (let i = minI; i <= M; i++) {
      const v = peek(prefixAt(i));
      if (v !== undefined) { seen.set(i, positionOf(v, target)); cacheHits++; }
    }
  }

  const probe = async (i) => {
    if (seen.has(i)) return seen.get(i);
    if (mode === 'cache') return undefined;
    const r = await lookup(prefixAt(i));
    if (!r || r.values == null) throw new ProbeError(`подсказки «${prefixAt(i)}» не получены`);
    if (r.cached) cacheHits++; else requests++;
    const pos = positionOf(r.values, target);
    seen.set(i, pos);
    return pos;
  };

  let iMin = null;
  if (L === 0) {
    // пустая фраза — сигнала нет
  } else if (mode === 'exact') {
    for (let i = minI; i <= M; i++) await probe(i);
  } else if (mode === 'binary') {
    const present = () => [...seen].filter(([, p]) => p != null).map(([i]) => i).sort((a, b) => a - b);
    let hi = present()[0] ?? null;
    if (hi == null && (await probe(M)) != null) hi = M;
    if (hi != null) {
      // Снятые пустые префиксы короче hi сразу сужают поиск снизу.
      let lo = minI;
      for (const [i, p] of seen) if (p == null && i < hi && i + 1 > lo) lo = i + 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await probe(mid)) != null) hi = mid; else lo = mid + 1;
      }
      iMin = hi;
    }
  } else if (mode === 'rough') {
    const points = [...new Set([minI, Math.round((minI + M) / 2), M])];
    for (const i of points) await probe(i);
  }

  const presentSeen = [...seen].filter(([, p]) => p != null).map(([i]) => i).sort((a, b) => a - b);
  if (iMin == null) iMin = presentSeen[0] ?? null;

  const base = {
    term: target, length: L, script, min_prefix: minI, max_prefix: M,
    prefixes_total: Math.max(0, M - minI + 1), method: mode, requests, cache_hits: cacheHits,
  };

  if (!seen.size) {
    // Ни одного снятого префикса (режим cache без кэша): сигнала нет, это не ноль.
    return { ...base, score_raw: null, score_raw_norm: null, min_prefix_len: null, avg_suggest_pos: null, prefix_hit_share: null, probes: [] };
  }

  const probes = [];
  let scoreRaw = 0, hits = 0, posSum = 0;
  for (let i = minI; i <= M; i++) {
    let pos = null, kind;
    if (seen.has(i)) {
      pos = seen.get(i);
      kind = pos == null ? 'a' : 's';
    } else if (iMin == null || i < iMin) {
      kind = 'n';
    } else {
      const below = presentSeen.filter((j) => j <= i);
      const j = below.length ? below[below.length - 1] : presentSeen.find((x) => x > i);
      pos = seen.get(j);
      kind = 'i';
    }
    probes.push([i, pos ?? 0, kind]);
    if (pos != null) {
      scoreRaw += wLen(i, L) * wPos(pos, posExponent);
      hits++;
      posSum += pos;
    }
  }

  // Максимум суммы при появлении на первой позиции с самого короткого префикса. Нормировка
  // w_len на L не убирает рост суммы с длиной (слагаемых больше, максимум ~ L/2), поэтому
  // хранится и доля от максимума — какой вариант лучше, решает валидация на Console (6.3).
  let maxPossible = 0;
  for (let i = minI; i <= M; i++) maxPossible += wLen(i, L);

  return {
    ...base,
    score_raw: scoreRaw,
    score_raw_norm: maxPossible > 0 ? scoreRaw / maxPossible : null,
    min_prefix_len: hits ? probes.find((p) => p[1] > 0)[0] : null,
    avg_suggest_pos: hits ? posSum / hits : null,
    prefix_hit_share: base.prefixes_total ? hits / base.prefixes_total : null,
    probes,
  };
}

// Перцентильный ранг со средним рангом для равных значений: доля словаря ниже плюс половина равных.
// Нулевой score_raw (фраза не всплыла ни на одном префиксе) остаётся нулём: это «нет сигнала»,
// и ставить его в середину шкалы только потому, что таких слов много, было бы неправдой.
// field — какой вариант сырого score нормировать: score_raw (формула 4.2) или score_raw_norm.
export function percentileScores(rows, { groupOf, minGroupSize = 30, field = 'score_raw' }) {
  const byGroup = new Map();
  for (const r of rows) {
    if (r[field] == null) continue;
    const g = groupOf(r);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }
  const all = rows.filter((r) => r[field] != null);
  const out = new Map();
  const rank = (members, r) => {
    let below = 0, equal = 0;
    for (const m of members) {
      if (m[field] < r[field]) below++;
      else if (m[field] === r[field]) equal++;
    }
    return 100 * (below + 0.5 * equal) / members.length;
  };
  for (const r of all) {
    const g = groupOf(r);
    const members = byGroup.get(g);
    // Категория с горсткой слов даёт шкалу из нескольких ступеней — тогда сравниваем со всем гео.
    const useGroup = members.length >= minGroupSize;
    const score = r[field] === 0 ? 0 : rank(useGroup ? members : all, r);
    out.set(r, { score, group: useGroup ? g : '*' });
  }
  return out;
}
