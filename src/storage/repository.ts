import { createHash } from "node:crypto";
import type {
  Attempt,
  Conversation,
  ConversationEntry,
  DomainEvent,
  Message,
  MessageRole,
  Project,
  Turn,
  TurnStatus,
} from "../domain.js";
import { newId } from "../ids.js";
import type { AppDatabase } from "./database.js";

type SqlValue = string | number | null;

export class ProjectRepository {
  constructor(private readonly database: AppDatabase) {}

  createProject(name: string, providers?: string[], description = ""): Project {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Project name cannot be empty");
    const cleanDescription = description.trim();
    if (cleanDescription.length > 2_000) throw new Error("Project description cannot exceed 2000 characters");
    const project: Project = {
      id: newId("prj"),
      name: cleanName,
      description: cleanDescription,
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providers: providers || [],
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO projects(id, name, description, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(project.id, project.name, project.description ?? "", project.status, project.createdAt, project.updatedAt);
      if (providers && providers.length > 0) {
        const stmt = this.database.raw.prepare(
          `INSERT INTO project_providers(project_id, provider_id) VALUES (?, ?)`
        );
        for (const provider of providers) {
          stmt.run(project.id, provider);
        }
      }
      this.appendEventInternal("Project", project.id, "PROJECT_CREATED", {
        name: project.name,
        description: project.description,
        providers: project.providers,
      });
    });
    return project;
  }

  listProjects(): Project[] {
    const projects = this.database.raw
      .prepare(
        `SELECT id, name, description, status, created_at, updated_at
         FROM projects ORDER BY created_at DESC`,
      )
      .all()
      .map(mapProject);
    for (const project of projects) {
      project.providers = this.getProjectProviders(project.id);
    }
    return projects;
  }

  openProject(id: string): Project | null {
    const row = this.database.raw
      .prepare(
        `SELECT id, name, description, status, created_at, updated_at FROM projects WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    const project = mapProject(row);
    project.providers = this.getProjectProviders(project.id);
    return project;
  }

  private getProjectProviders(projectId: string): string[] {
    const rows = this.database.raw
      .prepare(`SELECT provider_id FROM project_providers WHERE project_id = ?`)
      .all(projectId) as Array<{ provider_id: string }>;
    return rows.map((r) => r.provider_id);
  }

  appendConversationEntry(input: {
    id?: string;
    projectId: string;
    runId?: string | null;
    role: MessageRole;
    providerId?: string | null;
    round?: number | null;
    content: string;
  }): ConversationEntry {
    const entry: ConversationEntry = {
      id: input.id ?? newId("entry"),
      projectId: input.projectId,
      runId: input.runId ?? null,
      role: input.role,
      providerId: input.providerId ?? null,
      round: input.round ?? null,
      content: input.content,
      createdAt: new Date().toISOString(),
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO conversation_entries
           (id, project_id, run_id, role, provider_id, round, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.projectId,
          entry.runId,
          entry.role,
          entry.providerId,
          entry.round,
          entry.content,
          entry.createdAt,
        );
      this.appendEventInternal("Project", entry.projectId, "TRANSCRIPT_ENTRY_RECORDED", {
        entryId: entry.id,
        runId: entry.runId,
        role: entry.role,
        providerId: entry.providerId,
        round: entry.round,
      });
    });
    return entry;
  }

  upsertConversationEntry(input: {
    id: string;
    projectId: string;
    runId?: string | null;
    role: MessageRole;
    providerId?: string | null;
    round?: number | null;
    content: string;
  }): ConversationEntry {
    const existingRow = this.database.raw.prepare(`
      SELECT id, project_id, run_id, role, provider_id, round, content, created_at
      FROM conversation_entries WHERE id = ?
    `).get(input.id);
    const existing = existingRow ? {
      id: String(existingRow.id),
      projectId: String(existingRow.project_id),
      runId: existingRow.run_id === null ? null : String(existingRow.run_id),
      role: String(existingRow.role) as MessageRole,
      providerId: existingRow.provider_id === null ? null : String(existingRow.provider_id),
      round: existingRow.round === null ? null : Number(existingRow.round),
      content: String(existingRow.content),
      createdAt: String(existingRow.created_at),
    } satisfies ConversationEntry : null;
    if (!existing) return this.appendConversationEntry(input);
    if (existing.projectId !== input.projectId || existing.role !== input.role) {
      throw new Error(`Conversation entry identity mismatch: ${input.id}`);
    }
    const content = input.content;
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `UPDATE conversation_entries
           SET run_id = ?, provider_id = ?, round = ?, content = ?
           WHERE id = ?`,
        )
        .run(
          input.runId ?? null,
          input.providerId ?? null,
          input.round ?? null,
          content,
          input.id,
        );
      this.appendEventInternal("Project", input.projectId, "TRANSCRIPT_ENTRY_UPDATED", {
        entryId: input.id,
        runId: input.runId ?? null,
        role: input.role,
        providerId: input.providerId ?? null,
        round: input.round ?? null,
        contentLength: content.length,
      });
    });
    return { ...existing, runId: input.runId ?? null, providerId: input.providerId ?? null, round: input.round ?? null, content };
  }

  conversationEntries(projectId: string): ConversationEntry[] {
    return this.database.raw
      .prepare(
        `SELECT id, project_id, run_id, role, provider_id, round, content, created_at
         FROM conversation_entries
         WHERE project_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(projectId)
      .map(mapConversationEntry);
  }

  getConversationsForProject(projectId: string): Conversation[] {
    const rows = this.database.raw
      .prepare(
        `SELECT id, project_id, provider_id, external_ref, status, created_at, updated_at
         FROM conversations WHERE project_id = ?`,
      )
      .all(projectId);
    return rows.map((row) => mapConversation(row));
  }

  deleteProject(projectId: string): void {
    this.database.transaction(() => {
      this.deleteProjectRows(projectId);
    });
  }

  deleteProjects(projectIds: string[]): void {
    const ids = [...new Set(projectIds)];
    this.database.transaction(() => {
      for (const projectId of ids) {
        const exists = this.database.raw.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
        if (!exists) throw new Error(`Project not found: ${projectId}`);
      }
      for (const projectId of ids) this.deleteProjectRows(projectId);
    });
  }

  private deleteProjectRows(projectId: string): void {
      const conversations = this.getConversationsForProject(projectId);
      const taskRows = this.database.raw
        .prepare("SELECT id FROM cli_tasks WHERE project_id = ?")
        .all(projectId) as Array<{ id: string }>;
      for (const task of taskRows) {
        this.database.raw.prepare("DELETE FROM execution_artifacts WHERE task_id = ?").run(task.id);
        this.database.raw.prepare("DELETE FROM cli_task_events WHERE task_id = ?").run(task.id);
        this.database.raw.prepare("DELETE FROM cli_task_attempts WHERE task_id = ?").run(task.id);
      }
      for (const conversation of conversations) {
        const turns = this.database.raw
          .prepare("SELECT id FROM turns WHERE conversation_id = ?")
          .all(conversation.id) as Array<{ id: string }>;
        for (const turn of turns) {
          this.database.raw.prepare("DELETE FROM messages WHERE turn_id = ?").run(turn.id);
          this.database.raw.prepare("DELETE FROM attempts WHERE turn_id = ?").run(turn.id);
        }
        this.database.raw.prepare("DELETE FROM turns WHERE conversation_id = ?").run(conversation.id);
      }
      this.database.raw.prepare(`
        DELETE FROM attachment_deliveries
        WHERE attachment_id IN (SELECT id FROM message_attachments WHERE project_id = ?)
      `).run(projectId);
      this.database.raw.prepare(`
        DELETE FROM provider_submissions
        WHERE message_id IN (SELECT message_id FROM message_attachments WHERE project_id = ?)
      `).run(projectId);
      this.database.raw.prepare("DELETE FROM message_attachments WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM composer_drafts WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM conversation_entries WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM conversations WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM run_evaluations WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM context_checkpoints WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM conversation_rollovers WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM rolling_briefs WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM memory_items WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM cli_tasks WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM exports WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM orchestration_runs WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM project_state_versions WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM downloaded_artifacts WHERE project_id = ?").run(projectId);
      this.database.raw.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      this.appendEventInternal("Project", projectId, "PROJECT_DELETED", { projectId });
  }

  createConversation(projectId: string, providerId: string): Conversation {
    const timestamp = new Date().toISOString();
    const conversation: Conversation = {
      id: newId("cnv"),
      projectId,
      providerId,
      externalRef: null,
      status: "ACTIVE",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO conversations
           (id, project_id, provider_id, external_ref, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conversation.id,
          conversation.projectId,
          conversation.providerId,
          conversation.externalRef,
          conversation.status,
          conversation.createdAt,
          conversation.updatedAt,
        );
      this.appendEventInternal("Conversation", conversation.id, "CONVERSATION_CREATED", {
        projectId,
        providerId,
      });
    });
    return conversation;
  }

  getOrCreateConversation(projectId: string, providerId: string): Conversation {
    const row = this.database.raw
      .prepare(
        `SELECT id, project_id, provider_id, external_ref, status, created_at, updated_at
         FROM conversations
         WHERE project_id = ? AND provider_id = ? AND status = 'ACTIVE'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, providerId);
    return row ? mapConversation(row) : this.createConversation(projectId, providerId);
  }

  updateConversationExternalRef(id: string, externalRef: string): Conversation {
    const clean = externalRef.trim();
    if (!/^https:\/\//i.test(clean)) throw new Error("Conversation reference must be HTTPS");
    const updatedAt = new Date().toISOString();
    const result = this.database.raw
      .prepare(
        `UPDATE conversations SET external_ref = ?, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE'`,
      )
      .run(clean, updatedAt, id);
    if (result.changes !== 1) throw new Error(`Active conversation not found: ${id}`);
    this.appendEventInternal("Conversation", id, "CONVERSATION_REF_UPDATED", {
      externalRef: clean,
    });
    const row = this.database.raw
      .prepare(
        `SELECT id, project_id, provider_id, external_ref, status, created_at, updated_at
         FROM conversations WHERE id = ?`,
      )
      .get(id);
    return mapConversation(row!);
  }

  clearConversationExternalRef(id: string): void {
    const updatedAt = new Date().toISOString();
    const result = this.database.raw
      .prepare("UPDATE conversations SET external_ref = NULL, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
      .run(updatedAt, id);
    if (result.changes !== 1) throw new Error(`Active conversation not found: ${id}`);
    this.appendEventInternal("Conversation", id, "CONVERSATION_REF_CLEARED", {
      reason: "REMOTE_UNAVAILABLE",
    });
  }

  conversationEntryById(id: string): ConversationEntry | null {
    const row = this.database.raw.prepare(`
      SELECT id, project_id, run_id, role, provider_id, round, content, created_at
      FROM conversation_entries WHERE id = ?
    `).get(id);
    return row ? mapConversationEntry(row) : null;
  }

  beginTurn(conversationId: string): { turn: Turn; attempt: Attempt } {
    return this.database.transaction(() => {
      const ordinalRow = this.database.raw
        .prepare(
          "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM turns WHERE conversation_id = ?",
        )
        .get(conversationId);
      const ordinal = Number(ordinalRow?.ordinal ?? 1);
      const timestamp = new Date().toISOString();
      const turn: Turn = {
        id: newId("trn"),
        conversationId,
        ordinal,
        status: "PENDING",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const attempt: Attempt = {
        id: newId("att"),
        turnId: turn.id,
        ordinal: 1,
        status: "STARTED",
        startedAt: timestamp,
        finishedAt: null,
      };
      this.database.raw
        .prepare(
          `INSERT INTO turns(id, conversation_id, ordinal, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(turn.id, turn.conversationId, turn.ordinal, turn.status, timestamp, timestamp);
      this.database.raw
        .prepare(
          `INSERT INTO attempts(id, turn_id, ordinal, status, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(attempt.id, attempt.turnId, attempt.ordinal, attempt.status, timestamp, null);
      this.appendEventInternal("Turn", turn.id, "TURN_CREATED", { conversationId, ordinal });
      this.appendEventInternal("Attempt", attempt.id, "ATTEMPT_STARTED", {
        turnId: turn.id,
        ordinal: 1,
      });
      return { turn, attempt };
    });
  }

  beginAttempt(turnId: string): Attempt {
    return this.database.transaction(() => {
      const ordinalRow = this.database.raw
        .prepare(
          "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM attempts WHERE turn_id = ?",
        )
        .get(turnId);
      const attempt: Attempt = {
        id: newId("att"),
        turnId,
        ordinal: Number(ordinalRow?.ordinal ?? 1),
        status: "STARTED",
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      this.database.raw
        .prepare(
          `INSERT INTO attempts(id, turn_id, ordinal, status, started_at, finished_at)
           VALUES (?, ?, ?, 'STARTED', ?, NULL)`,
        )
        .run(attempt.id, attempt.turnId, attempt.ordinal, attempt.startedAt);
      this.appendEventInternal("Attempt", attempt.id, "ATTEMPT_STARTED", {
        turnId,
        ordinal: attempt.ordinal,
      });
      return attempt;
    });
  }

  finishAttempt(
    attemptId: string,
    status: "COMPLETED" | "FAILED" | "INTERRUPTED",
    detail?: string,
  ): void {
    this.database.transaction(() => {
      const result = this.database.raw
        .prepare(
          `UPDATE attempts SET status = ?, finished_at = ?
           WHERE id = ? AND status = 'STARTED'`,
        )
        .run(status, new Date().toISOString(), attemptId);
      if (result.changes !== 1) throw new Error(`Active attempt not found: ${attemptId}`);
      this.appendEventInternal("Attempt", attemptId, `ATTEMPT_${status}`, {
        ...(detail ? { detail } : {}),
      });
    });
  }

  addMessage(
    turnId: string,
    attemptId: string | null,
    role: MessageRole,
    content: string,
  ): Message {
    const message: Message = {
      id: newId("msg"),
      turnId,
      attemptId,
      role,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      createdAt: new Date().toISOString(),
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO messages
           (id, turn_id, attempt_id, role, content, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.turnId,
          message.attemptId,
          message.role,
          message.content,
          message.contentHash,
          message.createdAt,
        );
      this.appendEventInternal("Message", message.id, "MESSAGE_RECORDED", {
        turnId,
        attemptId,
        role,
        contentHash: message.contentHash,
      });
    });
    return message;
  }

  updateTurnStatus(turnId: string, status: TurnStatus): void {
    this.database.transaction(() => {
      const result = this.database.raw
        .prepare("UPDATE turns SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, new Date().toISOString(), turnId);
      if (result.changes !== 1) throw new Error(`Turn not found: ${turnId}`);
      this.appendEventInternal("Turn", turnId, "TURN_STATUS_CHANGED", { status });
    });
  }

  recoverUnfinishedTurns(projectId?: string): number {
    return this.database.transaction(() => {
      const params: SqlValue[] = [];
      let projectFilter = "";
      if (projectId) {
        projectFilter = "AND c.project_id = ?";
        params.push(projectId);
      }
      const rows = this.database.raw
        .prepare(
          `SELECT t.id
           FROM turns t
           JOIN conversations c ON c.id = t.conversation_id
           WHERE t.status IN ('PENDING', 'SUBMITTING', 'WAITING_RESPONSE')
           ${projectFilter}`,
        )
        .all(...params);
      const timestamp = new Date().toISOString();
      for (const row of rows) {
        const turnId = String(row.id);
        this.database.raw
          .prepare("UPDATE turns SET status = 'INTERRUPTED', updated_at = ? WHERE id = ?")
          .run(timestamp, turnId);
        this.database.raw
          .prepare(
            `UPDATE attempts SET status = 'INTERRUPTED', finished_at = ?
             WHERE turn_id = ? AND status = 'STARTED'`,
          )
          .run(timestamp, turnId);
        this.appendEventInternal("Turn", turnId, "TURN_RECOVERED_AS_INTERRUPTED", {
          recoveredAt: timestamp,
        });
      }
      return rows.length;
    });
  }

  events(aggregateId?: string): DomainEvent[] {
    const rows = aggregateId
      ? this.database.raw
          .prepare("SELECT * FROM events WHERE aggregate_id = ? ORDER BY sequence")
          .all(aggregateId)
      : this.database.raw.prepare("SELECT * FROM events ORDER BY sequence").all();
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      id: String(row.id),
      aggregateType: String(row.aggregate_type),
      aggregateId: String(row.aggregate_id),
      eventType: String(row.event_type),
      payload: JSON.parse(String(row.payload_json)),
      occurredAt: String(row.occurred_at),
    }));
  }

  recoverUnfinishedRuns(projectId?: string): number {
    return this.database.transaction(() => {
      const params: SqlValue[] = [];
      const projectFilter = projectId ? "AND project_id = ?" : "";
      if (projectId) params.push(projectId);
      const rows = this.database.raw
        .prepare(
          `SELECT id FROM orchestration_runs
           WHERE status IN ('CREATED', 'RUNNING', 'PAUSED', 'AWAITING_CONFIRMATION')
           ${projectFilter}`,
        )
        .all(...params);
      const timestamp = new Date().toISOString();
      for (const row of rows) {
        const runId = String(row.id);
        this.database.raw
          .prepare(
            `UPDATE orchestration_runs
             SET status = 'FAILED', finished_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, timestamp, runId);
        this.appendEventInternal(
          "OrchestrationRun",
          runId,
          "RUN_RECOVERED_AS_FAILED",
          { recoveredAt: timestamp, reason: "previous process ended unexpectedly" },
        );
      }
      return rows.length;
    });
  }

  projectEvents(projectId: string, limit = 500): DomainEvent[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)));
    const rows = this.database.raw
      .prepare(
        `SELECT e.*
         FROM events e
         WHERE
           (e.aggregate_type = 'Project' AND e.aggregate_id = ?)
           OR e.aggregate_id IN (
             SELECT id FROM conversations WHERE project_id = ?
           )
           OR e.aggregate_id IN (
             SELECT t.id FROM turns t
             JOIN conversations c ON c.id = t.conversation_id
             WHERE c.project_id = ?
           )
           OR e.aggregate_id IN (
             SELECT a.id FROM attempts a
             JOIN turns t ON t.id = a.turn_id
             JOIN conversations c ON c.id = t.conversation_id
             WHERE c.project_id = ?
           )
           OR e.aggregate_id IN (
             SELECT m.id FROM messages m
             JOIN turns t ON t.id = m.turn_id
             JOIN conversations c ON c.id = t.conversation_id
             WHERE c.project_id = ?
           )
           OR e.aggregate_id IN (
             SELECT id FROM orchestration_runs WHERE project_id = ?
           )
           OR e.aggregate_id IN (
             SELECT id FROM project_state_versions WHERE project_id = ?
           )
         ORDER BY e.sequence DESC
         LIMIT ?`,
      )
      .all(
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
        safeLimit,
      );
    return rows.reverse().map(mapEvent);
  }

  private appendEventInternal(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: unknown,
  ): void {
    this.database.raw
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
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description === undefined || row.description === null ? "" : String(row.description),
    status: String(row.status) as Project["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapConversation(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    providerId: String(row.provider_id),
    externalRef: row.external_ref === null ? null : String(row.external_ref),
    status: String(row.status) as Conversation["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapConversationEntry(row: Record<string, unknown>): ConversationEntry {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    runId: row.run_id === null ? null : String(row.run_id),
    role: String(row.role) as MessageRole,
    providerId: row.provider_id === null ? null : String(row.provider_id),
    round: row.round === null ? null : Number(row.round),
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

function mapEvent(row: Record<string, unknown>): DomainEvent {
  return {
    sequence: Number(row.sequence),
    id: String(row.id),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    eventType: String(row.event_type),
    payload: JSON.parse(String(row.payload_json)),
    occurredAt: String(row.occurred_at),
  };
}
