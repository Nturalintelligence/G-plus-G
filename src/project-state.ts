import { newId } from "./ids.js";
import type { AppDatabase } from "./storage/database.js";

export interface TracedItem {
  id: string;
  text: string;
  sourceTurnIds: string[];
}

export interface DecisionItem extends TracedItem {
  rationale: string;
}

export interface ProjectState {
  requirements: TracedItem[];
  constraints: TracedItem[];
  decisions: DecisionItem[];
  rejectedOptions: DecisionItem[];
  openQuestions: TracedItem[];
  acceptanceCriteria: TracedItem[];
}

export interface ProjectStateVersion {
  id: string;
  projectId: string;
  version: number;
  status: "DRAFT" | "APPROVED";
  state: ProjectState;
  sourceTurnIds: string[];
  createdAt: string;
  approvedAt: string | null;
}

export const emptyProjectState = (): ProjectState => ({
  requirements: [],
  constraints: [],
  decisions: [],
  rejectedOptions: [],
  openQuestions: [],
  acceptanceCriteria: [],
});

export class ProjectStateService {
  constructor(private readonly database: AppDatabase) {}

  createVersion(projectId: string, state: ProjectState): ProjectStateVersion {
    validateState(state);
    const latest = this.latest(projectId);
    const version = (latest?.version ?? 0) + 1;
    const sourceTurnIds = [
      ...new Set(
        Object.values(state)
          .flat()
          .flatMap((item) => item.sourceTurnIds),
      ),
    ];
    const result: ProjectStateVersion = {
      id: newId("state"),
      projectId,
      version,
      status: "DRAFT",
      state,
      sourceTurnIds,
      createdAt: new Date().toISOString(),
      approvedAt: null,
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO project_state_versions
           (id, project_id, version, status, state_json, source_turn_ids_json, created_at, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          result.id,
          result.projectId,
          result.version,
          result.status,
          JSON.stringify(result.state),
          JSON.stringify(result.sourceTurnIds),
          result.createdAt,
          null,
        );
      appendEvent(this.database, "ProjectState", result.id, "PROJECT_STATE_DRAFTED", {
        projectId,
        version,
        sourceTurnIds,
      });
    });
    return result;
  }

  approve(id: string): ProjectStateVersion {
    this.database.transaction(() => {
      const changed = this.database.raw
        .prepare(
          `UPDATE project_state_versions
           SET status = 'APPROVED', approved_at = ?
           WHERE id = ? AND status = 'DRAFT'`,
        )
        .run(new Date().toISOString(), id);
      if (changed.changes !== 1) throw new Error(`Draft state not found: ${id}`);
      appendEvent(this.database, "ProjectState", id, "PROJECT_STATE_APPROVED", {});
    });
    return this.byId(id)!;
  }

  latest(projectId: string): ProjectStateVersion | null {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM project_state_versions
         WHERE project_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(projectId);
    return row ? mapVersion(row) : null;
  }

  byId(id: string): ProjectStateVersion | null {
    const row = this.database.raw
      .prepare("SELECT * FROM project_state_versions WHERE id = ?")
      .get(id);
    return row ? mapVersion(row) : null;
  }
}

function validateState(state: ProjectState): void {
  for (const [section, items] of Object.entries(state)) {
    for (const item of items) {
      if (!item.id || !item.text.trim()) throw new Error(`Invalid item in ${section}`);
      if (!Array.isArray(item.sourceTurnIds)) throw new Error(`Missing traceability in ${section}`);
    }
  }
  if (state.acceptanceCriteria.length === 0) {
    throw new Error("Project State must contain at least one acceptance criterion");
  }
}

function appendEvent(
  database: AppDatabase,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: unknown,
): void {
  database.raw
    .prepare(
      `INSERT INTO events
       (id, aggregate_type, aggregate_id, event_type, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("evt"),
      aggregateType,
      aggregateId,
      eventType,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
}

function mapVersion(row: Record<string, unknown>): ProjectStateVersion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    version: Number(row.version),
    status: String(row.status) as ProjectStateVersion["status"],
    state: JSON.parse(String(row.state_json)) as ProjectState,
    sourceTurnIds: JSON.parse(String(row.source_turn_ids_json)) as string[],
    createdAt: String(row.created_at),
    approvedAt: row.approved_at === null ? null : String(row.approved_at),
  };
}
