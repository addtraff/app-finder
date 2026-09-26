// Общий слой отчётов: примитивы форматирования и мелкие утилиты.
//
// До 27.09 каждый отчёт нёс свою копию esc, short, fix, pct и dash, и копии успели
// разойтись: esc в AppRadar 3 не экранировал апостроф, pct ставил пробел перед знаком
// процента, а short печатал «1,2 млн» там, где AppRadar 2 печатал «1.2M». Одна и та же
// дверь выглядела в двух отчётах по-разному, и каждая правка формата делалась дважды.
//
// За образец взяты версии AppRadar 2 — он главный, и менять его вид ради унификации
// значило бы чинить меньшую проблему большей. AppRadar 3 после этой правки печатает числа
// так же, как второй.
//
// Файл вставляется в шаблон целиком на сборке, вместо своей метки, как это уже сделано с
// распаковкой строк. Отдельным <script src> он быть не может: отчёт — один файл, который
// открывают с диска и пересылают целиком.

var $ = function (id) { return document.getElementById(id); };

// Апостроф экранируется намеренно: значения попадают в атрибуты вида title='...' и
// data-tip-val='...', и без него название приложения с кавычкой рвёт разметку.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Пусто — это не ноль. Всё, что ниже, на отсутствие числа отвечает прочерком, а не нулём:
// «0 установок» и «установки неизвестны» — разные утверждения, и путать их нельзя.
function isNum(n) { return typeof n === 'number' && isFinite(n); }

function short(n) {
  if (!isNum(n)) return '—';
  var a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + (a / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace('.0', '') + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.0', '') + 'M';
  if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace('.0', '') + 'K';
  return s + String(Math.round(a));
}

function int(n) { return isNum(n) ? Math.round(n).toLocaleString('ru-RU') : '—'; }
function fix(n, d) { return isNum(n) ? n.toFixed(d == null ? 1 : d) : '—'; }
function pct(n, d) { return isNum(n) ? (n * 100).toFixed(d == null ? 0 : d) + '%' : '—'; }

// Прочерк с подписью: почему пусто. Подпись обязательна по смыслу — пустая ячейка без
// объяснения читается как ноль, и именно так рождаются выводы на пустом месте.
function dash(title) { return '<span class="muted" title="' + esc(title || 'нет данных') + '">—</span>'; }

function dmy(s) { return s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : '—'; }
function addDays(s, n) { var d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function median(arr) {
  var a = arr.filter(isNum).sort(function (x, y) { return x - y; });
  if (!a.length) return null;
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

// Отношение «дверь в тройку к двери в десятку» читаемо, пока оно двузначное. Когда дверь в
// десятку задана приложением с «0+» установок, отношение вылетает в миллионы, и печатать
// его с десятой долей — значит делать вид, что мы измерили именно столько.
function doorRatio(a, b) {
  if (!isNum(a) || !isNum(b) || b <= 0) return '';
  var r = a / b;
  if (r >= 1000) return '×' + short(Math.round(r)) + ' — в десятке стоит приложение почти без установок';
  return '×' + (r >= 100 ? Math.round(r) : fix(r, 1).replace('.0', ''));
}

// Хранилище браузера может быть недоступно — в приватном окне, при запрете данных сайта и
// при открытии файла с диска. Отчёт обязан работать и без него, поэтому обе операции молча
// возвращают значение по умолчанию вместо исключения.
function load(key, def) { try { var v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* хранилище недоступно */ } }
