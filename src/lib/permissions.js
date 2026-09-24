// Разрешения приложения и стоимость повторения (ТЗ AppRadar 3, этап 1, пункт 9).
//
// Разрешения — единственное место в карточке, по которому заранее видно, во что обойдётся
// повторение: SMS, журнал звонков, фоновая геолокация, установка других приложений и
// спецдоступ требуют отдельной формы в Play Console и чаще всего заканчиваются отказом.
//
// Одна тонкость определяет здесь всё. Play отдаёт НАЗВАНИЯ разрешений на языке витрины, а
// снимали мы их языком гео: из 3 391 списка в базе 2 200 на иврите, арабском, китайском,
// португальском. Английские шаблоны из config/institutions.json по ним не срабатывают, и
// приложение молча получало «опасных разрешений нет» вместо «не проверено» — худший вид
// ошибки, потому что он выглядит как хорошая новость. Поэтому:
//   • снимаем всегда на английском — сами разрешения от языка витрины не зависят, только
//     их подписи;
//   • список на другом языке считаем НЕПРОВЕРЕННЫМ, а не чистым.
//
// Группы разрешений в английской витрине — закрытый список, по нему язык и определяется.
const EN_GROUPS = [
  'Other', 'Storage', 'Photos/Media/Files', 'Camera', 'Microphone', 'Location', 'Contacts',
  'Phone', 'SMS', 'Calendar', 'Wi-Fi connection information', 'Device ID & call information',
  'Identity', 'Body Sensors', 'Wearable sensors/activity data', 'Bluetooth',
  'Device & app history', 'Cellular data settings', 'Music', 'Notifications', 'Nearby devices',
  'Files', 'Motion sensors', 'Installed apps', 'Health Connect',
];
const ESC = /[.*+?^${}()|[\]\\]/g;
const EN_RE = new RegExp('^(' + EN_GROUPS.map((g) => g.replace(ESC, '\\$&')).join('|') + ')\\b');

export function parsePerms(json) {
  if (!json) return null;
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) && a.length ? a.map(String) : null;
  } catch { return null; }
}

// 'en' — подписи английские и шаблоны применимы; 'other' — язык витрины, проверить нечем.
export function permsLang(list) {
  if (!list || !list.length) return null;
  return list.some((p) => EN_RE.test(p)) ? 'en' : 'other';
}

// Найденные опасные разрешения либо null, если проверить было нечем. Возвращается сам
// список меток, а не флаг: в отчёте важно, ЧТО именно требует приложение.
export function riskyPerms(list, riskyLabels) {
  if (permsLang(list) !== 'en') return null;
  const low = riskyLabels.map((s) => s.toLowerCase());
  return list.filter((p) => low.some((l) => p.toLowerCase().includes(l)));
}

// Стоимость повторения по трём осям ТЗ: разрешения, политика, зависимость от внешних данных.
// Градаций три, и они не складываются в балл — балл потребовал бы весов, которых нам взять
// неоткуда. Ось, по которой нет сведений, не засчитывается ни в плюс, ни в минус: уровень
// тогда становится нижней границей, и это прямо помечается в unknown.
//
// Третья ось названа по тому, что мы действительно умеем проверить. Заглянуть в код
// приложения и увидеть вызовы чужого API мы не можем — APK (файл установки приложения) не
// скачиваем. Зато категория говорит сама за себя: погода, карты, транспорт, новости и цены
// живут на внешнем потоке данных, и повторить такое приложение — это не только написать
// его, но и достать (обычно купить) сам поток. Это правило уровня категории, а не разбор
// конкретного кода, и так оно и подписано в отчёте.
export function copyability({ perms, riskyLabels, genreId, policyRiskCats, feedCats }) {
  const risky = riskyPerms(perms, riskyLabels);
  const reasons = [];
  const unknown = [];
  if (risky == null) unknown.push('разрешения не сняты');
  else if (risky.length) reasons.push('опасные разрешения: ' + risky.length);
  const polRisk = genreId ? policyRiskCats.has(genreId) : null;
  if (polRisk == null) unknown.push('категория неизвестна');
  else if (polRisk) reasons.push('категория под усиленной модерацией');
  const feed = genreId ? feedCats.has(genreId) : null;
  if (feed) reasons.push('нужен внешний поток данных');
  const level = reasons.length === 0 ? 'easy' : reasons.length === 1 ? 'medium' : 'hard';
  return { level, reasons, risky, unknown, checked: risky != null ? 1 : 0 };
}
