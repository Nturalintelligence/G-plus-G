import { describe, expect, it, beforeEach } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { TaskFsmRepository } from "../src/storage/task-fsm-repository.js";
import { CliTaskEnvelopeV1 } from "../src/cli-executors/cli-task-schema.js";

describe("Phase B: Storage Migrations & Task FSM Repository", () => {
  let appDb: AppDatabase;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:");
    appDb.migrate();
    // Seed initial project
    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('proj-1', 'Test Project', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();
  });

  const dummyEnvelope: CliTaskEnvelopeV1 = {
    protocol: "gplusg.cli-task",
    version: 1,
    taskId: "task-101",
    projectId: "proj-1",
    runId: "run-1",
    parentTurnId: "turn-1",
    executor: "codex",
    title: "Implement FSM storage",
    objective: "Create tables and FSM repository",
    context: "Phase B implementation",
    instructions: ["Add migration 6"],
    allowedPaths: ["src/storage/migrations.ts"],
    forbiddenPaths: [],
    acceptanceCriteria: ["Migration 6 applies successfully"],
    verification: [{ type: "file_exists", path: "src/storage/migrations.ts" }],
    risk: "WORKSPACE_WRITE",
    requiresApproval: true,
    dependsOn: [],
  };

  it("should apply migration 6 successfully and create new tables", () => {
    const repo = new TaskFsmRepository(appDb.raw);
    const task = repo.saveTaskEnvelope(dummyEnvelope);

    expect(task.taskId).toBe("task-101");
    expect(task.status).toBe("PROPOSED");

    const events = repo.getTaskEvents("task-101");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("TASK_PROPOSED");
  });

  it("should enforce valid FSM transitions", () => {
    const repo = new TaskFsmRepository(appDb.raw);
    repo.saveTaskEnvelope(dummyEnvelope);

    // PROPOSED -> VALIDATED
    let task = repo.transitionState("proj-1", "task-101", "VALIDATED");
    expect(task.status).toBe("VALIDATED");

    // VALIDATED -> AWAITING_APPROVAL
    task = repo.transitionState("proj-1", "task-101", "AWAITING_APPROVAL");
    expect(task.status).toBe("AWAITING_APPROVAL");

    // AWAITING_APPROVAL -> QUEUED
    task = repo.transitionState("proj-1", "task-101", "QUEUED");
    expect(task.status).toBe("QUEUED");

    // QUEUED -> RUNNING
    task = repo.transitionState("proj-1", "task-101", "RUNNING");
    expect(task.status).toBe("RUNNING");

    // RUNNING -> VERIFYING
    task = repo.transitionState("proj-1", "task-101", "VERIFYING");
    expect(task.status).toBe("VERIFYING");

    // VERIFYING -> COMPLETED
    task = repo.transitionState("proj-1", "task-101", "COMPLETED");
    expect(task.status).toBe("COMPLETED");

    const events = repo.getTaskEvents("task-101");
    expect(events).toHaveLength(7); // Initial + 6 transitions
  });

  it("should reject invalid FSM state transitions", () => {
    const repo = new TaskFsmRepository(appDb.raw);
    repo.saveTaskEnvelope(dummyEnvelope);

    // PROPOSED cannot directly go to COMPLETED
    expect(() => {
      repo.transitionState("proj-1", "task-101", "COMPLETED");
    }).toThrow(/Invalid FSM state transition/);
  });

  it("should be idempotent when transitioning to current state", () => {
    const repo = new TaskFsmRepository(appDb.raw);
    repo.saveTaskEnvelope(dummyEnvelope);

    const task = repo.transitionState("proj-1", "task-101", "PROPOSED");
    expect(task.status).toBe("PROPOSED");

    const events = repo.getTaskEvents("task-101");
    expect(events).toHaveLength(1); // No duplicate transition event appended
  });

  it("should recover interrupted tasks left in RUNNING state on startup", () => {
    const repo = new TaskFsmRepository(appDb.raw);
    repo.saveTaskEnvelope(dummyEnvelope, "PROPOSED");
    repo.transitionState("proj-1", "task-101", "VALIDATED");
    repo.transitionState("proj-1", "task-101", "AWAITING_APPROVAL");
    repo.transitionState("proj-1", "task-101", "QUEUED");
    const attempt = repo.createAttempt("proj-1", "task-101");
    repo.transitionState("proj-1", "task-101", "RUNNING", { activeAttemptId: attempt.id }, attempt.id);

    // Simulate crash and app restart
    const newRepo = new TaskFsmRepository(appDb.raw);
    const recoveredCount = newRepo.recoverInterruptedTasksOnStartup();

    expect(recoveredCount).toBe(1);

    const updatedTask = newRepo.getTaskById("proj-1", "task-101");
    expect(updatedTask?.status).toBe("INTERRUPTED");

    const events = newRepo.getTaskEvents("task-101");
    const crashEvent = events.find((e) => e.eventType === "CRASH_RECOVERY");
    expect(crashEvent).toBeDefined();
    expect(JSON.parse(crashEvent!.payloadJson)).toMatchObject({ outcome: "UNKNOWN" });
    expect(newRepo.listAttempts("proj-1", "task-101")).toMatchObject([
      { status: "INTERRUPTED", finishedAt: expect.any(String) },
    ]);
  });

  it("should track task attempts correctly", () => {
    const repo = new TaskFsmRepository(appDb.raw);
    repo.saveTaskEnvelope(dummyEnvelope);

    const attempt1 = repo.createAttempt("task-101");
    expect(attempt1.attemptNumber).toBe(1);
    expect(attempt1.status).toBe("STARTED");

    repo.finishAttempt(attempt1.id, "FAILED");

    const attempt2 = repo.createAttempt("task-101");
    expect(attempt2.attemptNumber).toBe(2);

    repo.finishAttempt(attempt2.id, "COMPLETED");
  });

  it("keeps an identical duplicate idempotent and rejects changed duplicate content", () => {
    const repo = new TaskFsmRepository(appDb.raw);
    const first = repo.saveTaskEnvelope(dummyEnvelope, "AWAITING_APPROVAL");
    const duplicate = repo.saveTaskEnvelope(dummyEnvelope, "QUEUED");
    expect(duplicate.status).toBe(first.status);
    expect(repo.getTaskEvents(dummyEnvelope.taskId)).toHaveLength(1);

    expect(() => repo.saveTaskEnvelope({
      ...dummyEnvelope,
      objective: "Different content under the same task id",
    })).toThrow(/different envelope/);
    expect(repo.getTaskById(dummyEnvelope.projectId, dummyEnvelope.taskId)?.objective)
      .toBe(dummyEnvelope.objective);
  });

  it("requires project identity when the same taskId exists in multiple projects", () => {
    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('proj-2', 'Second', 'ACTIVE', '2026-01-01', '2026-01-01')",
    ).run();
    const repo = new TaskFsmRepository(appDb.raw);
    repo.saveTaskEnvelope(dummyEnvelope);
    repo.saveTaskEnvelope({ ...dummyEnvelope, projectId: "proj-2" });

    expect(() => repo.createAttempt("task-101")).toThrow(/ambiguous across projects/);
    expect(repo.createAttempt("proj-1", "task-101").attemptNumber).toBe(1);
    expect(repo.createAttempt("proj-2", "task-101").attemptNumber).toBe(1);
    expect(repo.getTaskEvents("proj-1", "task-101")).toHaveLength(1);
    expect(repo.getTaskEvents("proj-2", "task-101")).toHaveLength(1);
  });
});
