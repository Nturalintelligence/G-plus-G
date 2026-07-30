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
  const outputRef = useRef<HTMLElement>(null);

  const refresh = async (): Promise<void> => setProjects(await window.orchestrator.projects.list());
  useEffect(() => void refresh(), []);
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

  return (
    <main>
      <header>
        <div><span className="mark">G+G</span><h1>Multi-model workspace</h1></div>
        <span className="status">{status}</span>
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
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Название проекта" />
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
              <select value={mode} onChange={(event) => setMode(event.target.value)}>
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{entry.content}</ReactMarkdown>
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
              onClick={() =>
                current &&
                void window.orchestrator.state
                  .save(current.project.id, JSON.parse(stateText))
                  .then(() => openProject(current.project.id))
              }
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
