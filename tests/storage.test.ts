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
    ]);
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
    const created = new ProjectRepository(first).createProject("Durable project");
    first.close();

    const second = new AppDatabase(path);
    databases.push(second);
    second.migrate();
    expect(new ProjectRepository(second).openProject(created.id)?.name).toBe("Durable project");
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
    database.raw.prepare(
      `INSERT INTO message_attachments
       (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256,
        local_relative_path, source, status, created_at)
       VALUES ('att_delete', 'msg_delete', ?, 'text', 'a.txt', 'text/plain', 1,
               '00', 'project/blob/a.txt', 'user', 'STAGED', ?)`,
    ).run(project.id, now);
    database.raw.prepare(
      `INSERT INTO attachment_deliveries
       (id, attachment_id, provider_id, conversation_id, status)
       VALUES ('delivery_delete', 'att_delete', 'chatgpt', ?, 'PENDING')`,
    ).run(conversation.id);
    database.raw.prepare(
      `INSERT INTO provider_submissions
       (submission_id, message_id, provider_id, attachment_ids_json, state, created_at)
       VALUES ('submission_delete', 'msg_delete', 'chatgpt', '["att_delete"]', 'PREPARING', ?)`,
    ).run(now);
    database.raw.prepare(
      `INSERT INTO downloaded_artifacts
       (id, message_id, project_id, provider_id, original_url, sha256,
        local_relative_path, status, downloaded_at)
       VALUES ('download_delete', 'msg_response', ?, 'chatgpt', 'https://example.test/a',
               '00', 'project/blob/result.txt', 'READY', ?)`,
    ).run(project.id, now);
    database.raw.prepare(
      `INSERT INTO cli_tasks
       (id, task_id, project_id, run_id, parent_turn_id, executor, title, objective,
        context, risk, status, task_json, created_at, updated_at)
       VALUES ('cli_delete', 'task_delete', ?, 'run_delete', 'turn_delete', 'codex',
               'Delete fixture', 'fixture', '', 'READ_ONLY', 'AWAITING_APPROVAL', '{}', ?, ?)`,
    ).run(project.id, now, now);
    database.raw.prepare(
      `INSERT INTO cli_task_attempts
       (id, task_id, attempt_number, status, started_at)
       VALUES ('attempt_delete', 'task_delete', 1, 'STARTED', ?)`,
    ).run(now);
    database.raw.prepare(
      `INSERT INTO cli_task_events
       (id, task_id, attempt_id, event_type, payload_json, occurred_at)
       VALUES ('event_delete', 'task_delete', 'attempt_delete', 'TEST', '{}', ?)`,
    ).run(now);

    expect(repository.listProjects().length).toBe(1);
    expect(repository.getConversationsForProject(project.id).length).toBe(1);

    repository.deleteProject(project.id);

    expect(repository.listProjects().length).toBe(0);
    expect(repository.getConversationsForProject(project.id).length).toBe(0);
    expect(repository.conversationEntries(project.id).length).toBe(0);
    for (const table of [
      "message_attachments",
      "attachment_deliveries",
      "provider_submissions",
      "downloaded_artifacts",
      "cli_tasks",
      "cli_task_attempts",
      "cli_task_events",
    ]) {
      expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
    }
  });
});
