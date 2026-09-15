// Дата релиза в карточке Play записана на языке карточки: «May 23, 2025», «14 janv. 2018»,
// «20.04.2015», «2017. 9. 7.», «2016年5月2日», «10 ביולי 2023». Date.parse понимает только
// английский вариант, поэтому возраст приложения был известен лишь у половины строк —
// во всех гео с неанглийской карточкой он молча становился пустым.

const MONTHS = {
  en: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  pt: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'],
  fr: ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'],
  it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  de: ['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'],
  nl: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  sv: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  no: ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'],
  da: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  fi: ['tammi', 'helmi', 'maalis', 'huhti', 'touko', 'kesä', 'heinä', 'elo', 'syys', 'loka', 'marras', 'joulu'],
  pl: ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'],
  tr: ['oca', 'şub', 'mar', 'nis', 'may', 'haz', 'tem', 'ağu', 'eyl', 'eki', 'kas', 'ara'],
  he: ['ינו', 'פבר', 'מרץ', 'אפר', 'מאי', 'יוני', 'יולי', 'אוג', 'ספט', 'אוק', 'נוב', 'דצמ'],
  ru: ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
};
const LANG_ALIAS = { nb: 'no', nn: 'no' };
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

function monthOf(token, dict) {
  // Самое длинное совпадение префикса: «juil» не должно совпасть с «juin», «марта» — с «мая».
  let best = 0, bestLen = 0;
  dict.forEach((m, i) => {
    if (token.startsWith(m) && m.length > bestLen) { best = i + 1; bestLen = m.length; }
  });
  return best;
}

function iso(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = Date.parse(`${s}T00:00:00Z`);
  // 31 февраля и подобное Date.parse переносит на март — такую дату не принимаем.
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : null;
}

// Возвращает 'YYYY-MM-DD' или null. hl — язык карточки (en, fr, pt-BR, zh-TW…).
export function parseReleased(text, hl = 'en') {
  if (!text || typeof text !== 'string') return null;
  const s = text
    .replace(ARABIC_DIGITS, (ch) => String((ch.charCodeAt(0) & 0xf) % 10))
    .replace(/[‎‏]/g, '')
    .trim();

  let m = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);               // 2025/07/20, 2017. 9. 7., 2016年5月2日
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\D{1,3}(\d{1,2})\D{1,3}(\d{4})$/);          // 20.04.2015, 10.2.2022, 08/01/2026
  if (m) return iso(+m[3], +m[2], +m[1]);

  const tokens = s.toLowerCase().match(/[\p{L}]+|\d+/gu) || [];
  const year = tokens.find((t) => /^\d{4}$/.test(t));
  const day = tokens.find((t) => /^\d{1,2}$/.test(t));
  const words = tokens.filter((t) => !/^\d+$/.test(t))
    .map((t) => t.replace(/^ב(?=\p{L}{2})/u, ''));                    // иврит: «ביולי» → «יולי»
  if (year && day && words.length) {
    const base = String(hl || 'en').toLowerCase().split('-')[0];
    const lang = LANG_ALIAS[base] || base;
    const order = [MONTHS[lang], ...Object.values(MONTHS)].filter(Boolean);
    for (const dict of order) {
      for (const w of words) {
        const month = monthOf(w, dict);
        if (month) return iso(+year, month, +day);
      }
    }
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export function ageMonthsAt(released, hl, dateIso) {
  const r = parseReleased(released, hl);
  if (!r) return null;
  const months = (Date.parse(dateIso) - Date.parse(r)) / 86400000 / 30.44;
  return Number.isFinite(months) ? months : null;
}
