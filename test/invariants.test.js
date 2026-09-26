// Инварианты рабочей базы: утверждения, которые должны быть верны всегда.
//
// В отличие от остальных тестов, эти смотрят на живые данные и потому зависят от состояния
// сбора. Без базы они пропускаются — набор должен проходить и на чистой копии репозитория.
//
// Главный из них — согласованность дат. 26.09 стадия niche-doors пометила свою строку
// сегодняшним числом, а radar-v2 прочитал дату последнего снимка гео: для стран, которые в
// тот день не обходили, это оказались разные строки. Метрика считалась, писалась в базу и
// отсутствовала в отчёте, а заметить это можно было только открыв готовый файл и не найдя
// колонки. Проверка занимает миллисекунды и отвечает на тот же вопрос.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prodDb } from './helpers.js';

const d = prodDb();
const skipIfNoDb = (t) => { if (!d) { t.skip('рабочей базы нет'); return true; } return false; };
const geos = () => d.prepare(`SELECT DISTINCT geo FROM keyword_cores WHERE active=1 ORDER BY geo`).all().map((r) => r.geo);

test('метрики ниш лежат на той дате, которую читает radar-v2', (t) => {
  if (skipIfNoDb(t)) return;
  const bad = [];
  for (const g of geos()) {
    const D = d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_app_geo WHERE geo=?`).get(g)?.m;
    if (!D) continue;
    const r = d.prepare(`SELECT COUNT(*) n, SUM(door IS NOT NULL) d10, SUM(door3 IS NOT NULL) d3
                           FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`).get(g, D);
    if (!r.n) { bad.push(`${g}: на ${D} нет ни одной ниши`); continue; }
    if (!r.d10) bad.push(`${g}: на ${D} дверь топ-10 не посчитана ни у одной из ${r.n} ниш`);
    if (!r.d3) bad.push(`${g}: на ${D} дверь топ-3 не посчитана ни у одной из ${r.n} ниш`);
  }
  assert.deepEqual(bad, [], bad.join('; ')
    + ' — niche-doors записал строку другой датой, чем та, которую читает radar-v2');
});

test('дверь в тройку не бывает дешевле двери в десятку', (t) => {
  if (skipIfNoDb(t)) return;
  // Тройка — подмножество десятки, значит её минимум не может быть меньше. Нарушение
  // означает, что две двери посчитаны по разным снимкам выдачи.
  const bad = d.prepare(`
    SELECT m.geo, m.niche_id, m.door, m.door3 FROM metrics_niche_v2 m
      JOIN (SELECT geo, MAX(snapshot_date) mx FROM metrics_niche_v2 GROUP BY geo) f
        ON f.geo=m.geo AND f.mx=m.snapshot_date
     WHERE m.door3 IS NOT NULL AND m.door IS NOT NULL AND m.door3 < m.door LIMIT 5`).all();
  assert.deepEqual(bad, [], bad.map((r) => `${r.geo}/${r.niche_id}: топ-3 ${r.door3} < топ-10 ${r.door}`).join('; '));
});

test('оценённый спрос помечен как оценённый', (t) => {
  if (skipIfNoDb(t)) return;
  // demand_est=1 значит «прикинуто по США». Строка с замером не должна нести эту метку, и
  // наоборот: иначе в отчёте пропадёт знак «~», и оценка будет прочитана как измерение.
  const bad = d.prepare(`
    SELECT COUNT(*) n FROM metrics_niche_v2 m
      JOIN (SELECT geo, MAX(snapshot_date) mx FROM metrics_niche_v2 GROUP BY geo) f
        ON f.geo=m.geo AND f.mx=m.snapshot_date
     WHERE m.demand_ext IS NOT NULL AND m.demand_est IS NULL`).get().n;
  assert.equal(bad, 0, `строк со спросом без пометки об оценке: ${bad}`);
});

test('журнал предсказаний не переписывает уже записанные исходы', (t) => {
  if (skipIfNoDb(t)) return;
  const n = d.prepare(`SELECT COUNT(*) n FROM predictions`).get().n;
  if (!n) return t.skip('журнал пуст');
  const future = d.prepare(`SELECT COUNT(*) n FROM predictions WHERE pred_date > date('now')`).get().n;
  assert.equal(future, 0, `записей с датой в будущем: ${future}`);
  const dup = d.prepare(`SELECT COUNT(*) n FROM (
      SELECT pred_date, geo, kind, object_id, model_set, COUNT(*) c FROM predictions
       GROUP BY 1,2,3,4,5 HAVING c > 1)`).get().n;
  assert.equal(dup, 0, `повторов в журнале: ${dup} — исход мог быть перезаписан`);
});

test('незакрытых обходов от мёртвых процессов не осталось', (t) => {
  if (skipIfNoDb(t)) return;
  const open = d.prepare(`SELECT run_id, geo, pid, started_at FROM cycles WHERE status='running'`).all();
  const dead = open.filter((r) => { try { process.kill(r.pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; } });
  assert.deepEqual(dead.map((r) => `${r.geo} (pid ${r.pid}, с ${r.started_at})`), [],
    'обход записан работающим, но процесса нет — должен пометиться прерванным при старте cli');
});
