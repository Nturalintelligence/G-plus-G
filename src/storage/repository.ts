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

  createProject(name: string): Project {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Project name cannot be empty");
    const project: Project = {
      id: newId("prj"),
      name: cleanName,
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO projects(id, name, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(project.id, project.name, project.status, project.createdAt, project.updatedAt);
      this.appendEventInternal("Project", project.id, "PROJECT_CREATED", {
        name: project.name,
      });
    });
    return project;
  }

  listProjects(): Project[] {
    return this.database.raw
      .prepare(
        `SELECT id, name, status, created_at, updated_at
         FROM projects ORDER BY created_at DESC`,
      )
      .all()
      .map(mapProject);
  }

  openProject(id: string): Project | null {
    const row = this.database.raw
      .prepare(
        `SELECT id, name, status, created_at, updated_at FROM projects WHERE id = ?`,
      )
      .get(id);
    return row ? mapProject(row) : null;
  }

  appendConversationEntry(input: {
    projectId: string;
    runId?: string | null;
    role: MessageRole;
    providerId?: string | null;
    round?: number | null;
    content: string;
  }): ConversationEntry {
    const entry: ConversationEntry = {
      id: newId("entry"),
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

  conversationEntries(projectId: string): ConversationEntry[] {
    return this.database.raw
      .prepare(
        `SELECT id, project_id, run_id, role, provider_id, round, content, created_at
         FROM conversation_entries
         WHERE project_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(projectId)
      .map((row) => ({
        id: String(row.id),
        projectId: String(row.project_id),
        runId: row.run_id === null ? null : String(row.run_id),
        role: String(row.role) as MessageRole,
        providerId: row.provider_id === null ? null : String(row.provider_id),
        round: row.round === null ? null : Number(row.round),
        content: String(row.content),
        createdAt: String(row.created_at),
      }));
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
    status: String(row.status) as Project["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
