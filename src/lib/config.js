import fs from 'node:fs';
import path from 'node:path';
import { ROOT, db } from './db.js';
import { todayUTC } from './util.js';

const CFG = path.join(ROOT, 'config');
const read = (f) => JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8'));

let _cfg = null;
export function config() {
  if (_cfg) return _cfg;
  _cfg = {
    geos: read('geos.json'),
    seeds: read('seeds.json'),
    budget: read('budget.json'),
    institutions: read('institutions.json'),
    scoring: read('scoring.json'),
    intents: read('intent-templates.json'),
    lexicon: read('review-lexicon.json'),
  };
  return _cfg;
}

// Реестр живёт в конфиге, зеркалится в базу — чтобы SQL-отчёты видели те же данные.
export function syncRegistry() {
  const c = config();
  const d = db();
  const now = todayUTC();

  const upGeo = d.prepare(`INSERT INTO geos
    (geo, hl, review_langs, currency, tier, active, proxy_required_search, proxy_required_suggest,
     start_hour_utc, ecpm_rel_us, arpu_rel_us, econ_source, econ_updated)
    VALUES (@geo,@hl,@review_langs,@currency,@tier,@active,@prs,@prsg,@start_hour_utc,@ecpm,@arpu,@src,@upd)
    ON CONFLICT(geo) DO UPDATE SET hl=excluded.hl, review_langs=excluded.review_langs,
      currency=excluded.currency, tier=excluded.tier, active=excluded.active,
      start_hour_utc=excluded.start_hour_utc, ecpm_rel_us=excluded.ecpm_rel_us,
      arpu_rel_us=excluded.arpu_rel_us`);

  d.transaction(() => {
    for (const g of c.geos.geos) {
      upGeo.run({
        geo: g.geo, hl: JSON.stringify(g.hl), review_langs: JSON.stringify(g.review_langs),
        currency: g.currency, tier: g.tier, active: g.active ? 1 : 0,
        prs: g.proxy_required_search == null ? null : (g.proxy_required_search ? 1 : 0),
        prsg: g.proxy_required_suggest == null ? null : (g.proxy_required_suggest ? 1 : 0),
        start_hour_utc: g.start_hour_utc, ecpm: g.ecpm_rel_us, arpu: g.arpu_rel_us,
        src: 'prior (открытые бенчмарки, требует ручного обновления раз в квартал)', upd: now,
      });
    }

    const upKw = d.prepare(`INSERT OR REPLACE INTO seed_keywords (geo, keyword, lang, intent_type, weight, concept) VALUES (?,?,?,?,?,?)`);
    for (const [geo, list] of Object.entries(c.seeds.keywords || {})) {
      for (const k of list) upKw.run(geo, k.keyword.toLowerCase(), k.lang, k.intent_type, k.weight ?? 1, k.concept ?? null);
    }
    const upApp = d.prepare(`INSERT OR REPLACE INTO seed_apps (app_id, geo, note) VALUES (?,?,?)`);
    for (const [geo, list] of Object.entries(c.seeds.apps || {})) {
      for (const a of list) upApp.run(typeof a === 'string' ? a : a.app_id, geo, typeof a === 'string' ? null : a.note);
    }
    const upCat = d.prepare(`INSERT OR REPLACE INTO seed_categories (geo, category) VALUES (?,?)`);
    for (const [geo, list] of Object.entries(c.seeds.categories || {})) {
      for (const cat of list) upCat.run(geo, cat);
    }
    // Ключи, собранные до появления concept, донаследуют его от своего семени.
    // Трогаются только строки без концепта, поэтому шаг безопасно повторять.
    const backfill = d.prepare(
      `UPDATE disc_keywords SET concept = ?
        WHERE geo = ? AND concept IS NULL AND (keyword = ? OR keyword LIKE '%' || ? || '%')`);
    for (const [geo, list] of Object.entries(c.seeds.keywords || {})) {
      const byLength = [...list].sort((a, b) => b.keyword.length - a.keyword.length);
      for (const k of byLength) {
        if (!k.concept) continue;
        const kw = k.keyword.toLowerCase();
        backfill.run(k.concept, geo, kw, kw);
      }
    }

    const upInst = d.prepare(`INSERT OR REPLACE INTO institution_domains (pattern, kind, note) VALUES (?,?,?)`);
    for (const p of c.institutions.domain_patterns) upInst.run(p, 'domain', null);
    for (const p of c.institutions.package_patterns) upInst.run(p, 'package', null);
  })();
}

export function activeGeos() {
  return config().geos.geos.filter((g) => g.active);
}
export function geoConf(geo) {
  const g = config().geos.geos.find((x) => x.geo === geo);
  if (!g) throw new Error(`Гео ${geo} нет в config/geos.json`);
  return g;
}
export const referenceGeo = () => config().geos.reference_geo || 'US';
export const primaryHl = (geo) => geoConf(geo).hl[0];
