// Курсы на дату снимка. Цены IAP приходят в валюте гео и нормализуются к USD.
import { db } from './db.js';
import { warn } from './util.js';

// Приор на случай, если сеть недоступна: порядок величины, помечается source='prior'.
const PRIOR = {
  USD: 1, EUR: 1.08, GBP: 1.27, AUD: 0.66, CAD: 0.73, CHF: 1.13, JPY: 0.0067, KRW: 0.00073,
  SEK: 0.095, NOK: 0.093, DKK: 0.145, NZD: 0.61, SGD: 0.74, AED: 0.27, ILS: 0.27,
  SAR: 0.27, BRL: 0.18, TWD: 0.031, PLN: 0.25, MXN: 0.055, TRY: 0.029,
};

export async function ensureRates(date) {
  const d = db();
  const have = d.prepare(`SELECT COUNT(*) c FROM fx_rates WHERE snapshot_date=?`).get(date).c;
  if (have > 0) return;

  let rates = null;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) });
    const j = await res.json();
    if (j && j.rates) rates = j.rates; // сколько единиц валюты за 1 USD
  } catch (e) {
    warn(`курсы не получены (${e.message}) — беру приор`);
  }

  const ins = d.prepare(`INSERT OR REPLACE INTO fx_rates (snapshot_date, currency, rate_to_usd, source) VALUES (?,?,?,?)`);
  d.transaction(() => {
    for (const cur of Object.keys(PRIOR)) {
      const live = rates && rates[cur];
      ins.run(date, cur, live ? 1 / live : PRIOR[cur], live ? 'open.er-api.com' : 'prior');
    }
  })();
}

let cache = null, cacheDate = null;
export function toUsd(amount, currency, date) {
  if (amount == null || !currency) return null;
  if (cacheDate !== date) {
    cache = new Map(db().prepare(`SELECT currency, rate_to_usd FROM fx_rates WHERE snapshot_date=?`).all(date).map((r) => [r.currency, r.rate_to_usd]));
    cacheDate = date;
  }
  const r = cache.get(currency);
  return r == null ? null : amount * r;
}
