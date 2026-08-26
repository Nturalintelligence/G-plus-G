import React, { useEffect, useRef, useState } from "react";
import { CloseIcon } from "./Icon.js";

const specLight = new URL("../../../../docs/screenshots/phase-e-spec-1366x768-light.png", import.meta.url).href;
const specDark = new URL("../../../../docs/screenshots/phase-e-spec-1100x700-dark.png", import.meta.url).href;

export const SPEC_HELP_VERSION = "1.0.0";

type HelpSection = { id: string; title: string; explanation: string; when: string; good?: string; bad?: string; steps?: string[]; warning?: string; image?: string; caption?: string };
const sections: HelpSection[] = [
  { id: "about", title: "Что такое спецификация", explanation: "Спецификация — постоянная память и набор правил проекта. Пользователь и ИИ обсуждают задачу → договорённости попадают в спецификацию → следующие ответы получают актуальный контекст → готовность проверяется по критериям приёмки.", when: "Используйте её, когда важное решение должно сохраниться между сообщениями.", warning: "Спецификация не запускает команды и код. Она только передаёт моделям структурированный контекст проекта.", image: specLight, caption: "Конструктор спецификации в светлой теме." },
  { id: "requirements", title: "Требования", explanation: "Обязательные конкретные условия будущего результата.", when: "Когда условие должно учитываться во всех следующих ответах.", good: "Приложение должно поддерживать PNG, TXT, MD и PDF.", bad: "Сделать хорошо — это нельзя однозначно проверить.", steps: ["Откройте Спецификацию", "Выберите Требования", "Нажмите Добавить пункт", "Запишите одно проверяемое условие", "При необходимости привяжите ответ ИИ", "Нажмите Готово", "Сохраните черновик или утвердите спецификацию"] },
  { id: "constraints", title: "Ограничения", explanation: "То, что запрещено или ограничено при выполнении задачи.", when: "Когда нужно исключить технологию, расход или внешнюю зависимость.", good: "Без backend и платных API.", bad: "Ничего сложного." },
  { id: "decisions", title: "Принятые решения", explanation: "Уже согласованные решения, которые не следует обсуждать заново без причины.", when: "После выбора архитектуры или подхода.", good: "Использовать HTML/CSS/JavaScript.", bad: "Наверное, использовать веб-технологии." },
  { id: "rejected", title: "Отклонённые варианты", explanation: "Подходы, от которых отказались, вместе с причиной.", when: "Чтобы модели не предлагали повторно проверенный неудачный вариант.", good: "Electron отклонён: игра должна открываться в браузере.", bad: "Electron не нравится." },
  { id: "questions", title: "Открытые вопросы", explanation: "Вопросы, по которым ещё требуется решение пользователя или проверка.", when: "Когда нельзя безопасно сделать предположение.", good: "Нужен ли мобильный режим?", bad: "Что-нибудь ещё?" },
  { id: "acceptance", title: "Критерии приёмки", explanation: "Проверяемые условия готовности результата.", when: "Перед реализацией и финальной проверкой.", good: "index.html открывается локально, игра запускается без ошибок.", bad: "Всё работает красиво." },
  { id: "sources", title: "Привязка пункта к ответу ИИ", explanation: "Привязка фиксирует происхождение требования или решения, но не передаёт управление модели.", when: "Когда важно сохранить источник договорённости.", warning: "Удаление привязки не удаляет сообщение; пункт может оставаться без источника. Исчезновение исходного сообщения не должно молча удалять пункт." },
  { id: "json", title: "Экспертный режим JSON", explanation: "Это машинное представление реальных разделов requirements, constraints, decisions, rejectedOptions, openQuestions и acceptanceCriteria. Каждый пункт содержит id, text и sourceTurnIds; решения также могут содержать rationale.", when: "Для экспорта, импорта, резервного копирования и диагностики. Обычному пользователю редактировать JSON не требуется.", good: "{\n  \"requirements\": [{ \"id\": \"r1\", \"text\": \"Работает локально\", \"sourceTurnIds\": [] }]\n}", warning: "Невалидный JSON не применяется. JSON не является CLI-командой и ничего не запускает." },
  { id: "example", title: "Практический пример", explanation: "Проект: создать браузерную игру без установки. Требование: Chrome, Edge и Firefox. Ограничение: без backend и платных API. Решение: HTML/CSS/JavaScript. Отклонено: Electron. Вопрос: нужен ли мобильный режим. Критерий: index.html запускает игру локально без ошибок.", when: "Используйте этот шаблон, чтобы отделять обязательное, запрещённое, решённое и ещё не решённое.", image: specDark, caption: "Спецификация на компактном окне в тёмной теме." },
  { id: "mistakes", title: "Частые ошибки", explanation: "Не объединяйте несколько разных условий в один пункт, не используйте субъективные слова без метрики и не помещайте нерешённый вопрос в принятые решения.", when: "Проверьте раздел перед утверждением.", warning: "Черновик можно свободно редактировать. Кнопка «Утвердить» фиксирует текущую версию как APPROVED; последующее сохранение создаёт новую ревизию через существующий механизм Project State." },
];

export function SpecificationHelpModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() => sessionStorage.getItem("gplusg.specHelpSection") || "about");
  const [preview, setPreview] = useState<{ src: string; caption: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const filtered = sections.filter((item) => `${item.title} ${item.explanation} ${item.when}`.toLocaleLowerCase("ru-RU").includes(query.toLocaleLowerCase("ru-RU")));
  const selected = filtered.find((item) => item.id === active) ?? filtered[0] ?? sections[0]!;
  const select = (id: string) => { setActive(id); sessionStorage.setItem("gplusg.specHelpSection", id); };

  useEffect(() => {
    const dialog = dialogRef.current; if (!dialog) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); if (preview) setPreview(null); else onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener("keydown", keydown); return () => dialog.removeEventListener("keydown", keydown);
  }, [onClose, preview]);

  return <div className="modal-backdrop spec-help-backdrop" role="presentation" onMouseDown={onClose}>
    <div ref={dialogRef} className="spec-help-modal" role="dialog" aria-modal="true" aria-labelledby="spec-help-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="spec-help-header"><div><h2 id="spec-help-title">Как работать со спецификацией?</h2><small>Справка версии {SPEC_HELP_VERSION}</small></div><button type="button" aria-label="Закрыть справку" onClick={onClose}><CloseIcon size={18}/></button></header>
      <div className="spec-help-layout"><nav aria-label="Разделы справки"><input type="search" aria-label="Поиск по справке" placeholder="Поиск" value={query} onChange={(event) => setQuery(event.target.value)}/>{filtered.map((item) => <button type="button" className={item.id === selected.id ? "active" : ""} key={item.id} onClick={() => select(item.id)}>{item.title}</button>)}</nav>
        <article className="spec-help-content" tabIndex={0}><h3>{selected.title}</h3><p>{selected.explanation}</p><h4>Когда использовать</h4><p>{selected.when}</p>{selected.good ? <><h4>Хороший пример</h4><pre>{selected.good}</pre></> : null}{selected.bad ? <><h4>Плохой пример</h4><p>{selected.bad}</p></> : null}{selected.steps ? <><h4>Пошагово</h4><ol>{selected.steps.map((step) => <li key={step}>{step}</li>)}</ol></> : null}{selected.warning ? <aside className="spec-help-warning">{selected.warning}</aside> : null}{selected.image ? <figure><button type="button" className="spec-help-image" onClick={() => setPreview({ src: selected.image!, caption: selected.caption! })}><img src={selected.image} alt={selected.caption}/></button><figcaption>{selected.caption}</figcaption></figure> : null}</article></div>
      <footer><button type="button" onClick={onClose}>Назад к спецификации</button></footer>
      {preview ? <div className="spec-help-preview" role="dialog" aria-modal="true" aria-label="Увеличенный screenshot" onMouseDown={() => setPreview(null)}><div onMouseDown={(event) => event.stopPropagation()}><button type="button" aria-label="Закрыть изображение" onClick={() => setPreview(null)}>×</button><img src={preview.src} alt={preview.caption}/><p>{preview.caption}</p></div></div> : null}
    </div>
  </div>;
}

// Owner: specification UI maintainers must update help content/assets with schema or workflow changes.
