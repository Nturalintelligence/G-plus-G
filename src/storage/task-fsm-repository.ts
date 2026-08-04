import { DatabaseSync } from "node:sqlite";
import { CliTaskEnvelopeV1 } from "../cli-executors/cli-task-schema.js";

export type CliTaskState =
  | "PROPOSED"
  | "VALIDATED"
  | "AWAITING_APPROVAL"
  | "QUEUED"
  | "RUNNING"
  | "VERIFYING"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED"
  | "FAILED"
  | "NEEDS_FIX"
  | "BLOCKED"
  | "INTERRUPTED";

export interface CliTaskRecord {
  id: string;
  taskId: string;
  projectId: string;
  runId: string;
  parentTurnId: string;
  executor: string;
  title: string;
  objective: string;
  context: string;
  risk: string;
  status: CliTaskState;
  taskJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface CliTaskAttemptRecord {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
}

export interface CliTaskEventRecord {
  sequence?: number;
  id: string;
  taskId: string;
  attemptId?: string | null;
  eventType: string;
  payloadJson: string;
  occurredAt: string;
}

export const VALID_TRANSITIONS: Record<CliTaskState, ReadonlySet<CliTaskState>> = {
  PROPOSED: new Set(["VALIDATED", "REJECTED", "CANCELLED"]),
  VALIDATED: new Set(["AWAITING_APPROVAL", "QUEUED", "REJECTED", "CANCELLED"]),
  AWAITING_APPROVAL: new Set(["QUEUED", "REJECTED", "CANCELLED"]),
  QUEUED: new Set(["RUNNING", "CANCELLED", "BLOCKED"]),
  RUNNING: new Set(["VERIFYING", "FAILED", "CANCELLED", "INTERRUPTED"]),
  VERIFYING: new Set(["COMPLETED", "NEEDS_FIX", "FAILED", "CANCELLED"]),
  COMPLETED: new Set([]), // Terminal
  REJECTED: new Set([]), // Terminal
  CANCELLED: new Set([]), // Terminal
  FAILED: new Set(["QUEUED"]), // Can retry (attempt increment)
  NEEDS_FIX: new Set(["QUEUED"]), // Can retry (attempt increment)
  BLOCKED: new Set(["QUEUED", "CANCELLED"]),
  INTERRUPTED: new Set(["QUEUED", "CANCELLED", "REJECTED"]),
};

export class TaskFsmRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Recovers tasks left in 'RUNNING' state during a previous system crash or abnormal exit.
   * Transitions them to 'INTERRUPTED' and appends a CRASH_RECOVERY event.
   */
  public recoverInterruptedTasksOnStartup(): number {
    const runningTasks = this.db.prepare(
      "SELECT id, task_id, status FROM cli_tasks WHERE status = 'RUNNING'"
    ).all() as Array<{ id: string; task_id: string; status: string }>;

    let recoveredCount = 0;
    const now = new Date().toISOString();

    for (const task of runningTasks) {
      this.db.prepare(
        "UPDATE cli_tasks SET status = 'INTERRUPTED', updated_at = ? WHERE id = ?"
      ).run(now, task.id);

      const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.db.prepare(
        `INSERT INTO cli_task_events (id, task_id, attempt_id, event_type, payload_json, occurred_at)
         VALUES (?, ?, NULL, 'CRASH_RECOVERY', ?, ?)`
      ).run(eventId, task.task_id, JSON.stringify({ previousStatus: "RUNNING", newStatus: "INTERRUPTED" }), now);

      recoveredCount++;
    }

    return recoveredCount;
  }

  /**
   * Saves or updates a CLI task envelope in SQLite database.
   */
  public saveTaskEnvelope(envelope: CliTaskEnvelopeV1, initialStatus: CliTaskState = "PROPOSED"): CliTaskRecord {
    const now = new Date().toISOString();
    const dbId = `taskrec_${envelope.projectId}_${envelope.taskId}`;

    const existing = this.db.prepare(
      "SELECT * FROM cli_tasks WHERE project_id = ? AND task_id = ?"
    ).get(envelope.projectId, envelope.taskId) as Record<string, unknown> | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE cli_tasks
         SET run_id = ?, parent_turn_id = ?, executor = ?, title = ?, objective = ?, context = ?, risk = ?, status = ?, task_json = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        envelope.runId,
        envelope.parentTurnId,
        envelope.executor,
        envelope.title,
        envelope.objective,
        envelope.context,
        envelope.risk,
        initialStatus,
        JSON.stringify(envelope),
        now,
        dbId
      );
    } else {
      this.db.prepare(
        `INSERT INTO cli_tasks (id, task_id, project_id, run_id, parent_turn_id, executor, title, objective, context, risk, status, task_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        dbId,
        envelope.taskId,
        envelope.projectId,
        envelope.runId,
        envelope.parentTurnId,
        envelope.executor,
        envelope.title,
        envelope.objective,
        envelope.context,
        envelope.risk,
        initialStatus,
        JSON.stringify(envelope),
        now,
        now
      );

      // Log initial event
      const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.db.prepare(
        `INSERT INTO cli_task_events (id, task_id, attempt_id, event_type, payload_json, occurred_at)
         VALUES (?, ?, NULL, 'TASK_PROPOSED', ?, ?)`
      ).run(eventId, envelope.taskId, JSON.stringify({ initialStatus, envelope }), now);
    }

    return this.getTaskById(envelope.projectId, envelope.taskId)!;
  }

  /**
   * Transitions task to new FSM state, enforcing transition rules and appending event.
   */
  public transitionState(
    projectId: string,
    taskId: string,
    targetState: CliTaskState,
    payload?: Record<string, unknown>,
    attemptId?: string
  ): CliTaskRecord {
    const current = this.getTaskById(projectId, taskId);
    if (!current) {
      throw new Error(`Task '${taskId}' not found in project '${projectId}'`);
    }

    if (current.status === targetState) {
      // Idempotent: already in target state
      return current;
    }

    const allowedNext = VALID_TRANSITIONS[current.status];
    if (!allowedNext || !allowedNext.has(targetState)) {
      throw new Error(
        `Invalid FSM state transition for task '${taskId}': cannot transition from '${current.status}' to '${targetState}'`
      );
    }

    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE cli_tasks SET status = ?, updated_at = ? WHERE project_id = ? AND task_id = ?"
    ).run(targetState, now, projectId, taskId);

    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(
      `INSERT INTO cli_task_events (id, task_id, attempt_id, event_type, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      taskId,
      attemptId || null,
      `TRANSITION_TO_${targetState}`,
      JSON.stringify({ from: current.status, to: targetState, ...(payload || {}) }),
      now
    );

    return this.getTaskById(projectId, taskId)!;
  }

  public getTaskById(projectId: string, taskId: string): CliTaskRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM cli_tasks WHERE project_id = ? AND task_id = ?"
    ).get(projectId, taskId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: String(row.id),
      taskId: String(row.task_id),
      projectId: String(row.project_id),
      runId: String(row.run_id),
      parentTurnId: String(row.parent_turn_id),
      executor: String(row.executor),
      title: String(row.title),
      objective: String(row.objective),
      context: String(row.context),
      risk: String(row.risk),
      status: row.status as CliTaskState,
      taskJson: String(row.task_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public listTasksByProject(projectId: string, statusFilter?: CliTaskState): CliTaskRecord[] {
    let sql = "SELECT * FROM cli_tasks WHERE project_id = ?";
    const params: Array<string | number | null> = [projectId];

    if (statusFilter) {
      sql += " AND status = ?";
      params.push(statusFilter);
    }
    sql += " ORDER BY created_at ASC";

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      projectId: String(row.project_id),
      runId: String(row.run_id),
      parentTurnId: String(row.parent_turn_id),
      executor: String(row.executor),
      title: String(row.title),
      objective: String(row.objective),
      context: String(row.context),
      risk: String(row.risk),
      status: row.status as CliTaskState,
      taskJson: String(row.task_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /**
   * Creates a new attempt record for a task.
   */
  public createAttempt(taskId: string): CliTaskAttemptRecord {
    const existingAttempts = this.db.prepare(
      "SELECT MAX(attempt_number) as max_num FROM cli_task_attempts WHERE task_id = ?"
    ).get(taskId) as { max_num: number | null } | undefined;

    const nextNumber = (existingAttempts?.max_num || 0) + 1;
    const attemptId = `att_${taskId}_${nextNumber}`;
    const now = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO cli_task_attempts (id, task_id, attempt_number, status, started_at)
       VALUES (?, ?, ?, 'STARTED', ?)`
    ).run(attemptId, taskId, nextNumber, now);

    return {
      id: attemptId,
      taskId,
      attemptNumber: nextNumber,
      status: "STARTED",
      startedAt: now,
    };
  }

  public finishAttempt(attemptId: string, status: "COMPLETED" | "FAILED" | "CANCELLED"): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE cli_task_attempts SET status = ?, finished_at = ? WHERE id = ?"
    ).run(status, now, attemptId);
  }

  public getTaskEvents(taskId: string): CliTaskEventRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM cli_task_events WHERE task_id = ? ORDER BY sequence ASC"
    ).all(taskId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      sequence: Number(r.sequence),
      id: String(r.id),
      taskId: String(r.task_id),
      attemptId: r.attempt_id ? String(r.attempt_id) : null,
      eventType: String(r.event_type),
      payloadJson: String(r.payload_json),
      occurredAt: String(r.occurred_at),
    }));
  }
}
