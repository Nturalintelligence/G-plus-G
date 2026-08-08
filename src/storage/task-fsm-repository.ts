import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
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
  lastError?: string;
  activeAttemptId?: string;
}

export interface CliTaskAttemptRecord {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: "STARTED" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  startedAt: string;
  finishedAt?: string | null;
}

interface TaskIdentity {
  recordId: string;
  projectId: string;
  taskId: string;
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
  QUEUED: new Set(["RUNNING", "FAILED", "CANCELLED", "BLOCKED"]),
  RUNNING: new Set(["VERIFYING", "FAILED", "CANCELLED", "INTERRUPTED"]),
  VERIFYING: new Set(["COMPLETED", "NEEDS_FIX", "FAILED", "CANCELLED"]),
  COMPLETED: new Set([]), // Terminal
  REJECTED: new Set([]), // Terminal
  CANCELLED: new Set([]), // Terminal
  FAILED: new Set(["AWAITING_APPROVAL"]),
  NEEDS_FIX: new Set(["AWAITING_APPROVAL"]),
  BLOCKED: new Set(["AWAITING_APPROVAL", "CANCELLED"]),
  INTERRUPTED: new Set(["AWAITING_APPROVAL", "CANCELLED", "REJECTED"]),
};

export class TaskFsmRepository {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private getIdentity(projectId: string, taskId: string): TaskIdentity {
    const row = this.db.prepare(
      "SELECT id, project_id, task_id FROM cli_tasks WHERE project_id = ? AND task_id = ?",
    ).get(projectId, taskId) as { id: string; project_id: string; task_id: string } | undefined;
    if (!row) throw new Error(`Task '${taskId}' not found in project '${projectId}'`);
    return { recordId: row.id, projectId: row.project_id, taskId: row.task_id };
  }

  private getUniqueIdentity(taskId: string): TaskIdentity {
    const rows = this.db.prepare(
      "SELECT id, project_id, task_id FROM cli_tasks WHERE task_id = ? ORDER BY project_id ASC",
    ).all(taskId) as Array<{ id: string; project_id: string; task_id: string }>;
    if (rows.length === 0) throw new Error(`Task '${taskId}' not found`);
    if (rows.length > 1) {
      throw new Error(`Task ID '${taskId}' is ambiguous across projects; projectId is required`);
    }
    const row = rows[0]!;
    return { recordId: row.id, projectId: row.project_id, taskId: row.task_id };
  }

  private appendEvent(
    identity: TaskIdentity,
    eventType: string,
    payload: Record<string, unknown>,
    occurredAt: string,
    attemptId?: string | null,
  ): void {
    this.db.prepare(
      `INSERT INTO cli_task_events (id, task_id, attempt_id, event_type, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `evt_${randomUUID()}`,
      identity.recordId,
      attemptId || null,
      eventType,
      JSON.stringify(payload),
      occurredAt,
    );
  }

  private rowToTaskRecord(row: Record<string, unknown>): CliTaskRecord {
    const recentEvents = this.db.prepare(
      "SELECT payload_json FROM cli_task_events WHERE task_id = ? ORDER BY sequence DESC LIMIT 20",
    ).all(String(row.id)) as Array<{ payload_json: string }>;
    let lastError: string | undefined;
    let activeAttemptId: string | undefined;
    for (const event of recentEvents) {
      try {
        const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        if (!lastError && typeof payload.lastError === "string") lastError = payload.lastError;
        if (!activeAttemptId && typeof payload.activeAttemptId === "string") {
          activeAttemptId = payload.activeAttemptId;
        }
      } catch {
        // Ignore a malformed historical event while preserving the task record.
      }
    }
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
      ...(lastError ? { lastError } : {}),
      ...(
        activeAttemptId && (row.status === "RUNNING" || row.status === "VERIFYING")
          ? { activeAttemptId }
          : {}
      ),
    };
  }

  /**
   * Recovers tasks left in an active state during a previous system crash or abnormal exit.
   * Transitions them to 'INTERRUPTED' and appends a CRASH_RECOVERY event.
   */
  public recoverInterruptedTasksOnStartup(): number {
    const runningTasks = this.db.prepare(
      "SELECT id, project_id, task_id, status FROM cli_tasks WHERE status IN ('RUNNING', 'VERIFYING')"
    ).all() as Array<{ id: string; project_id: string; task_id: string; status: string }>;

    let recoveredCount = 0;
    const now = new Date().toISOString();

    for (const task of runningTasks) {
      const identity: TaskIdentity = {
        recordId: task.id,
        projectId: task.project_id,
        taskId: task.task_id,
      };
      this.db.prepare(
        "UPDATE cli_tasks SET status = 'INTERRUPTED', updated_at = ? WHERE id = ?"
      ).run(now, task.id);

      const taskIdCount = Number((this.db.prepare(
        "SELECT COUNT(*) AS count FROM cli_tasks WHERE task_id = ?",
      ).get(task.task_id) as { count: number }).count);
      const attemptKeys = taskIdCount === 1 ? [task.id, task.task_id] : [task.id];
      const placeholders = attemptKeys.map(() => "?").join(", ");
      const activeAttempts = this.db.prepare(
        `SELECT id FROM cli_task_attempts WHERE task_id IN (${placeholders}) AND status = 'STARTED'`,
      ).all(...attemptKeys) as Array<{ id: string }>;
      for (const attempt of activeAttempts) {
        this.db.prepare(
          "UPDATE cli_task_attempts SET status = 'INTERRUPTED', finished_at = ? WHERE id = ?",
        ).run(now, attempt.id);
      }

      this.appendEvent(identity, "CRASH_RECOVERY", {
        previousStatus: task.status,
        newStatus: "INTERRUPTED",
        outcome: "UNKNOWN",
        interruptedAttemptIds: activeAttempts.map((attempt) => attempt.id),
      }, now);

      recoveredCount++;
    }

    return recoveredCount;
  }

  /**
   * Saves or updates a CLI task envelope in SQLite database.
   */
  public saveTaskEnvelope(envelope: CliTaskEnvelopeV1, initialStatus: CliTaskState = "PROPOSED"): CliTaskRecord {
    const now = new Date().toISOString();
    const dbId = `taskrec_${randomUUID()}`;

    const existing = this.db.prepare(
      "SELECT * FROM cli_tasks WHERE project_id = ? AND task_id = ?"
    ).get(envelope.projectId, envelope.taskId) as Record<string, unknown> | undefined;

    if (existing) {
      const storedEnvelope = String(existing.task_json);
      const incomingEnvelope = JSON.stringify(envelope);
      if (storedEnvelope !== incomingEnvelope) {
        throw new Error(
          `Duplicate taskId '${envelope.taskId}' has a different envelope and was rejected`,
        );
      }
      return this.getTaskById(envelope.projectId, envelope.taskId)!;
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

      this.appendEvent({ recordId: dbId, projectId: envelope.projectId, taskId: envelope.taskId }, "TASK_PROPOSED", {
        initialStatus,
        envelope,
      }, now);
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

    this.appendEvent(
      { recordId: current.id, projectId, taskId },
      `TRANSITION_TO_${targetState}`,
      { from: current.status, to: targetState, ...(payload || {}) },
      now,
      attemptId,
    );

    return this.getTaskById(projectId, taskId)!;
  }

  public getTaskById(projectId: string, taskId: string): CliTaskRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM cli_tasks WHERE project_id = ? AND task_id = ?"
    ).get(projectId, taskId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToTaskRecord(row);
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
    return rows.map((row) => this.rowToTaskRecord(row));
  }

  /**
   * Creates a new attempt record for a task.
   */
  public createAttempt(projectId: string, taskId: string): CliTaskAttemptRecord;
  /** @deprecated Pass projectId and taskId to avoid cross-project ambiguity. */
  public createAttempt(taskId: string): CliTaskAttemptRecord;
  public createAttempt(projectIdOrTaskId: string, maybeTaskId?: string): CliTaskAttemptRecord {
    const identity = maybeTaskId === undefined
      ? this.getUniqueIdentity(projectIdOrTaskId)
      : this.getIdentity(projectIdOrTaskId, maybeTaskId);
    const existingAttempts = this.db.prepare(
      "SELECT MAX(attempt_number) as max_num FROM cli_task_attempts WHERE task_id = ?"
    ).get(identity.recordId) as { max_num: number | null } | undefined;

    const nextNumber = (existingAttempts?.max_num || 0) + 1;
    const attemptId = `att_${identity.recordId}_${nextNumber}`;
    const now = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO cli_task_attempts (id, task_id, attempt_number, status, started_at)
       VALUES (?, ?, ?, 'STARTED', ?)`
    ).run(attemptId, identity.recordId, nextNumber, now);

    return {
      id: attemptId,
      taskId: identity.taskId,
      attemptNumber: nextNumber,
      status: "STARTED",
      startedAt: now,
    };
  }

  public finishAttempt(attemptId: string, status: "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED"): void {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE cli_task_attempts SET status = ?, finished_at = ? WHERE id = ?"
    ).run(status, now, attemptId);
    if (Number(result.changes) !== 1) throw new Error(`Attempt '${attemptId}' not found`);
  }

  public listAttempts(projectId: string, taskId: string): CliTaskAttemptRecord[] {
    const identity = this.getIdentity(projectId, taskId);
    const rows = this.db.prepare(
      "SELECT * FROM cli_task_attempts WHERE task_id = ? ORDER BY attempt_number ASC",
    ).all(identity.recordId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      taskId: identity.taskId,
      attemptNumber: Number(row.attempt_number),
      status: String(row.status) as CliTaskAttemptRecord["status"],
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
    }));
  }

  public recordExecutionResult(
    projectId: string,
    taskId: string,
    attemptId: string,
    result: Record<string, unknown>,
  ): void {
    const identity = this.getIdentity(projectId, taskId);
    this.appendEvent(identity, "EXECUTION_RESULT_RECORDED", {
      activeAttemptId: attemptId,
      result,
    }, new Date().toISOString(), attemptId);
  }

  public getTaskEvents(projectId: string, taskId: string): CliTaskEventRecord[];
  /** @deprecated Pass projectId and taskId to avoid cross-project ambiguity. */
  public getTaskEvents(taskId: string): CliTaskEventRecord[];
  public getTaskEvents(projectIdOrTaskId: string, maybeTaskId?: string): CliTaskEventRecord[] {
    const identity = maybeTaskId === undefined
      ? this.getUniqueIdentity(projectIdOrTaskId)
      : this.getIdentity(projectIdOrTaskId, maybeTaskId);
    const rows = this.db.prepare(
      "SELECT * FROM cli_task_events WHERE task_id = ? ORDER BY sequence ASC"
    ).all(identity.recordId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      sequence: Number(r.sequence),
      id: String(r.id),
      taskId: identity.taskId,
      attemptId: r.attempt_id ? String(r.attempt_id) : null,
      eventType: String(r.event_type),
      payloadJson: String(r.payload_json),
      occurredAt: String(r.occurred_at),
    }));
  }
}
