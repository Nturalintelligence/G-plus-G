import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

const databases: AppDatabase[] = [];

function createDatabase(): AppDatabase {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  const database = new AppDatabase(join(directory, "test.sqlite"));
  databases.push(database);
  database.migrate();
  return database;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("SQLite project state", () => {
  it("replays migrations on an empty database and is idempotent", () => {
    const database = createDatabase();
    database.migrate();
    const versions = database.raw
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
    ]);
    const artifactColumns = database.raw.prepare("PRAGMA table_info(downloaded_artifacts)").all() as Array<{ name: string }>;
    expect(artifactColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "acquisition_id", "retry_of_acquisition_id", "physical_click_count",
    ]));
    expect(artifactColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["failure_reason", "failure_detail"]));
    expect(artifactColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "provenance", "task_id", "assistant_turn_id", "source_message_id",
    ]));
    const projectColumns = database.raw.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    expect(projectColumns.map((column) => column.name)).toContain("derived_artifact_policy");
  });

  it("persists the shared project transcript", () => {
    const database = createDatabase();
    const repository = new ProjectRepository(database);
    const project = repository.createProject("Shared transcript");
    repository.appendConversationEntry({
      projectId: project.id,
      role: "USER",
      content: "hello",
    });
    repository.appendConversationEntry({
      projectId: project.id,
      role: "ASSISTANT",
      providerId: "gemini",
      round: 1,
      content: "hi",
    });
    expect(repository.conversationEntries(project.id).map((entry) => entry.content)).toEqual([
      "hello",
      "hi",
    ]);
  });

  it("persists projects after reopening the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestrator-reopen-"));
    const path = join(directory, "test.sqlite");
    const first = new AppDatabase(path);
    first.migrate();
    const created = new ProjectRepository(first).createProject(
      "Durable project",
      undefined,
      "Persistent description",
    );
    first.close();

    const second = new AppDatabase(path);
    databases.push(second);
    second.migrate();
    expect(new ProjectRepository(second).openProject(created.id)).toMatchObject({
      name: "Durable project",
      description: "Persistent description",
    });
  });

  it("makes events append-only at the database boundary", () => {
    const database = createDatabase();
    const repository = new ProjectRepository(database);
    repository.createProject("Append only");
    expect(() => database.raw.exec("DELETE FROM events")).toThrow(/append-only/);
    expect(() => database.raw.exec("UPDATE events SET event_type = 'tampered'")).toThrow(
      /append-only/,
    );
  });

  it("recovers unfinished turns without losing history", () => {
    const database = createDatabase();
    const repository = new ProjectRepository(database);
    const project = repository.createProject("Recovery");
    const conversation = repository.createConversation(project.id, "chatgpt");
    const { turn, attempt } = repository.beginTurn(conversation.id);
    repository.addMessage(turn.id, attempt.id, "USER", "hello");
    repository.updateTurnStatus(turn.id, "WAITING_RESPONSE");

    expect(repository.recoverUnfinishedTurns(project.id)).toBe(1);
    expect(repository.recoverUnfinishedTurns(project.id)).toBe(0);

    const storedTurn = database.raw
      .prepare("SELECT status FROM turns WHERE id = ?")
      .get(turn.id);
    const storedAttempt = database.raw
      .prepare("SELECT status FROM attempts WHERE id = ?")
      .get(attempt.id);
    expect(storedTurn?.status).toBe("INTERRUPTED");
    expect(storedAttempt?.status).toBe("INTERRUPTED");
    expect(repository.events().map((event) => event.eventType)).toContain(
      "TURN_RECOVERED_AS_INTERRUPTED",
    );
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count).toBe(1);
  });

  it("recovers orphaned orchestration runs after a crash", () => {
    const database = createDatabase();
    const repository = new ProjectRepository(database);
    const project = repository.createProject("Run recovery");
    const now = new Date().toISOString();
    database.raw
      .prepare(
        `INSERT INTO orchestration_runs
         (id, project_id, mode, status, limits_json, created_at, updated_at)
         VALUES ('run_crashed', ?, 'MANUAL', 'RUNNING', '{}', ?, ?)`,
      )
      .run(project.id, now, now);
    expect(repository.recoverUnfinishedRuns(project.id)).toBe(1);
    expect(repository.recoverUnfinishedRuns(project.id)).toBe(0);
    expect(
      database.raw.prepare("SELECT status FROM orchestration_runs").get()?.status,
    ).toBe("FAILED");
    expect(repository.projectEvents(project.id).map((event) => event.eventType)).toContain(
      "RUN_RECOVERED_AS_FAILED",
    );
  });

  it("deletes projects and their associated data cleanly", () => {
    const database = createDatabase();
    const repository = new ProjectRepository(database);
    const project = repository.createProject("Project to Delete");
    const conversation = repository.createConversation(project.id, "chatgpt");
    repository.appendConversationEntry({
      projectId: project.id,
      role: "USER",
      content: "Hello",
    });
    const now = new Date().toISOString();
    database.raw.prepare(`INSERT INTO message_attachments
      (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, created_at, updated_at)
      VALUES ('att-delete', 'draft-delete', ?, 'document', 'note.md', 'text/markdown', 4, 'hash', 'p/note.md', 'picker', 'READY', ?, ?)`)
      .run(project.id, now, now);
    database.raw.prepare(`INSERT INTO attachment_deliveries
      (id, attachment_id, provider_id, conversation_id, status)
      VALUES ('delivery-delete', 'att-delete', 'chatgpt', ?, 'PENDING')`)
      .run(conversation.id);
    database.raw.prepare(`INSERT INTO provider_submissions
      (submission_id, message_id, provider_id, attachment_ids_json, state, created_at)
      VALUES ('submission-delete', 'draft-delete', 'chatgpt', '["att-delete"]', 'PREPARING', ?)`)
      .run(now);
    database.raw.prepare(`INSERT INTO composer_drafts
      (project_id, text, message_id, attachment_ids_json, mode, continuation_policy, starter,
       providers_json, view_mode, finalizer_mode, final_responder, composer_expanded, updated_at)
      VALUES (?, 'draft', 'draft-delete', '["att-delete"]', 'DEBATE', 'autonomous', 'chatgpt',
              '["chatgpt"]', 'SYNTHESIZED', 'MANUAL', 'chatgpt', 0, ?)`)
      .run(project.id, now);
    database.raw.prepare(`INSERT INTO memory_items
      (id, project_id, kind, text, status, source_message_ids_json, created_at, updated_at)
      VALUES ('memory-delete', ?, 'REQUIREMENT', 'remember', 'ACTIVE', '[]', ?, ?)`)
      .run(project.id, now, now);
    database.raw.prepare(`INSERT INTO exports
      (id, project_id, state_version, status, directory, manifest_hash, created_at)
      VALUES ('export-delete', ?, 1, 'DRAFT', 'exports/test', 'hash', ?)`)
      .run(project.id, now);
    database.raw.prepare(`INSERT INTO downloaded_artifacts
      (id, message_id, project_id, provider_id, original_url, sha256, local_relative_path, file_name, mime_type, size_bytes, status, downloaded_at)
      VALUES ('dl-delete', 'assistant-delete', ?, 'chatgpt', 'https://chatgpt.com/file', 'abc', 'p/file', 'file.txt', 'text/plain', 3, 'READY', ?)`)
      .run(project.id, new Date().toISOString());

    expect(repository.listProjects().length).toBe(1);
    expect(repository.getConversationsForProject(project.id).length).toBe(1);

    repository.deleteProject(project.id);

    expect(repository.listProjects().length).toBe(0);
    expect(repository.getConversationsForProject(project.id).length).toBe(0);
    expect(repository.conversationEntries(project.id).length).toBe(0);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM downloaded_artifacts WHERE project_id = ?").get(project.id)?.count).toBe(0);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM message_attachments WHERE project_id = ?").get(project.id)?.count).toBe(0);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM composer_drafts WHERE project_id = ?").get(project.id)?.count).toBe(0);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE project_id = ?").get(project.id)?.count).toBe(0);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM exports WHERE project_id = ?").get(project.id)?.count).toBe(0);
  });
});
