# Command palette `/` и реестр команд G+G

## Цель и граница безопасности

При вводе `/` в пустом composer приложение в будущем показывает локальную command palette. Распознанная команда исполняется приложением и не отправляется модели. Произвольный текст не становится shell-командой, IPC-вызовом или системным prompt. В реализации запрещены `eval`, динамический импорт пользовательского пути и обход действующих permission/security boundary.

## Типизированный реестр

```ts
interface AppCommand {
  id: string;
  aliases: string[];
  title: string;
  description: string;
  category: string;
  icon?: IconId;
  availability: CommandAvailability;
  risk: "SAFE" | "CONFIRM" | "DANGEROUS";
  execute: CommandHandler;
}
```

- `id` неизменяем и не зависит от языка интерфейса.
- Alias вида `/new-project` стабилен; локализованные названия — только представление.
- `availability` возвращает доступность и человекочитаемую причину блокировки.
- `execute` вызывает только заранее зарегистрированный handler и типизированный preload IPC.
- `CONFIRM` и `DANGEROUS` требуют отдельного подтверждения; подтверждение не хранится как глобальное разрешение.

## UX и клавиатура

Palette открывается только для `/` в начале пустого composer. Она фильтрует по title, alias и description, поддерживает ArrowUp/ArrowDown, Enter, Escape, видимый focus и screen-reader label. Недоступные команды остаются в списке с причиной. Escape закрывает palette и возвращает focus в composer. Неизвестная команда остаётся обычным черновиком и не исполняется; перед отправкой пользователю показывается, что она не распознана.

Первый безопасный набор: `/prompt`, `/prompt-manual`, `/mode`, `/models`, `/new-project`, `/stop`, `/retry`, `/attach`, `/spec`, `/diagnostics`, `/clear-draft`. `/delete-project` и будущие destructive-команды должны открывать существующий подтверждающий UI, а не выполнять удаление напрямую.

## Жизненный цикл prompt

Нужно различать четыре сущности:

1. обычное пользовательское сообщение — сохраняется в transcript и отправляется участникам;
2. временная инструкция run — видима в composer, действует один run и не сохраняется глобально;
3. сохранённый шаблон — локальная пользовательская запись с явным выбором;
4. provider/system prompt — версия приложения с отдельным управлением и аудитом.

Временная инструкция не запускает CLI, не меняет security policy, не получает cookies/tokens и не становится глобальной без отдельного подтверждения.

## Предлагаемая архитектура

- `AppCommandRegistry`: статический список команд и проверка уникальности ID/alias.
- `CommandContext`: project, run state, permissions и доступные typed actions без raw IPC.
- `CommandPalette`: чистый UI поиска/keyboard navigation.
- `CommandDispatcher`: повторно проверяет availability/risk непосредственно перед вызовом.
- `CommandAudit`: локально пишет command ID, результат и время без prompt/cookie/token payload.

## Acceptance будущей реализации

- команда не попадает в provider message;
- неизвестная команда ничего не исполняет;
- dangerous action невозможно вызвать без confirmation;
- keyboard-only сценарий полностью доступен;
- никакой пользовательский аргумент не интерпретируется как shell/JS;
- unit tests реестра, availability и dispatcher; component tests palette; Electron smoke безопасных команд.
