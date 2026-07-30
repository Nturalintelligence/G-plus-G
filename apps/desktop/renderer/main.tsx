import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";

const initialState = {
  requirements: [],
  constraints: [],
  decisions: [],
  rejectedOptions: [],
  openQuestions: [],
  acceptanceCriteria: [
    { id: "acceptance-1", text: "Define acceptance criterion", sourceTurnIds: [] },
  ],
};

const fallbackSettings: AppSettingsView = {
  schemaVersion: 1,
  profile: { displayName: "" },
  defaults: {
    mode: "DEBATE",
    providers: ["chatgpt", "gemini"],
    limits: {
      maxTurns: 6,
      maxTurnMs: 180_000,
      maxSessionMs: 900_000,
      maxRetries: 1,
      confirmationEvery: 2,
    },
  },
  appearance: { theme: "dark", density: "comfortable", fontScale: 100 },
};

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [current, setCurrent] = useState<ProjectDetails | null>(null);
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [mode, setMode] = useState("DEBATE");
  const [providers, setProviders] = useState(["chatgpt", "gemini"]);
  const [stateText, setStateText] = useState(JSON.stringify(initialState, null, 2));
  const [status, setStatus] = useState("Готово");
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState<AppSettingsView>(fallbackSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const outputRef = useRef<HTMLElement>(null);

  const refresh = async (): Promise<void> => setProjects(await window.orchestrator.projects.list());
  useEffect(() => void refresh(), []);
  useEffect(() => {
    void window.orchestrator.settings.get().then((value) => {
      setSettings(value);
      setMode(value.defaults.mode);
      setProviders(value.defaults.providers);
    }).catch((error) => setStatus(`Настройки не загружены: ${String(error)}`));
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.appearance.theme;
    root.dataset.density = settings.appearance.density;
    root.style.fontSize = `${settings.appearance.fontScale}%`;
  }, [settings.appearance]);
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
  }, [current?.transcript.length]);
  useEffect(() => {
    if (!running || !current) return;
    const projectId = current.project.id;
    const timer = window.setInterval(() => {
      void window.orchestrator.projects.open(projectId).then(setCurrent).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [running, current?.project.id]);

  async function openProject(id: string): Promise<void> {
    const details = await window.orchestrator.projects.open(id);
    setCurrent(details);
    if (details.state) setStateText(JSON.stringify(details.state.state, null, 2));
  }

  async function run(): Promise<void> {
    const submittedTask = task.trim();
    if (!current || !submittedTask || running || providers.length === 0) return;
    const projectId = current.project.id;
    setTask("");
    setRunning(true);
    setStatus("Модели обсуждают сообщение…");
    try {
      const output = await window.orchestrator.orchestration.run({
        projectId,
        mode,
        task: submittedTask,
        providers,
        limits: settings.defaults.limits,
      });
      setStatus(output.status);
      await openProject(projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message.replace(/^Error invoking remote method '[^']+': Error:\s*/, ""));
      await openProject(projectId);
    } finally {
      setRunning(false);
    }
  }

  async function login(provider: string): Promise<void> {
    setStatus(`Войдите в ${provider} в открывшемся окне…`);
    try {
      const session = await window.orchestrator.provider.login(provider);
      setStatus(`${provider}: ${session}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveSettings(): Promise<void> {
    try {
      const saved = await window.orchestrator.settings.save(settings);
      setSettings(saved);
      setMode(saved.defaults.mode);
      setProviders(saved.defaults.providers);
      setSettingsOpen(false);
      setStatus("Настройки сохранены");
    } catch (error) {
      setStatus(`Настройки не сохранены: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function updateLimit(name: keyof AppSettingsView["defaults"]["limits"], value: string): void {
    setSettings((currentSettings) => ({
      ...currentSettings,
      defaults: {
        ...currentSettings.defaults,
        limits: { ...currentSettings.defaults.limits, [name]: Number(value) },
      },
    }));
  }

  async function saveState(): Promise<void> {
    if (!current) return;
    try {
      const parsed = JSON.parse(stateText);
      await window.orchestrator.state.save(current.project.id, parsed);
      await openProject(current.project.id);
      setStatus("Черновик Project State сохранён");
    } catch (error) {
      setStatus(
        `Project State не сохранён: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function relay(entry: ConversationEntryView): void {
    setTask(
      `Проверь и развей следующий ответ другой модели.\n\n<UNTRUSTED_PEER_RESPONSE>\n${entry.content}\n</UNTRUSTED_PEER_RESPONSE>`,
    );
    setMode("MANUAL");
    setStatus("Ответ помещён в редактор. Выберите модель, отредактируйте текст и отправьте.");
  }

  return (
    <main>
      <header>
        <div><span className="mark">G+G</span><h1>Multi-model workspace</h1></div>
        <div className="header-actions">
          <span className="status" role="status" aria-live="polite">{status}</span>
          <button onClick={() => setSettingsOpen(true)}>
            {settings.profile.displayName || "Профиль"} · Настройки
          </button>
        </div>
      </header>
      <div className="layout">
        <aside>
          <h2>Проекты</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void window.orchestrator.projects.create(name).then(async (project) => {
                setName("");
                await refresh();
                await openProject(project.id);
              });
            }}
          >
            <input aria-label="Название проекта" value={name} onChange={(event) => setName(event.target.value)} placeholder="Название проекта" />
            <button>Создать</button>
          </form>
          <nav>
            {projects.map((project) => (
              <button
                className={current?.project.id === project.id ? "selected" : ""}
                key={project.id}
                onClick={() => void openProject(project.id)}
              >
                <strong>{project.name}</strong><small>{project.status}</small>
              </button>
            ))}
          </nav>
          <h2>Сессии</h2>
          {["chatgpt", "gemini"].map((provider) => (
            <button key={provider} onClick={() => void login(provider)}>
              Войти · {provider}
            </button>
          ))}
        </aside>
        <section className="workspace">
          <div className="composer panel">
            <h2>{current?.project.name ?? "Выберите проект"}</h2>
            <textarea
              aria-label="Сообщение для моделей"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void run();
                }
              }}
              placeholder="Напишите сообщение… Enter — отправить, Shift+Enter — новая строка"
            />
            <div className="controls">
              <select aria-label="Режим оркестрации" value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="DEBATE">Обсуждение — ИИ видят ответы друг друга</option>
                <option value="SEQUENTIAL">Рецензирование — по очереди</option>
                <option value="PARALLEL">Независимые ответы</option>
                <option value="MANUAL">Один ответ</option>
              </select>
              {["chatgpt", "gemini"].map((provider) => (
                <label key={provider}>
                  <input
                    type="checkbox"
                    checked={providers.includes(provider)}
                    onChange={() =>
                      setProviders((value) => {
                        const next = value.includes(provider)
                          ? value.filter((item) => item !== provider)
                          : [...value, provider];
                        if (
                          next.length < 2 &&
                          (mode === "DEBATE" || mode === "SEQUENTIAL")
                        ) {
                          setMode("MANUAL");
                        }
                        return next;
                      })
                    }
                  /> {provider}
                </label>
              ))}
              <button
                className="primary"
                disabled={!current || !task.trim() || running || providers.length === 0}
                onClick={() => void run()}
              >
                {running ? "Идёт обсуждение…" : "Отправить"}
              </button>
              <button onClick={() => void window.orchestrator.orchestration.pause()}>Пауза</button>
              <button onClick={() => void window.orchestrator.orchestration.resume()}>Продолжить</button>
              <button onClick={() => void window.orchestrator.orchestration.stop()}>Стоп</button>
            </div>
          </div>
          <article className="panel output" ref={outputRef}>
            {current?.transcript.length ? (
              current.transcript.map((entry) => (
                <section className={`message ${entry.role.toLowerCase()}`} key={entry.id}>
                  <header>
                    <strong>{entry.role === "USER" ? "Вы" : entry.providerId ?? entry.role}</strong>
                    {entry.round ? <small>ход {entry.round}</small> : null}
                  </header>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{
                      a: ({ href, children }) => {
                        if (!href || !/^https?:\/\//i.test(href)) {
                          return <span>{children}</span>;
                        }
                        return (
                          <a href={href} target="_blank" rel="noreferrer noopener">
                            {children}
                          </a>
                        );
                      },
                    }}
                  >
                    {entry.content}
                  </ReactMarkdown>
                  {entry.role === "ASSISTANT" ? (
                    <button className="relay" onClick={() => relay(entry)}>
                      Передать дальше
                    </button>
                  ) : null}
                </section>
              ))
            ) : (
              <p className="empty">Здесь сохранится весь разговор ChatGPT, Gemini и ваш.</p>
            )}
          </article>
        </section>
        <aside className="inspector">
          <h2>Состояние проекта</h2>
          <textarea value={stateText} onChange={(event) => setStateText(event.target.value)} />
          <div className="controls">
            <button
              disabled={!current}
              onClick={() => void saveState()}
            >Сохранить черновик</button>
            <button
              disabled={!current?.state || current.state.status === "APPROVED"}
              onClick={() =>
                current?.state &&
                void window.orchestrator.state
                  .approve(current.state.id)
                  .then(() => openProject(current.project.id))
              }
            >Утвердить</button>
            <button
              disabled={!current}
              onClick={() =>
                current &&
                void window.orchestrator.exports
                  .spec(current.project.id)
                  .then((value) => setStatus(`Экспортировано: ${value.directory}`))
              }
            >Экспорт</button>
          </div>
          <h2>События</h2>
          <ol className="timeline">
            {current?.events.slice().reverse().map((event) => (
              <li key={event.sequence}><strong>{event.eventType}</strong><small>{event.occurredAt}</small></li>
            ))}
          </ol>
        </aside>
      </div>
      {settingsOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h1 id="settings-title">Профиль и настройки</h1>
                <p>Хранятся только локально. Пароли и токены сюда не записываются.</p>
              </div>
              <button aria-label="Закрыть настройки" onClick={() => setSettingsOpen(false)}>×</button>
            </header>
            <div className="settings-content">
              <fieldset>
                <legend>Профиль</legend>
                <label>Отображаемое имя
                  <input
                    maxLength={80}
                    value={settings.profile.displayName}
                    onChange={(event) => setSettings((value) => ({
                      ...value,
                      profile: { displayName: event.target.value },
                    }))}
                    placeholder="Как к вам обращаться"
                  />
                </label>
              </fieldset>
              <fieldset>
                <legend>Новый запуск по умолчанию</legend>
                <label>Режим
                  <select
                    value={settings.defaults.mode}
                    onChange={(event) => setSettings((value) => ({
                      ...value,
                      defaults: {
                        ...value.defaults,
                        mode: event.target.value as AppSettingsView["defaults"]["mode"],
                      },
                    }))}
                  >
                    <option value="DEBATE">Обсуждение</option>
                    <option value="SEQUENTIAL">Рецензирование</option>
                    <option value="PARALLEL">Независимые ответы</option>
                    <option value="MANUAL">Один ответ</option>
                  </select>
                </label>
                <div className="settings-checks">
                  {(["chatgpt", "gemini"] as const).map((provider) => (
                    <label key={provider}>
                      <input
                        type="checkbox"
                        checked={settings.defaults.providers.includes(provider)}
                        onChange={() => setSettings((value) => ({
                          ...value,
                          defaults: {
                            ...value.defaults,
                            providers: value.defaults.providers.includes(provider)
                              ? value.defaults.providers.filter((item) => item !== provider)
                              : [...value.defaults.providers, provider],
                          },
                        }))}
                      /> {provider}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Ограничения оркестрации</legend>
                <div className="settings-grid">
                  <label>Максимум ходов<input type="number" min={1} max={50} value={settings.defaults.limits.maxTurns} onChange={(event) => updateLimit("maxTurns", event.target.value)} /></label>
                  <label>Повторных попыток<input type="number" min={1} max={10} value={settings.defaults.limits.maxRetries} onChange={(event) => updateLimit("maxRetries", event.target.value)} /></label>
                  <label>Таймаут хода, сек.<input type="number" min={1} max={1800} value={settings.defaults.limits.maxTurnMs / 1000} onChange={(event) => updateLimit("maxTurnMs", String(Number(event.target.value) * 1000))} /></label>
                  <label>Таймаут сессии, мин.<input type="number" min={1} max={240} value={settings.defaults.limits.maxSessionMs / 60000} onChange={(event) => updateLimit("maxSessionMs", String(Number(event.target.value) * 60000))} /></label>
                  <label>Подтверждение каждые N ходов<input type="number" min={1} max={50} value={settings.defaults.limits.confirmationEvery} onChange={(event) => updateLimit("confirmationEvery", event.target.value)} /></label>
                </div>
              </fieldset>
              <fieldset>
                <legend>Внешний вид</legend>
                <div className="settings-grid">
                  <label>Тема<select value={settings.appearance.theme} onChange={(event) => setSettings((value) => ({ ...value, appearance: { ...value.appearance, theme: event.target.value as AppSettingsView["appearance"]["theme"] } }))}><option value="dark">Тёмная</option><option value="light">Светлая</option><option value="system">Как в системе</option></select></label>
                  <label>Плотность<select value={settings.appearance.density} onChange={(event) => setSettings((value) => ({ ...value, appearance: { ...value.appearance, density: event.target.value as AppSettingsView["appearance"]["density"] } }))}><option value="comfortable">Обычная</option><option value="compact">Компактная</option></select></label>
                  <label>Масштаб текста, %<input type="number" min={80} max={140} step={5} value={settings.appearance.fontScale} onChange={(event) => setSettings((value) => ({ ...value, appearance: { ...value.appearance, fontScale: Number(event.target.value) } }))} /></label>
                </div>
              </fieldset>
            </div>
            <footer>
              <button onClick={() => setSettings(fallbackSettings)}>Сбросить</button>
              <button onClick={() => setSettingsOpen(false)}>Отмена</button>
              <button className="primary" onClick={() => void saveSettings()}>Сохранить</button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
