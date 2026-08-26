# Phase E — regression fix прокрутки каталога моделей

Дата проверки: 2026-08-26.

## Причина

Панель поиска и карточки находились внутри общего прокручиваемого `settings-content`. У списка моделей не было отдельного flex viewport и clipping boundary, поэтому карточка могла рисоваться поверх toolbar при прокрутке.

## Исправление

- Вкладка моделей разделена на непрозрачный `models-catalog-header` и независимый `models-settings-list`.
- Оболочка вкладки имеет `min-height: 0` и `overflow: hidden`.
- Только список использует `overflow-y: auto`; горизонтальная прокрутка запрещена.
- Header имеет тематический непрозрачный фон, локальный `z-index`, нижнюю границу и тень.
- Карточкам не добавлен повышенный `z-index`; footer остаётся вне scroll-container.

## Geometry smoke

Production Electron renderer, browser zoom `1` (100%):

- 5, 20 и 50 карточек;
- 1920×1080 dark, 1366×768 light, 1100×700 dark;
- поиск после прокрутки и раскрытие карточки;
- `headerRect` внутри modal;
- `listRect` между header и footer;
- первая карточка уходит выше границы списка, но `elementFromPoint` над списком не видит карточку;
- `scrollHeight > clientHeight`;
- `documentElement.scrollWidth <= clientWidth`;
- footer и поле поиска остаются доступными.

## Скриншоты всего окна

- `docs/screenshots/phase-e-model-catalog-1920x1080-dark.png`
- `docs/screenshots/phase-e-model-catalog-1366x768-light.png`
- `docs/screenshots/phase-e-model-catalog-1100x700-dark.png`
