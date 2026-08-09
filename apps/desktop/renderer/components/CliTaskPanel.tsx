import React from "react";

export interface CliTaskView {
  id: string;
  taskId: string;
  projectId: string;
  executor: string;
  title: string;
  objective: string;
  risk: string;
  status: string;
  taskJson: string;
  lastError?: string | null;
}

export interface CliTaskPanelProps {
  tasks: CliTaskView[];
  busyTaskId: string | null;
  onApprove: (task: CliTaskView) => Promise<void>;
  onReject: (task: CliTaskView) => Promise<void>;
  onCancel: (task: CliTaskView) => Promise<void>;
  onRetry: (task: CliTaskView) => Promise<void>;
}

function taskDetails(task: CliTaskView): { allowedPaths: string[]; verification: string[] } {
  try {
    const value = JSON.parse(task.taskJson) as Record<string, unknown>;
    const allowedPaths = Array.isArray(value.allowedPaths)
      ? value.allowedPaths.filter((item): item is string => typeof item === "string")
      : [];
    const verification = Array.isArray(value.verification)
      ? value.verification.map((item) => {
          if (!item || typeof item !== "object") return "invalid";
          const record = item as Record<string, unknown>;
          return typeof record.type === "string" ? record.type : "invalid";
        })
      : [];
    return { allowedPaths, verification };
  } catch {
    return { allowedPaths: [], verification: [] };
  }
}

export function CliTaskPanel({ tasks, busyTaskId, onApprove, onReject, onCancel, onRetry }: CliTaskPanelProps) {
  if (tasks.length === 0) return null;
  const visible = tasks.filter((task) => !["COMPLETED", "REJECTED", "CANCELLED"].includes(task.status));
  if (visible.length === 0) return null;

  return (
    <section className="cli-task-panel" aria-label="CLI-задачи, ожидающие решения">
      <header>
        <div>
          <strong>CLI V1</strong>
          <small>Запуск выполняется локальным CLI-процессом и требует отдельного подтверждения.</small>
        </div>
      </header>
      {visible.map((task) => {
        const details = taskDetails(task);
        const busy = busyTaskId === task.taskId;
        const awaiting = ["PROPOSED", "VALIDATED", "AWAITING_APPROVAL"].includes(task.status);
        const active = ["QUEUED", "RUNNING", "VERIFYING"].includes(task.status);
        const retryable = ["FAILED", "NEEDS_FIX", "BLOCKED", "INTERRUPTED"].includes(task.status);
        return (
          <article className="cli-task-card" key={`${task.projectId}:${task.taskId}`}>
            <div className="cli-task-heading">
              <strong>{task.title}</strong>
              <span className={`cli-task-status status-${task.status.toLowerCase()}`}>{task.status}</span>
            </div>
            <p>{task.objective}</p>
            <dl>
              <div><dt>Executor</dt><dd>{task.executor}</dd></div>
              <div><dt>Risk</dt><dd>{task.risk}</dd></div>
              <div><dt>Paths</dt><dd>{details.allowedPaths.join(", ") || "—"}</dd></div>
              <div><dt>Verification</dt><dd>{details.verification.join(", ") || "—"}</dd></div>
            </dl>
            {task.lastError ? <p className="cli-task-error">{task.lastError}</p> : null}
            <div className="cli-task-actions">
              {awaiting ? (
                <>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void onApprove(task)}>
                    Подтвердить локальный CLI-запуск
                  </button>
                  <button className="btn btn-secondary" disabled={busy} onClick={() => void onReject(task)}>
                    Отклонить
                  </button>
                </>
              ) : null}
              {active ? (
                <button className="btn btn-danger-subtle" disabled={busy} onClick={() => void onCancel(task)}>
                  Остановить CLI-задачу
                </button>
              ) : null}
              {retryable ? (
                <button className="btn btn-secondary" disabled={busy} onClick={() => void onRetry(task)}>
                  Повторить с новым подтверждением
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
