# Этап 0 iOS-радара: живая проверка эндпоинтов App Store

Два скрипта для «этапа 0» из `docs/tz-ios-radar.md` (раздел 16 и приложение А). Node ≥ 22,
без зависимостей — только глобальный `fetch`. Запускать с машины, у которой есть прямой доступ
к хостам Apple: из облачной среды, где писалось ТЗ, все хосты `*.apple.com` были закрыты
прокси, поэтому **ни один из скриптов не прогонялся вживую**. Проверены только синтаксис,
план запросов (`--plan`) и самотест парсера подсказок (`--selftest`).

Оба скрипта делают только GET-запросы с паузами (≈0,8 запроса/с), ничего не пишут, кроме
JSON-результата в текущую папку. Серии «темп до отказа» (1 / 2 / 5 запросов/с по 30 запросов
с паузой на восстановление) включены по умолчанию в `ios-smoke.mjs`; если не хотите нагружать
свой IP — `--skip-rate`.

## `ios-smoke.mjs` — 86 проверок эндпоинтов

```bash
node tools/ios-spike/ios-smoke.mjs --plan                 # напечатать план URL без сети
node tools/ios-spike/ios-smoke.mjs --skip-rate            # ~10 минут, без серий темпа
node tools/ios-spike/ios-smoke.mjs --cc us --out ./ios-smoke-us.json   # полный прогон, ~45–60 минут
```

Что проверяет: iTunes Search/Lookup API (лимит 200, iPhone/iPad, язык, кэш, предел пачки
lookup), приватный поиск MZStore (жив ли, честен ли `limit`, iPad, реклама в ответе),
`tools.applemediaservices`, подсказки `MZSearchHints` (формат, число, поле `priority`,
обязательность заголовка, `trends`), чарты (RSS v2, legacy RSS с жанрами и `new*`, `viewTop`
на 200), отзывы RSS (10 страниц, страница 11), гистограмма оценок, страница `apps.apple.com`
(JSON-блоки, токен, IAP, privacy labels), `amp-api` и `amp-api-edge`, «похожие». В конце —
блок `verdicts` с ответами «да/нет/число» на вопросы приложения А ТЗ.

Прогнать **с двух разных IP** (домашний и серверный): отзывы RSS с облачных адресов, по
свидетельствам 2026 года, могут приходить пустыми.

## `hints-probe.mjs` — подсказки как сигнал спроса

```bash
node tools/ios-spike/hints-probe.mjs --selftest                        # парсер, без сети
node tools/ios-spike/hints-probe.mjs --rps=1 --egress=home --out=hints-us.json
node tools/ios-spike/hints-probe.mjs --only=prefix,header               # подмножество этапов
node tools/ios-spike/hints-probe.mjs --asa=asa.csv                      # CSV term,popularity → Spearman
```

Снимает лестницу префиксов для 30 фраз (US, DE, JP), проверяет, возвращается ли `priority` и
постоянен ли он между префиксами, число подсказок, влияние заголовка `X-Apple-Store-Front` и
языка, темп до отказа, `trends`, долю названий приложений среди подсказок и ранговую
корреляцию с популярностью Apple Ads (если передан CSV). Вердикт в `meta.verdict`:
`PRIORITY_ABSENT` / `PRIORITY_IS_TERM_PROPERTY` / `PRIORITY_IS_PREFIX_DEPENDENT` — от него
зависит вариант модуля спроса L0 (ТЗ, §5.2).

## Куда класть результаты

JSON-файлы результатов — в `out/ios-spike/` (папка `out/` в `.gitignore`). Числа из них
переносятся в приложение А ТЗ со статусом A и датой прогона.
