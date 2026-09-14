// Какой день гео показывать в отчёте.
//
// Карточки и метрики гео появляются в разное время: enrich-apps снимает карточки в начале
// дневного прогона, а score пишет metrics_app_geo через несколько стадий (а при --force —
// через часы). Если брать последний день карточек, гео посреди прогона показывается
// пустым: карточки за сегодня уже есть, а посчитанных метрик ещё нет. Так US выпал из
// отчёта по методике с 0 приложений при 700 посчитанных за предыдущий день.
//
// Поэтому показываем последний день, по которому есть метрики, а день карточек — только
// если метрик нет вовсе (гео впервые проходит обход).
// Вердикт воронки (screen_result) пишется только стадией screen, а она есть в первичном
// обходе, но не в дневном плане. Метрики же score пишет каждый день. Соединение «строго
// в ту же дату» после дневного прогона находило ноль строк: у US за сегодня 1333 метрики
// и ни одного вердикта — и оба отчёта показывали гео пустым. Правильная пара для строки
// метрик — последний вердикт воронки на её дату или раньше.
export function screenAsOf(alias = 's', metrics = 'm', kind = 'JOIN') {
  return `${kind} screen_result ${alias} ON ${alias}.app_id=${metrics}.app_id AND ${alias}.geo=${metrics}.geo
    AND ${alias}.snapshot_date=(SELECT MAX(sx.snapshot_date) FROM screen_result sx
                                 WHERE sx.app_id=${metrics}.app_id AND sx.geo=${metrics}.geo
                                   AND sx.snapshot_date<=${metrics}.snapshot_date)`;
}

// День воронки гео, действующий на дату: для сводок вида «сколько отсеяно по причине».
export function screenDateAsOf(d, geo, date) {
  return d.prepare(`SELECT MAX(snapshot_date) m FROM screen_result WHERE geo=? AND snapshot_date<=?`).get(geo, date)?.m || date;
}

export function latestShownDate(d, geo) {
  return d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_app_geo WHERE geo=?`).get(geo)?.m
    || d.prepare(`SELECT MAX(snapshot_date) m FROM raw_app_page WHERE geo=?`).get(geo)?.m
    || null;
}
