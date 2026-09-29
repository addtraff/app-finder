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

// ---------------- подсказки ----------------
//
// Движок один на оба отчёта, словарь у каждого свой: отчёт объявляет GLOSS, здесь только
// показ. Подсказки — сильная сторона этих отчётов и единственное, что отличает их от
// таблицы чисел: каждая величина объясняет, что она такое, как считается и зачем нужна.
// Пока движок жил только в AppRadar 2, третий отчёт оставался без них.
//
// Формат записи словаря: { t: заголовок, what: что это, how: как считается, why: зачем,
// opts: [[значение, пояснение], …] }. Ни одно поле, кроме t, не обязательно.
function tipHtml(el) {
  var dict = (typeof GLOSS === 'object' && GLOSS) || {};
  var g = dict[el.getAttribute('data-tip')], val = el.getAttribute('data-tip-val');
  if (!g && !val) return '';
  var h = '';
  if (g) {
    h += '<h4>' + esc(g.t) + '</h4>';
    if (g.what) h += '<p><b>Что это</b>' + esc(g.what) + '</p>';
    if (g.how) h += '<p><b>Как считается</b>' + esc(g.how) + '</p>';
    if (g.why) h += '<p><b>Зачем</b>' + esc(g.why) + '</p>';
    if (g.opts) h += '<p><b>Варианты</b></p><ul>' + g.opts.map(function (o) {
      return '<li><b style="display:inline;text-transform:none;letter-spacing:0;font-size:12.5px;color:var(--text)">' + esc(o[0]) + '</b> — ' + esc(o[1]) + '</li>';
    }).join('') + '</ul>';
  }
  if (val) h += '<div class="tip-val">' + esc(val).split(String.fromCharCode(10)).join('<br>') + '</div>';
  return h;
}

function tipIcon(key) {
  var dict = (typeof GLOSS === 'object' && GLOSS) || {};
  return dict[key] ? '<button type="button" class="tip-i" data-tip="' + key + '" aria-label="Подсказка: ' + esc(dict[key].t) + '">?</button>' : '';
}

var tipEl = null, tipFor = null;
function showTip(el) {
  var html = tipHtml(el);
  if (!html) return;
  tipFor = el; tipEl.innerHTML = html; tipEl.hidden = false;
  var r = el.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  var top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
}
function hideTip() { tipFor = null; if (tipEl) tipEl.hidden = true; }

// Вызывается один раз при старте отчёта. Слушатели вешаются на документ, поэтому
// перерисовка таблиц их не теряет — иначе подсказки отваливались бы после первого фильтра.
function installTips() {
  if (tipEl) return;
  tipEl = document.createElement('div');
  tipEl.className = 'tip-pop'; tipEl.hidden = true; tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest('[data-tip],[data-tip-val]');
    if (el === tipFor) return;
    if (el) showTip(el); else hideTip();
  });
  document.addEventListener('focusin', function (e) { var el = e.target.closest('[data-tip],[data-tip-val]'); if (el) showTip(el); });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);
  // На сенсорных экранах наведения нет: значок «?» открывает подсказку касанием.
  document.addEventListener('click', function (e) {
    var el = e.target.closest('.tip-i');
    if (el) { e.preventDefault(); if (tipFor === el) hideTip(); else showTip(el); }
  });
}

// ---------------- избранное ----------------
// Список хранится в браузере и к данным отчёта не относится: пересборка его не трогает.
// Отсюда и оговорка в самом отчёте — отмеченное у одного человека не видно другому.
function starBtnHtml(kind, id, on) {
  return '<button class="star" data-act="fav" data-kind="' + esc(kind) + '" data-id="' + esc(id) + '"'
    + ' aria-pressed="' + !!on + '" aria-label="' + (on ? 'Убрать из избранного' : 'В избранное') + '">'
    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round">'
    + '<path d="M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z"/></svg></button>';
}

// Данные страницы лежат сжатыми и в base64. Распакованный JSON отчёта — больше двадцати
// мегабайт, это 98,7 % файла, и именно он упирался в потолок артефакта в 16 МБ. Резать
// строки дальше значило бы выбрасывать то, ради чего отчёт и собирают, поэтому сжимается
// представление, а не содержание. Распаковка в браузере асинхронная — из-за неё тело
// отчёта объявлено async-функцией; все остальные функции остались обычными.
async function readReportData() {
  var el = document.getElementById('radar-data');
  var raw = el.textContent.trim();
  if (el.type.indexOf('base64') < 0) return JSON.parse(raw);   // несжатый — так собирают тесты
  if (typeof DecompressionStream !== 'function') {
    document.body.innerHTML = '<p style="font:16px/1.5 system-ui;padding:32px;max-width:40em">'
      + 'Этот браузер не умеет распаковывать данные отчёта: нет <code>DecompressionStream</code>. '
      + 'Откройте файл в свежем Chrome, Firefox или Safari.</p>';
    throw new Error('нет DecompressionStream');
  }
  var bin = Uint8Array.from(atob(raw), function (c) { return c.charCodeAt(0); });
  var stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
