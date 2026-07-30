import React, { useEffect, useMemo, useState } from "react";
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
  const [mode, setMode] = useState("PARALLEL");
  const [providers, setProviders] = useState(["chatgpt", "gemini"]);
  const [result, setResult] = useState<RunView | null>(null);
  const [stateText, setStateText] = useState(JSON.stringify(initialState, null, 2));
  const [status, setStatus] = useState("Ready");

  const refresh = async (): Promise<void> => setProjects(await window.orchestrator.projects.list());
  useEffect(() => void refresh(), []);

  const markdown = useMemo(
    () =>
      result?.responses
        .map((item) => `## ${item.providerId} · round ${item.round}\n\n${item.text}`)
        .join("\n\n") ?? "",
    [result],
  );

  async function openProject(id: string): Promise<void> {
    const details = await window.orchestrator.projects.open(id);
    setCurrent(details);
    if (details.state) setStateText(JSON.stringify(details.state.state, null, 2));
  }

  async function run(): Promise<void> {
    if (!current) return;
    setStatus("Running");
    try {
      const output = await window.orchestrator.orchestration.run({
        projectId: current.project.id,
        mode,
        task,
        providers,
      });
      setResult(output);
      setStatus(output.status);
      await openProject(current.project.id);
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
          <h2>Projects</h2>
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
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" />
            <button>Create</button>
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
          <h2>Sessions</h2>
          {["chatgpt", "gemini"].map((provider) => (
            <button key={provider} onClick={() => void window.orchestrator.provider.login(provider)}>
              Login · {provider}
            </button>
          ))}
        </aside>
        <section className="workspace">
          <div className="composer panel">
            <h2>{current?.project.name ?? "Select a project"}</h2>
            <textarea value={task} onChange={(event) => setTask(event.target.value)} placeholder="Describe the task…" />
            <div className="controls">
              <select value={mode} onChange={(event) => setMode(event.target.value)}>
                <option>MANUAL</option><option>SEQUENTIAL</option><option>PARALLEL</option><option>DEBATE</option>
              </select>
              {["chatgpt", "gemini"].map((provider) => (
                <label key={provider}>
                  <input
                    type="checkbox"
                    checked={providers.includes(provider)}
                    onChange={() =>
                      setProviders((value) =>
                        value.includes(provider)
                          ? value.filter((item) => item !== provider)
                          : [...value, provider],
                      )
                    }
                  /> {provider}
                </label>
              ))}
              <button className="primary" disabled={!current || !task} onClick={() => void run()}>Run</button>
              <button onClick={() => void window.orchestrator.orchestration.pause()}>Pause</button>
              <button onClick={() => void window.orchestrator.orchestration.resume()}>Resume</button>
              <button onClick={() => void window.orchestrator.orchestration.stop()}>Stop</button>
            </div>
          </div>
          <article className="panel output">
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{markdown || "Responses will appear here."}</ReactMarkdown>
          </article>
        </section>
        <aside className="inspector">
          <h2>Project State</h2>
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
            >Save draft</button>
            <button
              disabled={!current?.state || current.state.status === "APPROVED"}
              onClick={() =>
                current?.state &&
                void window.orchestrator.state
                  .approve(current.state.id)
                  .then(() => openProject(current.project.id))
              }
            >Approve</button>
            <button
              disabled={!current}
              onClick={() =>
                current &&
                void window.orchestrator.exports
                  .spec(current.project.id)
                  .then((value) => setStatus(`Exported: ${value.directory}`))
              }
            >Export</button>
          </div>
          <h2>Timeline</h2>
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
