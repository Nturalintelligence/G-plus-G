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
    expect(versions).toEqual([{ version: 1 }]);
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
});
