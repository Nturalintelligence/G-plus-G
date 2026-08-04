import { DatabaseSync } from "node:sqlite";

export type MemoryKind =
  | "REQUIREMENT"
  | "CONSTRAINT"
  | "DECISION_ACCEPTED"
  | "OPTION_REJECTED"
  | "OPEN_QUESTION"
  | "ARTIFACT"
  | "KNOWN_RISK"
  | "ACCEPTANCE_CRITERION";

export type MemoryStatus = "ACTIVE" | "RESOLVED" | "SUPERSEDED";

export interface MemoryItem {
  id: string;
  projectId: string;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  supersedesId?: string | null;
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RollingBrief {
  id: string;
  projectId: string;
  version: number;
  objective: string;
  currentState: string;
  activeRequirements: string[];
  activeConstraints: string[];
  acceptedDecisions: string[];
  rejectedOptions: string[];
  completedWork: string[];
  openTasks: string[];
  knownFailures: string[];
  artifacts: string[];
  nextAction: string;
  sourceMessageIds: string[];
  createdAt: string;
}

export type MaterialEventType =
  | "DECISION_MADE"
  | "USER_EDIT"
  | "CLI_EXECUTION_COMPLETED"
  | "CHECKPOINT_CREATED";

export interface MaterialEvent {
  type: MaterialEventType;
  description: string;
  sourceMessageIds?: string[];
  completedTaskTitle?: string;
  acceptedDecisionText?: string;
}

export class ThreeTierMemoryManager {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Adds a new structured memory item. If supersedesId is provided,
   * the prior decision/item is marked as SUPERSEDED.
   */
  public addMemoryItem(
    projectId: string,
    kind: MemoryKind,
    text: string,
    sourceMessageIds: string[] = [],
    supersedesId?: string
  ): MemoryItem {
    const now = new Date().toISOString();
    const id = `mem_${projectId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (supersedesId) {
      this.db.prepare(
        "UPDATE memory_items SET status = 'SUPERSEDED', updated_at = ? WHERE id = ? AND project_id = ?"
      ).run(now, supersedesId, projectId);
    }

    this.db.prepare(
      `INSERT INTO memory_items (id, project_id, kind, text, status, supersedes_id, source_message_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`
    ).run(id, projectId, kind, text, supersedesId || null, JSON.stringify(sourceMessageIds), now, now);

    return this.getMemoryItemById(id)!;
  }

  public resolveMemoryItem(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE memory_items SET status = 'RESOLVED', updated_at = ? WHERE id = ?").run(now, id);
  }

  public getMemoryItemById(id: string): MemoryItem | null {
    const row = this.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: String(row.id),
      projectId: String(row.project_id),
      kind: row.kind as MemoryKind,
      text: String(row.text),
      status: row.status as MemoryStatus,
      supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
      sourceMessageIds: JSON.parse(String(row.source_message_ids_json || "[]")),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public getActiveMemoryItems(projectId: string, kind?: MemoryKind): MemoryItem[] {
    let sql = "SELECT * FROM memory_items WHERE project_id = ? AND status = 'ACTIVE'";
    const params: Array<string | number | null> = [projectId];

    if (kind) {
      sql += " AND kind = ?";
      params.push(kind);
    }
    sql += " ORDER BY created_at ASC";

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      kind: row.kind as MemoryKind,
      text: String(row.text),
      status: row.status as MemoryStatus,
      supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
      sourceMessageIds: JSON.parse(String(row.source_message_ids_json || "[]")),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /**
   * Generates a new RollingBrief version only on material events.
   */
  public updateRollingBriefOnMaterialEvent(
    projectId: string,
    event: MaterialEvent,
    objective = "Execute user project"
  ): RollingBrief {
    const latestBriefRow = this.db.prepare(
      "SELECT MAX(version) as max_v FROM rolling_briefs WHERE project_id = ?"
    ).get(projectId) as { max_v: number | null } | undefined;

    const nextVersion = (latestBriefRow?.max_v || 0) + 1;
    const now = new Date().toISOString();
    const id = `brief_${projectId}_v${nextVersion}`;

    const activeReqs = this.getActiveMemoryItems(projectId, "REQUIREMENT").map((m) => m.text);
    const activeConstraints = this.getActiveMemoryItems(projectId, "CONSTRAINT").map((m) => m.text);
    const acceptedDecisions = this.getActiveMemoryItems(projectId, "DECISION_ACCEPTED").map((m) => m.text);
    const rejectedOptions = this.getActiveMemoryItems(projectId, "OPTION_REJECTED").map((m) => m.text);
    const artifacts = this.getActiveMemoryItems(projectId, "ARTIFACT").map((m) => m.text);

    // Fetch existing brief if available to retain completed work
    let completedWork: string[] = [];
    if (latestBriefRow?.max_v) {
      const prevRow = this.db.prepare(
        "SELECT completed_work_json FROM rolling_briefs WHERE project_id = ? AND version = ?"
      ).get(projectId, latestBriefRow.max_v) as { completed_work_json: string } | undefined;

      if (prevRow) {
        completedWork = JSON.parse(prevRow.completed_work_json || "[]");
      }
    }

    if (event.type === "CLI_EXECUTION_COMPLETED" && event.completedTaskTitle) {
      completedWork.push(event.completedTaskTitle);
    }

    const openTasksRows = this.db.prepare(
      "SELECT title FROM cli_tasks WHERE project_id = ? AND status IN ('PROPOSED', 'VALIDATED', 'AWAITING_APPROVAL', 'QUEUED', 'RUNNING')"
    ).all(projectId) as Array<{ title: string }>;
    const openTasks = openTasksRows.map((r) => r.title);

    const knownFailuresRows = this.db.prepare(
      "SELECT title FROM cli_tasks WHERE project_id = ? AND status IN ('FAILED', 'NEEDS_FIX')"
    ).all(projectId) as Array<{ title: string }>;
    const knownFailures = knownFailuresRows.map((r) => r.title);

    const brief: RollingBrief = {
      id,
      projectId,
      version: nextVersion,
      objective,
      currentState: `Updated state following ${event.type}: ${event.description}`,
      activeRequirements: activeReqs,
      activeConstraints,
      acceptedDecisions,
      rejectedOptions,
      completedWork,
      openTasks,
      knownFailures,
      artifacts,
      nextAction: openTasks.length > 0 ? "Execute open CLI tasks" : "Continue architectural synthesis",
      sourceMessageIds: event.sourceMessageIds || [],
      createdAt: now,
    };

    this.db.prepare(
      `INSERT INTO rolling_briefs (id, project_id, version, objective, current_state, active_requirements_json, active_constraints_json, accepted_decisions_json, rejected_options_json, completed_work_json, open_tasks_json, known_failures_json, artifacts_json, next_action, source_message_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      brief.id,
      brief.projectId,
      brief.version,
      brief.objective,
      brief.currentState,
      JSON.stringify(brief.activeRequirements),
      JSON.stringify(brief.activeConstraints),
      JSON.stringify(brief.acceptedDecisions),
      JSON.stringify(brief.rejectedOptions),
      JSON.stringify(brief.completedWork),
      JSON.stringify(brief.openTasks),
      JSON.stringify(brief.knownFailures),
      JSON.stringify(brief.artifacts),
      brief.nextAction,
      JSON.stringify(brief.sourceMessageIds),
      brief.createdAt
    );

    return brief;
  }

  public getLatestRollingBrief(projectId: string): RollingBrief | null {
    const row = this.db.prepare(
      "SELECT * FROM rolling_briefs WHERE project_id = ? ORDER BY version DESC LIMIT 1"
    ).get(projectId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: String(row.id),
      projectId: String(row.project_id),
      version: Number(row.version),
      objective: String(row.objective),
      currentState: String(row.current_state),
      activeRequirements: JSON.parse(String(row.active_requirements_json || "[]")),
      activeConstraints: JSON.parse(String(row.active_constraints_json || "[]")),
      acceptedDecisions: JSON.parse(String(row.accepted_decisions_json || "[]")),
      rejectedOptions: JSON.parse(String(row.rejected_options_json || "[]")),
      completedWork: JSON.parse(String(row.completed_work_json || "[]")),
      openTasks: JSON.parse(String(row.open_tasks_json || "[]")),
      knownFailures: JSON.parse(String(row.known_failures_json || "[]")),
      artifacts: JSON.parse(String(row.artifacts_json || "[]")),
      nextAction: String(row.next_action),
      sourceMessageIds: JSON.parse(String(row.source_message_ids_json || "[]")),
      createdAt: String(row.created_at),
    };
  }
}
