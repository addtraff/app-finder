// Отчёты: собирается ли шаблон и доходят ли клики до обработчиков.
//
// Ловит две ошибки одного дня. Первая: вкладка «По нишам» и переключатель не работали —
// разметка была правильной, aria-pressed стоял, но обработчики лежали в слушателе change,
// который ловит только <select>. Кнопка туда не доходит, и проверить это можно было лишь
// руками в браузере. Вторая: в собранный файл попала незаполненная метка шаблона, и отчёт
// перестал открываться целиком — при том что весил правильно и выглядел нормальным файлом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers.js';
import { fillTemplate, COMMON_JS } from '../src/lib/report-common.js';
import { UNPACK_JS } from '../src/lib/pack.js';

const TEMPLATES = ['src/report/appradar2.html', 'src/report/appradar3.html'];

// Тело <script> из готового фрагмента — именно того, который уедет в файл, а не шаблона.
function script(file) {
  const filled = fillTemplate(read(file), { json: '{"geos":[],"apps":[],"niches":[]}', unpackJs: UNPACK_JS });
  const m = filled.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, `${file}: не нашёл <script>`);
  return m[1];
}

for (const file of TEMPLATES) {
  test(`${file}: шаблон заполняется и разбирается`, () => {
    const body = script(file);
    new Function(body);                                  // синтаксис
    assert.ok(body.includes('function esc'), 'общий слой не вставлен');
    assert.match(body, /function unpackRows|var unpackRows/, 'распаковка не вставлена');
  });

  test(`${file}: в готовом файле не осталось меток шаблона`, () => {
    const filled = fillTemplate(read(file), { json: '{}', unpackJs: UNPACK_JS });
    // Метка в комментарии вставленного общего слоя законна, поэтому ищем её в разметке и
    // в коде, но не считаем ошибкой само слово внутри строки комментария // ...
    const inCode = filled.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const left = inCode.match(/__[A-Z][A-Z0-9_]+__/);
    assert.equal(left, null, `осталась метка ${left && left[0]}`);
  });

  test(`${file}: клики по кнопкам доходят до обработчика`, () => {
    const src = read(file);
    const body = script(file);

    // Слушатели разделены намеренно: change ловит только <select>, click — всё остальное.
    // Кнопка, обработчик которой положили в change, выглядит рабочей и не делает ничего.
    // Берётся код ВСЕХ слушателей click и только их. Слушателей клика в отчёте несколько
    // (основной и отдельный для подсказок), поэтому одного мало; а брать код до конца файла
    // нельзя — туда попадёт слушатель change, и обработчик, лежащий в нём, засчитается
    // достижимым. Тогда тест молча перестанет ловить ту самую ошибку, ради которой написан.
    const chunks = body.split(/addEventListener\('/);
    const clickCode = chunks.filter((c) => c.startsWith('click')).join(' ');
    assert.ok(clickCode.length > 200, 'не нашёл ни одного слушателя click');

    // Два соглашения о маршрутизации: AppRadar 2 разбирает значение data-act, AppRadar 3
    // смотрит на наличие атрибута. Тест проверяет оба, не навязывая ни одного.
    const handledActs = new Set([...clickCode.matchAll(/act === '([a-z0-9-]+)'/gi)].map((m) => m[1]));
    const unreachable = [];
    let buttons = 0;

    for (const m of src.matchAll(/<button[^>]*>/gi)) {
      const tag = m[0];
      const attrs = [...tag.matchAll(/data-([a-z0-9-]+)="([^"]*)"/gi)];
      if (!attrs.length) continue;
      buttons++;
      // Кнопку можно поймать тремя способами, и все три в отчётах встречаются: по значению
      // data-act, по наличию data-атрибута и по классу или id. Тест не навязывает
      // соглашение — он проверяет только, что слушатель клика про кнопку знает.
      // Если у кнопки есть data-act со статическим значением, спрос именно с него и
      // никаких запасных путей: соседние атрибуты вроде data-tab упоминаются в слушателе
      // ради других кнопок, и засчитывать их значит потерять всю строгость проверки.
      const act = attrs.find(([, name, value]) => name === 'act' && /^[a-z0-9-]+$/i.test(value));
      let routed;
      if (act) {
        routed = handledActs.has(act[2]);
      } else {
        const cls = (tag.match(/class="([a-z0-9_ -]*)/i) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
        const id = (tag.match(/id="([a-z0-9_-]+)"/i) || [])[1];
        routed = attrs.some(([, name]) => clickCode.includes(`data-${name}`))
          || cls.some((c) => clickCode.includes(`.${c}`)) || (id && clickCode.includes(id));
      }
      if (!routed) unreachable.push(tag.replace(/\s+/g, ' ').slice(0, 90));
    }

    assert.ok(buttons > 3, `кнопок с data-атрибутами нашлось ${buttons} — похоже, разбор сломался`);
    assert.deepEqual(unreachable, [],
      'кнопки есть, а слушатель click про них не знает: ' + unreachable.join(' | ')
      + '. Частая причина: обработчик положили в слушатель change — туда клик по кнопке не доходит.');
  });

  test(`${file}: каждая подсказка data-tip объявлена в словаре`, () => {
    const src = read(file);
    const body = script(file);
    const known = new Set([...body.matchAll(/^\s*'([a-z0-9._-]+)':\s*\{\s*t:/gim)].map((m) => m[1]));
    for (const m of body.matchAll(/GLOSS\['([a-z0-9._-]+)'\]\s*=/gi)) known.add(m[1]);
    if (!known.size) return;                              // в отчёте нет словаря — нечего сверять
    const used = new Set([...src.matchAll(/data-tip="([a-z0-9._-]+)"/gi)].map((m) => m[1]));
    for (const m of src.matchAll(/tip:\s*'([a-z0-9._-]+)'/gi)) used.add(m[1]);
    for (const m of src.matchAll(/tipIcon\('([a-z0-9._-]+)'\)/gi)) used.add(m[1]);
    const missing = [...used].filter((k) => !known.has(k) && !k.startsWith('b.'));
    assert.deepEqual(missing, [], `подсказки используются, но не объявлены: ${missing.join(', ')}`);
  });
}

test('общий слой одинаков для обоих отчётов и не дублируется в них', () => {
  for (const file of TEMPLATES) {
    const src = read(file);
    assert.equal(src.split('__COMMON_JS__').length - 1, 1, `${file}: метка общего слоя не одна`);
    for (const dup of ['function esc(', 'function short(', 'function isNum(']) {
      assert.equal(src.includes(dup), false, `${file}: ${dup} объявлена в шаблоне — должна браться из общего слоя`);
    }
  }
  assert.ok(COMMON_JS.includes('function short'), 'в общем слое нет short');
});
