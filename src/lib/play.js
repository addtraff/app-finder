// Обёртка над google-play-scraper: JSON-эндпоинты Play (batchexecute),
// лимиты по типам запросов, ретраи 3 с экспоненциальной паузой, адаптивная реакция на 429.
// Никакого обхода защиты: 429 -> замедлились; капча -> стоп и алерт.
import gplayPkg from 'google-play-scraper';
import { sleep, log, warn } from './util.js';

const gplay = gplayPkg.default || gplayPkg;

// Замерено в ТЗ: выдача Play отдаёт 429 уже при двух запросах в секунду.
const DEFAULT_RPM = {
  search: 20,
  suggest: 20,
  detail: 60,
  reviews: 30,
  list: 30,
  similar: 40,
  developer: 40,
  permissions: 60,
};

const state = new Map(); // bucket -> {nextAt, rpm, req, err, r429}

function bucket(name) {
  if (!state.has(name)) {
    state.set(name, { nextAt: 0, rpm: DEFAULT_RPM[name] || 30, req: 0, err: 0, r429: 0 });
  }
  return state.get(name);
}

export function setRpm(name, rpm) { bucket(name).rpm = rpm; }

export function stats() {
  const out = {};
  for (const [k, v] of state) out[k] = { requests: v.req, errors: v.err, r429: v.r429, rpm: v.rpm };
  return out;
}
export function totalRequests() {
  let n = 0; for (const v of state.values()) n += v.req; return n;
}
export function totalErrors() {
  let n = 0; for (const v of state.values()) n += v.err; return n;
}

class CaptchaStop extends Error {}
export { CaptchaStop };

async function pace(b) {
  const gap = 60000 / b.rpm;
  const now = Date.now();
  const wait = Math.max(0, b.nextAt - now);
  b.nextAt = Math.max(now, b.nextAt) + gap + Math.random() * 250; // джиттер
  if (wait > 0) await sleep(wait);
}

function isRate(e) {
  const s = String(e && (e.message || e));
  return s.includes('429') || /too many requests/i.test(s);
}
function isCaptcha(e) {
  const s = String(e && (e.message || e));
  return /captcha|unusual traffic|sorry\/index/i.test(s);
}
function isNotFound(e) {
  const s = String(e && (e.message || e));
  return s.includes('404') || /App not found/i.test(s);
}

async function call(bucketName, fn, { retries = 3, allowNotFound = true } = {}) {
  const b = bucket(bucketName);
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await pace(b);
    try {
      b.req++;
      const res = await fn();
      return res;
    } catch (e) {
      lastErr = e;
      if (isCaptcha(e)) { b.err++; throw new CaptchaStop(`captcha на ${bucketName}: ${e.message}`); }
      if (isNotFound(e) && allowNotFound) return null;
      b.err++;
      if (isRate(e)) {
        b.r429++;
        // Адаптивно: снижаем темп этого ведра на 30 % и ждём дольше.
        b.rpm = Math.max(5, Math.floor(b.rpm * 0.7));
        const backoff = 15000 * Math.pow(2, attempt);
        warn(`429 на ${bucketName}, темп -> ${b.rpm}/мин, пауза ${Math.round(backoff / 1000)}с`);
        await sleep(backoff);
      } else if (attempt < retries) {
        await sleep(2000 * Math.pow(3, attempt));
      }
    }
  }
  throw lastErr;
}

const lc = (g) => String(g).toLowerCase();

// call() возвращает промис, поэтому `call(...) || []` защищает промис, а не результат:
// для 404 сюда доходил null и падал на .length. Все списочные коллекторы разворачивают await явно.
const list0 = async (p) => (await p) || [];

export const play = {
  async app(appId, geo, hl) {
    return call('detail', () => gplay.app({ appId, country: lc(geo), lang: hl, throttle: 0 }));
  },
  async search(term, geo, hl, num = 50) {
    return list0(call('search', () => gplay.search({ term, country: lc(geo), lang: hl, num, throttle: 0 })));
  },
  async suggest(term, geo, hl) {
    return list0(call('suggest', () => gplay.suggest({ term, country: lc(geo), lang: hl, throttle: 0 })));
  },
  async reviews(appId, geo, lang, num = 200) {
    const r = await call('reviews', () =>
      gplay.reviews({ appId, country: lc(geo), lang, sort: gplay.sort.NEWEST, num, throttle: 0 })
    );
    return (r && r.data) || [];
  },
  async list(collection, category, geo, hl, num = 100) {
    return list0(call('list', () =>
      gplay.list({ collection, category, country: lc(geo), lang: hl, num, throttle: 0 })));
  },
  async similar(appId, geo, hl) {
    return list0(call('similar', () => gplay.similar({ appId, country: lc(geo), lang: hl, throttle: 0 })));
  },
  async developer(devId, geo, hl, num = 30) {
    return list0(call('developer', () =>
      gplay.developer({ devId, country: lc(geo), lang: hl, num, throttle: 0 })));
  },
  async permissions(appId, geo, hl) {
    return list0(call('permissions', () =>
      gplay.permissions({ appId, country: lc(geo), lang: hl, short: false, throttle: 0 })));
  },
  async datasafety(appId, geo, hl) {
    return call('permissions', () =>
      gplay.datasafety({ appId, country: lc(geo), lang: hl, throttle: 0 }), { allowNotFound: true });
  },
  collections: gplay.collection,
  categories: gplay.category,
};

export { log, warn };
