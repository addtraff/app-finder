// Общий слой отчётов, вставляемый в шаблон на сборке.
//
// Тот же приём, что у распаковки строк: отчёт — один самодостаточный файл, отдельным
// <script src> общий код быть не может. Читается один раз на процесс; стадии подставляют
// его вместо метки __COMMON_JS__.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './db.js';

export const COMMON_JS = fs.readFileSync(path.join(ROOT, 'src', 'report', 'common.js'), 'utf8');

// Одно место, через которое шаблон превращается в готовый фрагмент. Нужно и сборке, и
// тестам: тест обязан проверять ровно то, что уедет в файл, а не шаблон с метками.
export function fillTemplate(tpl, { json, unpackJs }) {
  // Проверяется шаблон, а не результат: во вставляемый текст метка может попасть законно,
  // например в комментарии. Незаполненная метка — это сломанный отчёт, а не мелочь: она
  // остаётся в теле <script> обычным текстом, разбор падает, страница не рисуется совсем.
  // 27.09 в 00:37 такой файл уже был записан поверх рабочего — процесс вчерашнего обхода
  // прочитал новый шаблон своим старым кодом, который про метку не знал.
  const KNOWN = ['__COMMON_JS__', '__UNPACK_JS__', '__RADAR_DATA__'];
  const found = [...new Set(tpl.match(/__[A-Z][A-Z0-9_]+__/g) || [])];
  const unknown = found.filter((m) => !KNOWN.includes(m));
  if (unknown.length) throw new Error(`в шаблоне отчёта неизвестная метка: ${unknown.join(', ')}`);
  for (const m of KNOWN) {
    const n = tpl.split(m).length - 1;
    if (n !== 1) throw new Error(`метка ${m} встречается в шаблоне ${n} раз вместо одного`);
  }
  return tpl
    .replace('__COMMON_JS__', () => COMMON_JS)
    .replace('__UNPACK_JS__', () => unpackJs)
    .replace('__RADAR_DATA__', () => json);
}
