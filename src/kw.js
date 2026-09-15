#!/usr/bin/env node
// Модуль объёма поиска (docs/metodika-kw-volume.md) — отдельная точка входа.
// Конвейер радара (src/cli.js) модуль не запускает и в его таблицы не пишет: у объёма поиска
// свой ритм (пересчёт раз в 2–4 недели) и свои таблицы.
import { config, activeGeos, referenceGeo } from './lib/config.js';
import { setRpm, stats, CaptchaStop } from './lib/play.js';
import { todayUTC, md5, log, warn } from './lib/util.js';
import { kwDb, normTerm } from './lib/kw/schema.js';
import { importConsole, importPlanner, importTrends, importAsa } from './lib/kw/imports.js';
import { geoMaturity } from './lib/kw/maturity.js';

import * as signals from './stages/kw-signals.js';
import * as track from './stages/kw-track.js';
import * as calibrate from './stages/kw-calibrate.js';
import * as metrics from './stages/kw-metrics.js';
import * as geoCheck from './stages/kw-geo-check.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

const yes = (v) => v === true || v === 'yes' || v === '1';

// По умолчанию — только референсное гео: запуск на все 30 стран — это сутки запросов к Play,
// такое должно быть явным (--geo all).
function geosOf(args) {
  if (!args.geo) return [referenceGeo()];
  if (args.geo === 'all') return activeGeos().map((g) => g.geo);
  return String(args.geo).split(',').map((g) => g.trim().toUpperCase());
}

async function report(args, date) {
  const { run } = await import('./stages/kw-report.js');
  return run({ date, geos: args.geo ? geosOf(args) : null });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  const date = args.date || todayUTC();
  const d = kwDb();
  for (const [k, v] of Object.entries(config().budget.rpm || {})) setRpm(k, v);
  const runId = `${date}-kw-${md5(String(Date.now())).slice(0, 6)}`;
  const limit = args.limit ? Number(args.limit) : null;

  const each = async (fn) => {
    for (const geo of geosOf(args)) {
      try { await fn(geo); } catch (e) {
        if (e instanceof CaptchaStop) { warn(`СТОП: ${e.message}`); break; }
        throw e;
      }
    }
  };

  switch (cmd) {
    // Полный проход: проверка языка -> score -> позиции -> калибровка -> колонка -> отчёт.
    case 'run': {
      await each(async (geo) => {
        log(`=== объём поиска ${geo} ${date}${yes(args.offline) ? ' (без сети)' : ''} ===`);
        if (!yes(args.offline) && !yes(args['skip-check'])) { log('-> kw-geo-check'); await geoCheck.run({ geo, date }); }
        log('-> kw-signals');
        await signals.run({ geo, date, runId, limit, offline: yes(args.offline), force: yes(args.force), mode: args.mode || null });
        if (!yes(args.offline) && !yes(args['skip-track'])) { log('-> kw-track'); await track.run({ geo, date }); }
        log('-> kw-calibrate'); await calibrate.run({ geo, date });
        log('-> kw-metrics'); await metrics.run({ geo, date });
      });
      if (!yes(args['skip-report'])) { log('-> kw-report'); await report(args, date); }
      log(`запросов к Play: ${JSON.stringify(stats())}`);
      break;
    }

    case 'signals':
      await each((geo) => signals.run({ geo, date, runId, limit, offline: yes(args.offline), force: yes(args.force), mode: args.mode || null }));
      break;
    case 'track': await each((geo) => track.run({ geo, date, limit })); break;
    case 'calibrate': await each((geo) => calibrate.run({ geo, date })); break;
    case 'metrics': await each((geo) => metrics.run({ geo, date })); break;
    case 'geo-check': await each((geo) => geoCheck.run({ geo, date })); break;
    case 'report': await report(args, date); break;

    // Разовая оценка фраз с лестницей префиксов — то же, что считает сервис по кнопке.
    case 'estimate': {
      const terms = args._.slice(1).flatMap((t) => t.split(',')).map(normTerm).filter(Boolean);
      if (!terms.length) { warn('нужны фразы: node src/kw.js estimate --geo US "photo editor" "pdf reader"'); process.exit(1); }
      const geo = geosOf(args)[0];
      await signals.run({ geo, date, runId, terms, mode: args.mode || 'binary', offline: yes(args.offline), force: true });
      await metrics.run({ geo, date });
      const rows = d.prepare(
        `SELECT k.term, s.score_raw, s.score_raw_norm, s.min_prefix_len, s.avg_suggest_pos, s.probes, s.requests, m.popularity_score, m.confidence_level, m.bucket
           FROM kw_signals s JOIN keywords k USING(keyword_id)
           LEFT JOIN kw_metrics m ON m.keyword_id=s.keyword_id AND m.geo=s.geo AND m.day=?
          WHERE s.geo=? AND s.day=? AND k.term IN (SELECT value FROM json_each(?))`).all(date, geo, date, JSON.stringify(terms));
      for (const r of rows) {
        const ladder = JSON.parse(r.probes).map(([i, p, k]) => `${i}:${p ? p : '·'}${k === 's' ? '' : k === 'i' ? '~' : ''}`).join(' ');
        console.log(`\n«${r.term}» ${geo}: score ${r.popularity_score?.toFixed(1) ?? '—'} (сырой ${r.score_raw.toFixed(2)}, доля от максимума ${r.score_raw_norm?.toFixed(2)}), ` +
          `появление с ${r.min_prefix_len ?? '—'}-й буквы, средняя позиция ${r.avg_suggest_pos?.toFixed(1) ?? '—'}, запросов ${r.requests}` +
          `\n  уровень: ${r.confidence_level}${r.bucket ? ` — ${r.bucket}` : ''}\n  префиксы: ${ladder}   (~ выведено, · нет)`);
      }
      for (const t of terms.filter((t) => !rows.find((r) => r.term === t))) console.log(`\n«${t}»: префиксы не сняты — сигнала нет`);
      break;
    }

    case 'watch': {
      const geo = geosOf(args)[0];
      const action = args._[1] || 'list';
      const terms = args._.slice(2).flatMap((t) => t.split(',')).map(normTerm).filter(Boolean);
      if (action === 'add') {
        const ins = d.prepare(`INSERT OR IGNORE INTO kw_watch (geo, term, added_at, note) VALUES (?,?,?,?)`);
        for (const t of terms) ins.run(geo, t, date, args.note || null);
        log(`${geo}: в избранном +${terms.length}`);
      } else if (action === 'remove') {
        const del = d.prepare(`DELETE FROM kw_watch WHERE geo=? AND term=?`);
        for (const t of terms) del.run(geo, t);
        log(`${geo}: из избранного −${terms.length}`);
      } else {
        for (const r of d.prepare(`SELECT geo, term, added_at FROM kw_watch ORDER BY geo, term`).all()) console.log(`${r.geo}\t${r.term}\t${r.added_at}`);
      }
      break;
    }

    case 'import-console': {
      if (!args.file) { warn('нужен --file: выгрузка Play Console → Search terms (CSV, в том числе UTF-16 из Cloud Storage)'); process.exit(1); }
      const res = importConsole(d, args.file, { app: args.app || null, geo: args.geo ? String(args.geo).toUpperCase() : null, lang: args.lang || null, metric: args.metric || null, date });
      log(`Play Console: ${res.rows} строк, дней ${res.days}, приложения ${res.apps.join(', ')}, гео ${res.geos.join(', ')}, метрики ${res.kinds.join(' + ')}; ` +
          `пропущено агрегатов ${res.skipped_aggregate}, нераспознанных ${res.skipped_bad}`);
      break;
    }
    case 'import-planner': {
      const res = importPlanner(d, args.file, { geo: args.geo ? String(args.geo).toUpperCase() : null });
      log(`Keyword Planner: ${res.rows} слов`);
      break;
    }
    case 'import-trends': {
      if (!args.geo) { warn('нужен --geo: страна, для которой снята выгрузка Trends'); process.exit(1); }
      const res = importTrends(d, args.file, { geo: String(args.geo).toUpperCase() });
      log(`Google Trends: ${res.points} точек по ${res.terms} словам`);
      break;
    }
    case 'import-asa': {
      const res = importAsa(d, args.file, { geo: args.geo ? String(args.geo).toUpperCase() : null });
      log(`Apple Search Ads: ${res.rows} слов`);
      break;
    }

    case 'status': {
      const geos = args.geo ? geosOf(args)
        : d.prepare(`SELECT geo FROM kw_signals UNION SELECT geo FROM console_search_terms ORDER BY geo`).all().map((r) => r.geo);
      if (!geos.length) log('модуль ещё не запускался: node src/kw.js run --geo US');
      for (const geo of geos) {
        const m = geoMaturity(d, geo, date);
        console.log(`${geo}  ${m.stage}  слов со score ${m.signals} (последний расчёт ${m.signals_last || '—'}), Console ${m.console_rows} строк / ${m.console_apps} прил.` +
          `${m.active_model ? `, модель ${m.active_model.model_version} ρ ${m.active_model.spearman?.toFixed(2)}` : ''}\n    дальше: ${m.next}`);
      }
      break;
    }

    case 'serve': {
      const { serve } = await import('./kw-serve.js');
      await serve({ port: Number(args.port || 8790) });
      return;
    }

    default:
      console.log(`Объём поиска Google Play — оценка «Показы/день» по методике docs/metodika-kw-volume.md

  node src/kw.js run [--geo US|US,DE|all] [--offline] [--limit N]   полный проход и отчёт
  node src/kw.js estimate --geo US "photo editor" "pdf reader"       score фраз с лестницей префиксов
  node src/kw.js watch add --geo US "фраза, фраза"                   избранное: полный расчёт и трекер позиций
  node src/kw.js import-console --file terms.csv [--app pkg] [--geo US] [--metric acquisitions|unique_clicks]
  node src/kw.js import-planner --file kp.csv [--geo US]             Keyword Planner (диапазоны)
  node src/kw.js import-trends  --file multiTimeline.csv --geo US    Google Trends
  node src/kw.js import-asa     --file asa.csv [--geo US]            Apple Search Ads popularity
  node src/kw.js status                                              стадии S0–S4 по гео
  node src/kw.js serve [--port 8790]                                 локальный сервис с отчётом
  node src/kw.js signals|track|calibrate|metrics|geo-check|report --geo US   отдельные шаги

  --offline — без запросов к Play: score только из уже снятых префиксов.
  Без --geo берётся референсное гео (${referenceGeo()}).`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

