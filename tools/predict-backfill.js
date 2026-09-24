#!/usr/bin/env node
// Достройка журнала предсказаний за прошедшие дни.
//   node tools/predict-backfill.js 2026-09-16 2026-09-23
// По умолчанию — от самой ранней даты в metrics_app_v2 до вчерашней.
//
// Смысл ровно один: тридцатидневные метки созревают через 30 дней от ДАТЫ ПРЕДСКАЗАНИЯ.
// Запись за 16.09 означает первый backtest 16.10 вместо 24.10 — неделя разницы там, где
// ждать всё равно больше месяца.
import { db } from '../src/lib/db.js';
import { backfillRange } from '../src/stages/predict-log.js';
import { log } from '../src/lib/util.js';

const d = db();
const first = d.prepare(`SELECT MIN(snapshot_date) m FROM metrics_app_v2`).get()?.m;
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const from = process.argv[2] || first;
const to = process.argv[3] || yesterday;
if (!from) { log('в metrics_app_v2 нет ни одной даты — нечего достраивать'); process.exit(0); }

log(`достраиваю журнал предсказаний: ${from} → ${to}`);
const res = backfillRange(from, to);
const apps = res.reduce((a, r) => a + r.apps, 0);
const niches = res.reduce((a, r) => a + r.niches, 0);
log(`готово: дней ${res.length}, строк по приложениям ${apps}, по нишам ${niches}`);
