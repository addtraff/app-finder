// Входы в топ-10: кто вошёл в нишу, за сколько дней дошёл и удержался ли.
//
// Это приоритет №1 разбора от 25.09 и единственное, что превращает описание рынка в
// проверяемое утверждение. Остальные метрики отвечают на вопрос «как сейчас»; эта — на
// вопрос «что вышло у тех, кто уже попробовал».
//
// Чем она отличается от журнала предсказаний. Журнал пишет, что МЫ предсказали и что из
// этого вышло. Здесь наоборот: исходы самой ниши, независимо от наших рекомендаций. Кто-то
// вошёл в топ-10 — мы этого не советовали и не знали, но факт входа и его судьба говорят о
// нише больше, чем наша оценка свободы.
//
// Главная ловушка этих данных — рост охвата. 23.09 сняли лимит на ключи, и по США их стало
// 1357 вместо 314. Если сравнивать дни целиком, все, кто спокойно стоял в топ-10 новых для
// нас ключей, выглядят как вошедшие в этот день: тысяча фальшивых входов на ровном месте.
// Поэтому соседние дни сравниваются только по ключам, снятым в ОБА дня, — так расширение
// охвата не создаёт событий, а сужение не создаёт выпадений.
//
// Вторая оговорка — длина окна. История выдачи начинается 07.09, поэтому «удержался ли
// через тридцать дней» пока не считается ни для кого: поле остаётся пустым, а не
// заполняется тем, что есть. Что уже можно: сколько дней прошло с входа, сколько дней из
// наблюдавшихся приложение реально простояло в десятке и стоит ли там сейчас.
import { db, startRun, finishRun, retryBusy } from '../lib/db.js';
import { log } from '../lib/util.js';

export async function run({ geo, date, runId, cycle = 'daily' }) {
  const d = db();
  startRun(runId, 'niche-entries', geo, cycle, date);

  // Ядро ниши: вход считается только по этим ключам, иначе это вход в случайную выдачу.
  const core = d.prepare(`SELECT niche_id, keyword FROM keyword_cores WHERE geo=? AND active=1`).all(geo);
  if (!core.length) {
    finishRun(runId, 'niche-entries', geo, { status: 'skipped', notes: 'нет ядра' });
    log(`  ${geo}: ядра нет, пропускаю`);
    return { entries: 0 };
  }
  const kwsOfNiche = new Map();
  const coreKw = new Set();
  for (const r of core) {
    if (!kwsOfNiche.has(r.niche_id)) kwsOfNiche.set(r.niche_id, []);
    kwsOfNiche.get(r.niche_id).push(r.keyword);
    coreKw.add(r.keyword);
  }

  const rows = d.prepare(
    `SELECT snapshot_date d, keyword kw, app_id, position pos FROM raw_search
      WHERE geo=? AND position<=50`).all(geo);
  if (!rows.length) {
    finishRun(runId, 'niche-entries', geo, { status: 'skipped', notes: 'нет выдачи' });
    return { entries: 0 };
  }

  // Ключ считается снятым в день, если по нему есть хоть одна строка выдачи. Пустая выдача
  // от неснятого ключа тут неотличима, но пустая выдача по ядровому ключу — сама по себе
  // редкость, и на сравнение соседних дней это не влияет: такой ключ просто выпадает из
  // пересечения и в сравнении не участвует.
  const kwDates = new Map();          // ключ -> Set дней, когда его снимали
  const top10 = new Map();            // ключ|день -> Set приложений в топ-10
  for (const r of rows) {
    if (!coreKw.has(r.kw)) continue;
    let ds = kwDates.get(r.kw); if (!ds) kwDates.set(r.kw, ds = new Set());
    ds.add(r.d);
    if (r.pos > 10) continue;
    const k = r.kw + '|' + r.d;
    let s = top10.get(k); if (!s) top10.set(k, s = new Set());
    s.add(r.app_id);
  }

  const nicheOfKw = new Map();
  for (const [nid, kws] of kwsOfNiche) for (const kw of kws) {
    if (!nicheOfKw.has(kw)) nicheOfKw.set(kw, new Set());
    nicheOfKw.get(kw).add(nid);
  }

  // Присутствие в нише по дням и путь снизу — по всем ядровым ключам, без пересечений:
  // присутствие от расширения охвата только уточняется, а не выдумывается.
  const pres = new Map();             // ниша|приложение -> {days, best, firstAny, posOn}
  for (const r of rows) {
    const nids = nicheOfKw.get(r.kw); if (!nids) continue;
    for (const nid of nids) {
      const k = nid + '|' + r.app_id;
      let s = pres.get(k);
      if (!s) pres.set(k, s = { days: new Set(), best: r.pos, firstAny: r.d, posOn: new Map() });
      if (r.d < s.firstAny) s.firstAny = r.d;
      if (r.pos < s.best) s.best = r.pos;
      if (r.pos <= 10) {
        s.days.add(r.d);
        const p = s.posOn.get(r.d);
        if (p == null || r.pos < p) s.posOn.set(r.d, r.pos);
      }
    }
  }

  // Событие входа: приложение есть в топ-10 сегодня и не было вчера — по одному и тому же
  // набору ключей. Первый день ниши событием быть не может: в него «вошли» разом все, кто
  // там уже стоял, и это не событие, а начало наблюдения.
  const entryDate = new Map();        // ниша|приложение -> день первого входа
  const nicheWindow = new Map();      // ниша -> границы окна и число сравнимых переходов
  for (const [nid, kws] of kwsOfNiche) {
    const dates = [...new Set(kws.flatMap((kw) => [...(kwDates.get(kw) || [])]))].sort();
    if (dates.length < 2) {
      nicheWindow.set(nid, { from: dates[0] || null, to: dates[0] || null, days: dates.length, comparable: 0 });
      continue;
    }
    let comparable = 0;
    for (let i = 1; i < dates.length; i++) {
      const prev = dates[i - 1], cur = dates[i];
      const both = kws.filter((kw) => { const s = kwDates.get(kw); return s && s.has(prev) && s.has(cur); });
      if (!both.length) continue;     // общих ключей нет — дни несравнимы, событий не будет
      comparable++;
      const was = new Set(), now = new Set();
      for (const kw of both) {
        for (const a of top10.get(kw + '|' + prev) || []) was.add(a);
        for (const a of top10.get(kw + '|' + cur) || []) now.add(a);
      }
      for (const a of now) {
        if (was.has(a)) continue;
        const k = nid + '|' + a;
        if (!entryDate.has(k)) entryDate.set(k, cur);
      }
    }
    nicheWindow.set(nid, { from: dates[0], to: dates[dates.length - 1], days: dates.length, comparable, dates });
  }

  // Установки берём той же меркой, что niche-doors: max_installs, но если отзывов больше,
  // чем установок, карточка врёт (часть локалей отдаёт «1+» вместо числа) - тогда лучше
  // пусто, чем ноль. Сначала своё гео, потом любое: цифра общая, но снимок своего свежее.
  const pick = (r) => (r && r.i != null && !(r.rc != null && r.rc > r.i) ? r.i : null);
  const atGeo = d.prepare(
    `SELECT max_installs i, ratings_count rc FROM raw_app_page WHERE app_id=? AND geo=? AND max_installs IS NOT NULL
       AND snapshot_date<=? ORDER BY snapshot_date DESC LIMIT 1`);
  const atAny = d.prepare(
    `SELECT max_installs i, ratings_count rc FROM raw_app_page WHERE app_id=? AND max_installs IS NOT NULL
       AND snapshot_date<=? ORDER BY snapshot_date DESC LIMIT 1`);
  const nowAny = d.prepare(
    `SELECT max_installs i, ratings_count rc FROM raw_app_page WHERE app_id=? AND max_installs IS NOT NULL
      ORDER BY snapshot_date DESC LIMIT 1`);
  const instAt = (app, day) => pick(atGeo.get(app, geo, day)) ?? pick(atAny.get(app, day));
  const instNow = (app) => pick(nowAny.get(app));
  const ins = d.prepare(`INSERT INTO niche_entries
      (geo, niche_id, app_id, entry_date, first_seen_serp, days_to_top10, installs_at_entry, installs_now,
       entry_position, best_position, days_in_top10, observed_after, days_since_entry, days_held, still_in,
       observed_from, observed_to, observed_days, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (geo, niche_id, app_id, entry_date) DO UPDATE SET
      installs_now=excluded.installs_now, best_position=excluded.best_position,
      days_in_top10=excluded.days_in_top10, observed_after=excluded.observed_after,
      days_since_entry=excluded.days_since_entry,
      days_held=excluded.days_held, still_in=excluded.still_in,
      observed_to=excluded.observed_to, observed_days=excluded.observed_days,
      updated_at=excluded.updated_at`);

  const diff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const today = new Date().toISOString().slice(0, 10);
  let entries = 0, held = 0, flick = 0;

  const write = d.transaction(() => {
    for (const [k, entry] of entryDate) {
      const cut = k.indexOf('|');
      const nid = k.slice(0, cut), app = k.slice(cut + 1);
      const s = pres.get(k); if (!s) continue;
      const w = nicheWindow.get(nid);
      const after = [...s.days].filter((x) => x >= entry).sort();
      const lastIn = after[after.length - 1];
      const stillIn = lastIn === w.to ? 1 : 0;
      ins.run(geo, nid, app, entry, s.firstAny,
        s.firstAny < entry ? diff(s.firstAny, entry) : null,
        instAt(app, entry), instNow(app),
        s.posOn.get(entry) ?? null, s.best,
        after.length, w.dates.filter((x) => x >= entry).length, diff(entry, w.to),
        diff(entry, lastIn), stillIn,
        w.from, w.to, w.days, today);
      entries++;
      if (stillIn) held++;
      // Вошедший в последний снятый день ещё ничего не показал: один день в десятке у него
      // не потому, что выпал, а потому, что других дней пока не было.
      if (after.length === 1 && w.dates.filter((x) => x >= entry).length > 1) flick++;
    }
  });
  retryBusy(write);

  const w0 = [...nicheWindow.values()][0] || {};
  finishRun(runId, 'niche-entries', geo, { notes: `${entries} входов, держатся ${held}` });
  log(`  ${geo}: входов ${entries}, стоят до сих пор ${held}, мелькнули один день ${flick} (окно ${w0.from}…${w0.to})`);
  return { entries };
}
