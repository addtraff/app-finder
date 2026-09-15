// kw-geo-check: «прокси не в нужной стране» (раздел 10). Подсказка по нейтральному слову должна
// прийти на языке гео; иначе мы измеряем не популярность в стране, а свою собственную историю.
//
// Проверка ловит неверный язык выдачи (hl) и явную подмену страны. Она не доказывает, что Play
// считает запрос пришедшим из этой страны: без прокси в стране все запросы идут с одного IP,
// и различие между, скажем, US и GB видно только по параметру gl.
import { play, CaptchaStop } from '../lib/play.js';
import { primaryHl } from '../lib/config.js';
import { log, warn } from '../lib/util.js';
import { kwDb, kwConfig, normTerm } from '../lib/kw/schema.js';
import { langOf } from '../lib/kw/features.js';

export async function run({ geo, date }) {
  const d = kwDb();
  const hl = primaryHl(geo);
  const n = kwConfig().neutral[langOf(hl)];
  const ins = d.prepare(`INSERT OR REPLACE INTO kw_geo_check (geo, checked_at, hl, prefix, expect, found, suggestions, error) VALUES (?,?,?,?,?,?,?,?)`);
  if (!n) {
    ins.run(geo, date, hl, null, null, null, null, `нет нейтрального слова для языка ${langOf(hl)} в config/kw-volume.json`);
    warn(`  ${geo}: нейтрального слова для «${langOf(hl)}» нет — проверка пропущена`);
    return { found: null };
  }
  try {
    const values = await play.suggest(n.prefix, geo, hl);
    const found = values.some((v) => normTerm(v).includes(normTerm(n.expect))) ? 1 : 0;
    ins.run(geo, date, hl, n.prefix, n.expect, found, JSON.stringify(values), null);
    (found ? log : warn)(`  ${geo}: «${n.prefix}» -> ${found ? `есть «${n.expect}»` : `нет «${n.expect}»: ${values.join(' · ') || 'пусто'}`}`);
    return { found };
  } catch (e) {
    if (e instanceof CaptchaStop) throw e;
    ins.run(geo, date, hl, n.prefix, n.expect, null, null, String(e.message || e).slice(0, 300));
    warn(`  ${geo}: проверка языка не выполнена — ${e.message}`);
    return { found: null };
  }
}
