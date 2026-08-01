import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";

const initialState: ProjectStateView = {
  requirements: [],
  constraints: [],
  decisions: [],
  rejectedOptions: [],
  openQuestions: [],
  acceptanceCriteria: [
    { id: "acceptance-1", text: "Define acceptance criterion", sourceTurnIds: [] },
  ],
};

type StateSection = keyof ProjectStateView;
const stateSections: Array<{
  key: StateSection;
  title: string;
  empty: string;
  rationale: boolean;
}> = [
  { key: "requirements", title: "Требования", empty: "Добавьте требование", rationale: false },
  { key: "constraints", title: "Ограничения", empty: "Добавьте ограничение", rationale: false },
  { key: "decisions", title: "Принятые решения", empty: "Зафиксируйте решение", rationale: true },
  { key: "rejectedOptions", title: "Отклонённые варианты", empty: "Зафиксируйте отклонённый вариант", rationale: true },
  { key: "openQuestions", title: "Открытые вопросы", empty: "Добавьте вопрос", rationale: false },
  { key: "acceptanceCriteria", title: "Критерии приёмки", empty: "Добавьте критерий", rationale: false },
];

const metricLabels: Record<string, string> = {
  "provider.turn.success": "Успешность",
  "provider.turn.elapsed_ms": "Время ответа",
  "provider.turn.retry_count": "Повторные попытки",
  "orchestration.run.success": "Успешность запусков",
  "orchestration.run.elapsed_ms": "Время запуска",
};

function metricValue(metric: MetricSummaryView): string {
  if (metric.name.endsWith(".success")) return `${Math.round(metric.average * 100)}%`;
  if (metric.name.endsWith("_ms")) {
    return metric.average >= 60_000
      ? `${(metric.average / 60_000).toFixed(1)} мин`
      : `${(metric.average / 1_000).toFixed(1)} сек`;
  }
  return metric.average.toFixed(metric.average % 1 === 0 ? 0 : 1);
}

const fallbackSettings: AppSettingsView = {
  schemaVersion: 1,
  profile: { displayName: "", realName: "", greetingStyle: "generic" },
  defaults: {
    mode: "DEBATE",
    providers: ["chatgpt", "gemini"],
    limits: {
      maxTurns: 6,
      maxTurnMs: 180_000,
      maxSessionMs: 900_000,
      maxRetries: 1,
      confirmationEvery: 2,
      requireConfirmation: false,
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
  const [starter, setStarter] = useState<string>("chatgpt");
  const [stateText, setStateText] = useState(JSON.stringify(initialState, null, 2));
  const [projectState, setProjectState] = useState<ProjectStateView>(initialState);
  const [advancedStateOpen, setAdvancedStateOpen] = useState(false);
  const [openStateSections, setOpenStateSections] = useState<Set<StateSection>>(
    () => new Set(["acceptanceCriteria"]),
  );
  const [status, setStatus] = useState("Готово");
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState<AppSettingsView>(fallbackSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"profile" | "behavior" | "appearance" | "quality" | "diagnostics">("profile");
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfoView | null>(null);
  const [preflight, setPreflight] = useState<Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }>>([]);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [qualityDashboard, setQualityDashboard] = useState<QualityDashboardView | null>(null);
  const [showSplash, setShowSplash] = useState(true);
  const [creationProviders, setCreationProviders] = useState<string[]>(["chatgpt", "gemini"]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [optimisticUserTask, setOptimisticUserTask] = useState<string | null>(null);
  const outputRef = useRef<HTMLElement>(null);

  useEffect(() => {
    return window.orchestrator.orchestration.onProgress((data) => {
      setStreaming((currentStreaming) => ({
        ...currentStreaming,
        [data.providerId]: data.text,
      }));
    });
  }, []);

  useEffect(() => {
    if (typeof window.orchestrator.events?.onEvent !== "function") return;
    return window.orchestrator.events.onEvent((event) => {
      if (event?.event_type === "phase:changed" && event.payload) {
        const details = event.payload.details || event.payload.phase;
        if (details) setStatus(details);
      }
    });
  }, []);

  const refresh = async (): Promise<void> => setProjects(await window.orchestrator.projects.list());
  useEffect(() => {
    void refresh();
    const timer = setTimeout(() => setShowSplash(false), 2500);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    void window.orchestrator.settings.get().then((value) => {
      setSettings(value);
      setMode(value.defaults.mode);
      setProviders(value.defaults.providers);
      setCreationProviders(value.defaults.providers);
      if (value.defaults.providers[0]) {
        setStarter(value.defaults.providers[0]);
      }
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
  }, [current?.transcript.length, optimisticUserTask, Object.values(streaming).join("").length, running]);
  useEffect(() => {
    if (!running || !current) return;
    const projectId = current.project.id;
    const timer = window.setInterval(() => {
      void window.orchestrator.projects.open(projectId).then(setCurrent).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [running, current?.project.id]);
  useEffect(() => {
    if (settingsOpen) void loadQualityDashboard();
  }, [settingsOpen]);

  async function openProject(id: string): Promise<void> {
    const details = await window.orchestrator.projects.open(id);
    setCurrent(details);
    const nextState = details.state?.state ?? structuredClone(initialState);
    setProjectState(nextState);
    setStateText(JSON.stringify(nextState, null, 2));
  }

  async function run(): Promise<void> {
    const submittedTask = task.trim();
    if (!current || !submittedTask || running || providers.length === 0) return;
    const projectId = current.project.id;
    setOptimisticUserTask(submittedTask);
    setTask("");
    setStreaming({});
    setRunning(true);
    setStatus("Модели обсуждают сообщение…");
    try {
      const orderedProviders = [
        ...(providers.includes(starter) ? [starter] : []),
        ...providers.filter((provider) => provider !== starter),
      ];
      const output = await window.orchestrator.orchestration.run({
        projectId,
        mode,
        task: submittedTask,
        providers: orderedProviders,
        limits: settings.defaults.limits,
      });
      setStatus(
        output.consensusReached
          ? "Модели независимо подтвердили согласованное решение"
          : output.status,
      );
      await openProject(projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message.replace(/^Error invoking remote method '[^']+': Error:\s*/, ""));
      await openProject(projectId);
    } finally {
      setRunning(false);
      setStreaming({});
      setOptimisticUserTask(null);
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

  async function refreshDiagnostics(): Promise<void> {
    setMaintenanceBusy(true);
    try {
      const [info, checks] = await Promise.all([
        window.orchestrator.system.info(),
        window.orchestrator.system.preflight(),
      ]);
      setReleaseInfo(info);
      setPreflight(checks);
      setStatus(checks.some((check) => check.status === "fail")
        ? "Диагностика обнаружила ошибку"
        : "Диагностика завершена");
    } catch (error) {
      setStatus(`Диагностика не выполнена: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function loadQualityDashboard(): Promise<void> {
    try {
      setQualityDashboard(await window.orchestrator.quality.dashboard());
    } catch (error) {
      setStatus(`Метрики не загружены: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function createBackup(): Promise<void> {
    setMaintenanceBusy(true);
    try {
      const path = await window.orchestrator.maintenance.backup();
      setStatus(`Резервная копия создана: ${path}`);
    } catch (error) {
      setStatus(`Копия не создана: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function resetSession(provider: any): Promise<void> {
    setMaintenanceBusy(true);
    try {
      const result = await window.orchestrator.maintenance.resetSession(provider);
      setStatus(result.reset ? `Сессия ${provider} сброшена` : "Сброс сессии отменён");
    } catch (error) {
      setStatus(`Сессия не сброшена: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function openDataFolder(): Promise<void> {
    try {
      const path = await window.orchestrator.system.openDataFolder();
      setStatus(`Открыта папка: ${path}`);
    } catch (error) {
      setStatus(`Папка не открыта: ${error instanceof Error ? error.message : String(error)}`);
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
      await window.orchestrator.state.save(current.project.id, projectState);
      await openProject(current.project.id);
      setStatus("Черновик Project State сохранён");
    } catch (error) {
      setStatus(
        `Project State не сохранён: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function replaceProjectState(next: ProjectStateView): void {
    setProjectState(next);
    setStateText(JSON.stringify(next, null, 2));
  }

  function addStateItem(section: StateSection): void {
    const item: ProjectStateItemView = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: "",
      sourceTurnIds: [],
      ...(section === "decisions" || section === "rejectedOptions"
        ? { rationale: "" }
        : {}),
    };
    replaceProjectState({ ...projectState, [section]: [...projectState[section], item] });
  }

  function updateStateItem(
    section: StateSection,
    id: string,
    patch: Partial<ProjectStateItemView>,
  ): void {
    replaceProjectState({
      ...projectState,
      [section]: projectState[section].map((item) =>
        item.id === id ? { ...item, ...patch } : item),
    });
  }

  function removeStateItem(section: StateSection, id: string): void {
    replaceProjectState({
      ...projectState,
      [section]: projectState[section].filter((item) => item.id !== id),
    });
  }

  function applyAdvancedState(): void {
    try {
      const parsed = JSON.parse(stateText) as ProjectStateView;
      replaceProjectState(parsed);
      setStatus("JSON применён к конструктору");
    } catch (error) {
      setStatus(`Некорректный JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function relay(entry: ConversationEntryView): void {
    setTask(
      `Проверь и развей следующий ответ другой модели.\n\n<UNTRUSTED_PEER_RESPONSE>\n${entry.content}\n</UNTRUSTED_PEER_RESPONSE>`,
    );
    setMode("MANUAL");
    setStatus("Ответ помещён в редактор. Выберите модель, отредактируйте текст и отправьте.");
  }

  if (showSplash) {
    const nameToUse =
      settings.profile.greetingStyle === "display"
        ? settings.profile.displayName
        : settings.profile.greetingStyle === "real"
        ? settings.profile.realName
        : "";
    const greetingText = nameToUse
      ? `Привет, ${nameToUse}!`
      : "С возвращением!";
    return (
      <div className="splash-screen">
        <div className="splash-content">
          <img src="./logo.png" className="splash-logo" alt="G+G Logo" />
          <h1 className="splash-greeting">{greetingText}</h1>
          <p className="splash-subtitle">Multi-model orchestrator workspace</p>
          <div className="splash-loader"></div>
        </div>
      </div>
    );
  }

  return (
    <main>
      <header>
        <div><img src="./logo.png" className="header-logo" alt="G+G Logo" /><h1>Multi-model workspace</h1></div>
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
              void window.orchestrator.projects.create(name, creationProviders).then(async (project) => {
                setName("");
                await refresh();
                await openProject(project.id);
              });
            }}
          >
            <input aria-label="Название проекта" value={name} onChange={(event) => setName(event.target.value)} placeholder="Название проекта" />
            <details className="creation-providers-details">
              <summary>Выбрать ИИ ({creationProviders.length})</summary>
              <div className="creation-providers-list">
                {(["chatgpt", "gemini", "deepseek", "claude", "copilot", "perplexity", "huggingchat", "groq", "duckduckgo", "mistral"] as const).map((prov) => (
                  <label key={prov}>
                    <input
                      type="checkbox"
                      checked={creationProviders.includes(prov)}
                      onChange={() =>
                        setCreationProviders((currentList) =>
                          currentList.includes(prov)
                            ? currentList.filter((item) => item !== prov)
                            : [...currentList, prov],
                        )
                      }
                    /> {prov}
                  </label>
                ))}
              </div>
            </details>
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
          {(["chatgpt", "gemini", "deepseek", "claude", "copilot", "perplexity", "huggingchat", "groq", "duckduckgo", "mistral"] as const).map((provider) => (
            <div className="session-row" key={provider}>
              <button onClick={() => void login(provider)}>
                Войти · {provider}
              </button>
              <button
                className="logout"
                aria-label={`Выйти из ${provider}`}
                title={`Удалить локальную сессию ${provider}`}
                onClick={() => void resetSession(provider)}
              >
                Выйти
              </button>
            </div>
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
                <option value="DEBATE">Рассуждение — до согласия или лимита</option>
                <option value="SEQUENTIAL">Очередь — по одному ответу каждой модели</option>
                <option value="PARALLEL">Независимые ответы</option>
                <option value="MANUAL">Один ответ</option>
              </select>
              {mode === "DEBATE" ? (
                <label className="starter-control">
                  Продолжение обсуждения
                  <select
                    aria-label="Продолжение обсуждения"
                    value={settings.defaults.limits.requireConfirmation ? "approval" : "auto"}
                    onChange={(event) => setSettings((value) => ({
                      ...value,
                      defaults: {
                        ...value.defaults,
                        limits: {
                          ...value.defaults.limits,
                          requireConfirmation: event.target.value === "approval",
                        },
                      },
                    }))}
                  >
                    <option value="auto">Автономно — до консенсуса</option>
                    <option value="approval">С подтверждением пользователя</option>
                  </select>
                </label>
              ) : null}
              {providers.length > 1 && mode !== "PARALLEL" ? (
                <label className="starter-control">
                  Первым отвечает
                  <select
                    aria-label="Первым отвечает"
                    value={starter}
                    onChange={(event) =>
                      setStarter(event.target.value as any)}
                  >
                    {providers.map((provider) => (
                      <option key={provider} value={provider}>{provider}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {(current?.project.providers && current.project.providers.length > 0
                ? current.project.providers
                : ["chatgpt", "gemini", "deepseek"]
              ).map((provider) => (
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
                        if (!next.includes(starter) && next[0]) {
                          setStarter(next[0] as any);
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
            {current?.transcript.length || optimisticUserTask || Object.values(streaming).some(t => t.trim()) ? (
              <>
                {(current?.transcript || []).map((entry) => (
                  <section
                    className={`message ${entry.role.toLowerCase()} ${entry.providerId ?? ""}`}
                    key={entry.id}
                  >
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
                ))}
                {optimisticUserTask && !(current?.transcript || []).some(t => t.role === "USER" && t.content === optimisticUserTask) ? (
                  <section className="message user optimistic" key="optimistic-user-task">
                    <header>
                      <strong>Вы</strong>
                      <small>отправка…</small>
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
                      {optimisticUserTask}
                    </ReactMarkdown>
                  </section>
                ) : null}
                {running ? (
                  <div className="discussion-status-card" key="discussion-status">
                    <div className="discussion-pulse-loader">
                      <span className="dot"></span>
                      <span className="dot"></span>
                      <span className="dot"></span>
                    </div>
                    <div className="discussion-status-text">
                      <strong>Обсуждение в процессе…</strong>
                      <small>{status}</small>
                    </div>
                  </div>
                ) : null}
                {Object.entries(streaming).map(([providerId, text]) => {
                  if (!text.trim()) return null;
                  const alreadyPersisted = current?.transcript.some(
                    t => t.role === "ASSISTANT" && t.providerId === providerId && t.content.slice(-20) === text.slice(-20)
                  );
                  if (alreadyPersisted) return null;
                  return (
                    <section
                      className={`message assistant ${providerId}`}
                      key={`streaming-${providerId}`}
                    >
                      <header>
                        <strong>{providerId}</strong>
                        <small>печатает...</small>
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
                        {text}
                      </ReactMarkdown>
                    </section>
                  );
                })}
              </>
            ) : (
              <p className="empty">Здесь сохранится весь разговор ChatGPT, Gemini и ваш.</p>
            )}
          </article>
        </section>
        <aside className="inspector">
          <div className="state-heading">
            <div>
              <h2>Конструктор спецификации</h2>
              <small>
                {current?.state
                  ? `Версия ${current.state.version} · ${current.state.status}`
                  : "Новый черновик"}
              </small>
            </div>
            <span className="state-progress">
              {Object.values(projectState).flat().filter((item) => item.text.trim()).length} пунктов
            </span>
          </div>
          <div className="state-builder tree-view">
            {stateSections.map((section) => (
              <details
                className="state-section tree-branch"
                key={section.key}
                open={openStateSections.has(section.key)}
                onToggle={(event) => {
                  const isOpen = event.currentTarget.open;
                  setOpenStateSections((currentSections) => {
                    if (currentSections.has(section.key) === isOpen) return currentSections;
                    const next = new Set(currentSections);
                    if (isOpen) next.add(section.key);
                    else next.delete(section.key);
                    return next;
                  });
                }}
              >
                <summary>
                  <span>
                    {section.key === "requirements" && "📋 "}
                    {section.key === "constraints" && "🛑 "}
                    {section.key === "decisions" && "✅ "}
                    {section.key === "rejectedOptions" && "❌ "}
                    {section.key === "openQuestions" && "❓ "}
                    {section.key === "acceptanceCriteria" && "🎯 "}
                    {section.title}
                  </span>
                  <small>{projectState[section.key].length}</small>
                </summary>
                <div className="state-items tree-items">
                  {projectState[section.key].map((item, index) => (
                    <article className="state-card tree-leaf" key={item.id}>
                      <header>
                        <strong>{index + 1}</strong>
                        <button
                          aria-label={`Удалить пункт ${index + 1} из раздела ${section.title}`}
                          onClick={() => removeStateItem(section.key, item.id)}
                        >×</button>
                      </header>
                      <textarea
                        aria-label={`${section.title}, пункт ${index + 1}`}
                        placeholder={section.empty}
                        value={item.text}
                        onChange={(event) =>
                          updateStateItem(section.key, item.id, { text: event.target.value })}
                      />
                      {section.rationale ? (
                        <textarea
                          className="rationale-input"
                          aria-label={`Обоснование пункта ${index + 1}`}
                          placeholder="Почему принято такое решение?"
                          value={item.rationale ?? ""}
                          onChange={(event) =>
                            updateStateItem(section.key, item.id, {
                              rationale: event.target.value,
                            })}
                        />
                      ) : null}
                      <div className="source-picker">
                        <select
                          aria-label={`Источник пункта ${index + 1}`}
                          value=""
                          onChange={(event) => {
                            const source = event.target.value;
                            if (source && !item.sourceTurnIds.includes(source)) {
                              updateStateItem(section.key, item.id, {
                                sourceTurnIds: [...item.sourceTurnIds, source],
                              });
                            }
                          }}
                        >
                          <option value="">Привязать к ответу…</option>
                          {current?.transcript
                            .filter((entry) => entry.role === "ASSISTANT")
                            .map((entry) => (
                              <option value={entry.id} key={entry.id}>
                                {entry.providerId ?? "модель"} · {entry.content.slice(0, 55)}
                              </option>
                            ))}
                        </select>
                        <div className="source-tags">
                          {item.sourceTurnIds.map((sourceId) => {
                            const source = current?.transcript.find((entry) => entry.id === sourceId);
                            return (
                              <button
                                key={sourceId}
                                title="Убрать источник"
                                onClick={() => updateStateItem(section.key, item.id, {
                                  sourceTurnIds: item.sourceTurnIds.filter((id) => id !== sourceId),
                                })}
                              >
                                {source?.providerId ?? "источник"} ×
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </article>
                  ))}
                  <button className="add-state-item" onClick={() => addStateItem(section.key)}>
                    + Добавить
                  </button>
                </div>
              </details>
            ))}
          </div>
          <details className="advanced-state" open={advancedStateOpen} onToggle={(event) =>
            setAdvancedStateOpen((event.currentTarget as HTMLDetailsElement).open)}>
            <summary>Экспертный режим JSON</summary>
            <textarea
              aria-label="Project State JSON"
              value={stateText}
              onChange={(event) => setStateText(event.target.value)}
            />
            <button onClick={applyAdvancedState}>Применить JSON</button>
          </details>
          <div className="controls state-actions">
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
            <div className="settings-layout">
              <aside className="settings-sidebar">
                <button
                  className={`settings-sidebar-btn ${settingsTab === "profile" ? "active" : ""}`}
                  onClick={() => setSettingsTab("profile")}
                >
                  👤 Профиль
                </button>
                <button
                  className={`settings-sidebar-btn ${settingsTab === "behavior" ? "active" : ""}`}
                  onClick={() => setSettingsTab("behavior")}
                >
                  ⚙️ Поведение и лимиты
                </button>
                <button
                  className={`settings-sidebar-btn ${settingsTab === "appearance" ? "active" : ""}`}
                  onClick={() => setSettingsTab("appearance")}
                >
                  🎨 Внешний вид
                </button>
                <button
                  className={`settings-sidebar-btn ${settingsTab === "quality" ? "active" : ""}`}
                  onClick={() => setSettingsTab("quality")}
                >
                  📊 Центр качества
                </button>
                <button
                  className={`settings-sidebar-btn ${settingsTab === "diagnostics" ? "active" : ""}`}
                  onClick={() => setSettingsTab("diagnostics")}
                >
                  🛠️ Диагностика и данные
                </button>
              </aside>
              <div className="settings-content settings-pane">
                {settingsTab === "profile" && (
                  <fieldset>
                    <legend>Профиль</legend>
                    <label>Никнейм
                      <input
                        maxLength={80}
                        value={settings.profile.displayName}
                        onChange={(event) => setSettings((value) => ({
                          ...value,
                          profile: { ...value.profile, displayName: event.target.value },
                        }))}
                        placeholder="Отображаемое имя"
                      />
                    </label>
                    <label>Настоящее имя
                      <input
                        maxLength={80}
                        value={settings.profile.realName ?? ""}
                        onChange={(event) => setSettings((value) => ({
                          ...value,
                          profile: { ...value.profile, realName: event.target.value },
                        }))}
                        placeholder="Имя Фамилия"
                      />
                    </label>
                    <label>Приветствие на старте
                      <select
                        value={settings.profile.greetingStyle ?? "generic"}
                        onChange={(event) => setSettings((value) => ({
                          ...value,
                          profile: {
                            ...value.profile,
                            greetingStyle: event.target.value as any,
                          },
                        }))}
                      >
                        <option value="display">Использовать никнейм</option>
                        <option value="real">Использовать настоящее имя</option>
                        <option value="generic">Стандартное приветствие</option>
                      </select>
                    </label>
                  </fieldset>
                )}

                {settingsTab === "behavior" && (
                  <>
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
                        {(["chatgpt", "gemini", "deepseek", "claude", "copilot", "perplexity", "huggingchat", "groq", "duckduckgo", "mistral"] as const).map((provider) => (
                          <label key={provider}>
                            <input
                              type="checkbox"
                              checked={settings.defaults.providers.includes(provider)}
                              onChange={() => setSettings((value) => ({
                                ...value,
                                defaults: {
                                  ...value.defaults,
                                  providers: (value.defaults.providers.includes(provider)
                                    ? value.defaults.providers.filter((item) => item !== provider)
                                    : [...value.defaults.providers, provider]) as any,
                                },
                              }))}
                            /> {provider}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset>
                      <legend>Ограничения оркестрации</legend>
                      <label className="settings-toggle">
                        <input
                          type="checkbox"
                          checked={settings.defaults.limits.requireConfirmation === true}
                          onChange={(event) => setSettings((value) => ({
                            ...value,
                            defaults: {
                              ...value.defaults,
                              limits: {
                                ...value.defaults.limits,
                                requireConfirmation: event.target.checked,
                              },
                            },
                          }))}
                        />
                        Спрашивать разрешение на продолжение обсуждения
                      </label>
                      <p className="settings-help">
                        Выключено: модели работают до независимого консенсуса или защитного лимита ходов.
                        Включено: G+G останавливается через заданный интервал и ждёт вашего решения.
                      </p>
                      <div className="settings-grid">
                        <label>Максимум ходов
                          <select
                            value={settings.defaults.limits.maxTurns}
                            onChange={(event) => updateLimit("maxTurns", event.target.value)}
                          >
                            {[2, 4, 6, 8, 10, 12, 16, 20, 30].map(n => (
                              <option key={n} value={n}>{n}</option>
                            ))}
                          </select>
                        </label>
                        <label>Повторных попыток
                          <select
                            value={settings.defaults.limits.maxRetries}
                            onChange={(event) => updateLimit("maxRetries", event.target.value)}
                          >
                            {[0, 1, 2, 3, 4, 5].map(n => (
                              <option key={n} value={n}>{n}</option>
                            ))}
                          </select>
                        </label>
                        <label>Таймаут хода
                          <select
                            value={settings.defaults.limits.maxTurnMs}
                            onChange={(event) => updateLimit("maxTurnMs", event.target.value)}
                          >
                            <option value={30000}>30 секунд</option>
                            <option value={60000}>1 минута</option>
                            <option value={120000}>2 минуты</option>
                            <option value={180000}>3 минуты</option>
                            <option value={300000}>5 минут</option>
                            <option value={600000}>10 минут</option>
                          </select>
                        </label>
                        <label>Таймаут сессии
                          <select
                            value={settings.defaults.limits.maxSessionMs}
                            onChange={(event) => updateLimit("maxSessionMs", event.target.value)}
                          >
                            <option value={300000}>5 минут</option>
                            <option value={600000}>10 минут</option>
                            <option value={900000}>15 минут</option>
                            <option value={1800000}>30 минут</option>
                            <option value={3600000}>1 час</option>
                            <option value={7200000}>2 часа</option>
                            <option value={14400000}>4 часа</option>
                          </select>
                        </label>
                        <label>Интервал подтверждения (ходов)
                          <select
                            disabled={settings.defaults.limits.requireConfirmation !== true}
                            value={settings.defaults.limits.confirmationEvery}
                            onChange={(event) => updateLimit("confirmationEvery", event.target.value)}
                          >
                            {[1, 2, 3, 5, 10, 15, 20].map(n => (
                              <option key={n} value={n}>{n}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </fieldset>
                  </>
                )}

                {settingsTab === "appearance" && (
                  <fieldset>
                    <legend>Внешний вид</legend>
                    <div className="settings-grid">
                      <label>Тема
                        <select
                          value={settings.appearance.theme}
                          onChange={(event) => setSettings((value) => ({
                            ...value,
                            appearance: { ...value.appearance, theme: event.target.value as AppSettingsView["appearance"]["theme"] },
                          }))}
                        >
                          <option value="dark">Тёмная</option>
                          <option value="light">Светлая</option>
                          <option value="system">Как в системе</option>
                        </select>
                      </label>
                      <label>Плотность
                        <select
                          value={settings.appearance.density}
                          onChange={(event) => setSettings((value) => ({
                            ...value,
                            appearance: { ...value.appearance, density: event.target.value as AppSettingsView["appearance"]["density"] },
                          }))}
                        >
                          <option value="comfortable">Обычная</option>
                          <option value="compact">Компактная</option>
                        </select>
                      </label>
                      <label>Масштаб текста, %
                        <select
                          value={settings.appearance.fontScale}
                          onChange={(event) => setSettings((value) => ({
                            ...value,
                            appearance: { ...value.appearance, fontScale: Number(event.target.value) },
                          }))}
                        >
                          {[80, 90, 100, 110, 120, 130, 140].map(scale => (
                            <option key={scale} value={scale}>{scale}%</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </fieldset>
                )}

                {settingsTab === "quality" && (
                  <fieldset>
                    <legend>Центр качества · последние 30 дней</legend>
                    <div className="quality-heading">
                      <p className="settings-note">
                        Локальная статистика помогает отличить сбой провайдера от ошибки
                        приложения. Тексты сообщений в метрики не попадают.
                      </p>
                      <button onClick={() => void loadQualityDashboard()}>Обновить</button>
                    </div>
                    {qualityDashboard?.totalSamples ? (
                      <>
                        <div className="quality-providers">
                          {Object.entries(qualityDashboard.providers).map(([provider, metrics]) => {
                            const success = metrics.find((metric) =>
                              metric.name === "provider.turn.success");
                            const elapsed = metrics.find((metric) =>
                              metric.name === "provider.turn.elapsed_ms");
                            const retries = metrics.find((metric) =>
                              metric.name === "provider.turn.retry_count");
                            return (
                              <article className="provider-score" key={provider}>
                                <header>
                                  <strong>{provider}</strong>
                                  <span data-score={
                                    !success ? "unknown" : success.average >= .98 ? "good"
                                      : success.average >= .85 ? "warn" : "bad"
                                  }>
                                    {success ? metricValue(success) : "нет данных"}
                                  </span>
                                </header>
                                <dl>
                                  <div><dt>Ходов</dt><dd>{success?.count ?? 0}</dd></div>
                                  <div><dt>Средний ответ</dt><dd>{elapsed ? metricValue(elapsed) : "—"}</dd></div>
                                  <div><dt>Повторы</dt><dd>{retries ? metricValue(retries) : "—"}</dd></div>
                                </dl>
                              </article>
                            );
                          })}
                        </div>
                        <div className="metric-grid">
                          {qualityDashboard.overall.map((metric) => (
                            <article className="metric-card" key={metric.name}>
                              <span>{metricLabels[metric.name] ?? metric.name}</span>
                              <strong>{metricValue(metric)}</strong>
                              <small>{metric.count} измерений · min {Math.round(metric.minimum)} · max {Math.round(metric.maximum)}</small>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="quality-empty">
                        <strong>Пока недостаточно данных</strong>
                        <span>Метрики появятся после первых запусков моделей.</span>
                      </div>
                    )}
                  </fieldset>
                )}

                {settingsTab === "diagnostics" && (
                  <fieldset>
                    <legend>Диагностика и данные</legend>
                    <p className="settings-note">
                      Проверка выполняется локально. Резервная копия содержит базу проектов и
                      обезличенные настройки, но не браузерные профили, cookies и пароли.
                    </p>
                    <div className="maintenance-actions">
                      <button disabled={maintenanceBusy} onClick={() => void refreshDiagnostics()}>
                        Проверить окружение
                      </button>
                      <button disabled={maintenanceBusy} onClick={() => void createBackup()}>
                        Создать резервную копию
                      </button>
                      <button disabled={maintenanceBusy} onClick={() => void openDataFolder()}>
                        Открыть папку данных
                      </button>
                    </div>
                    {releaseInfo ? (
                      <dl className="release-info">
                        <div><dt>Версия</dt><dd>{releaseInfo.appVersion}</dd></div>
                        <div><dt>Commit</dt><dd>{releaseInfo.commit}</dd></div>
                        <div><dt>Данные</dt><dd>{releaseInfo.dataPath}</dd></div>
                      </dl>
                    ) : null}
                    {preflight.length > 0 ? (
                      <ul className="preflight-list" aria-label="Результаты диагностики">
                        {preflight.map((check) => (
                          <li key={check.name} data-status={check.status}>
                            <strong>{check.status.toUpperCase()} · {check.name}</strong>
                            <span>{check.detail}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="danger-zone">
                      <strong>Сброс авторизации</strong>
                      <span>Удаляет только локальную сессию выбранного сервиса.</span>
                      <div className="maintenance-actions">
                        <button disabled={maintenanceBusy} onClick={() => void resetSession("chatgpt")}>Сбросить ChatGPT</button>
                        <button disabled={maintenanceBusy} onClick={() => void resetSession("gemini")}>Сбросить Gemini</button>
                        <button disabled={maintenanceBusy} onClick={() => void resetSession("deepseek")}>Сбросить DeepSeek</button>
                      </div>
                    </div>
                  </fieldset>
                )}
              </div>
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
