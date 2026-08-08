import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppDatabase } from "../src/storage/database.js";
import { CliExecutionService } from "../src/cli-executors/cli-execution-service.js";
import type { CliTaskEnvelopeV1 } from "../src/cli-executors/cli-task-schema.js";

describe("CliExecutionService Queue & Scheduler Integration", () => {
  let tmpDir: string;
  let appDb: AppDatabase;
  let service: CliExecutionService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-exec-service-test-"));
    appDb = new AppDatabase(":memory:");
    appDb.migrate();

    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('p-srv', 'Srv Project', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();

    service = new CliExecutionService(appDb.raw, { workspaceRoot: tmpDir });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("1. Reports real executor health/capabilities and the residual host-process risk", async () => {
    for (const id of ["codex", "gemini", "antigravity"] as const) {
      service.broker.registerExecutor({
        id,
        capabilities: () => ({
          supportsStreaming: true,
          supportedRisks: id === "codex" ? ["READ_ONLY", "WORKSPACE_WRITE", "COMMAND_EXECUTION"] : ["READ_ONLY"],
          maxTimeoutMs: 5000,
        }),
        healthCheck: async () => ({
          healthy: id !== "antigravity",
          executorId: id,
          ...(id === "antigravity" ? { reason: "not installed" } : { version: "test" }),
        }),
        execute: async function* () {},
      });
    }
    const executors = await service.getAvailableExecutors();
    expect(executors.some((e) => e.id === "codex")).toBe(true);
    expect(executors.some((e) => e.id === "gemini")).toBe(true);
    expect(executors.find((e) => e.id === "antigravity")).toMatchObject({
      healthy: false,
      reason: "not installed",
      hostProcessSandboxed: false,
    });

    const workspaces = service.getWorkspaceCapabilities();
    expect(workspaces).toEqual([
      {
        id: "project",
        label: "Managed CLI Workspace",
        allowedOperations: ["read", "write", "create_dir"],
        hostProcessSandboxed: false,
        enforcement: "preflight-and-postflight-audit",
      },
    ]);
  });

  it("cancels the active controller, maps the attempt to CANCELLED, and does not race into FAILED", async () => {
    const envelope: CliTaskEnvelopeV1 = {
      protocol: "gplusg.cli-task",
      version: 1,
      taskId: "task-cancel",
      projectId: "p-srv",
      runId: "run-cancel",
      parentTurnId: "turn-cancel",
      executor: "codex",
      title: "Cancelable task",
      objective: "Wait until cancelled",
      context: "Unit test",
      instructions: ["Wait"],
      allowedPaths: ["cancel.txt"],
      forbiddenPaths: [],
      acceptanceCriteria: ["Task is cancelled"],
      verification: [{ type: "file_exists", path: "cancel.txt" }],
      risk: "WORKSPACE_WRITE",
      requiresApproval: true,
      dependsOn: [],
    };
    service.broker.registerExecutor({
      id: "codex",
      capabilities: () => ({ supportsStreaming: true, supportedRisks: ["WORKSPACE_WRITE"], maxTimeoutMs: 5000 }),
      healthCheck: async () => ({ healthy: true, executorId: "codex" }),
      execute: async function* (_input, signal) {
        yield { type: "STARTED", at: new Date().toISOString(), attemptId: "attempt" };
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        yield { type: "CANCELLED", at: new Date().toISOString() };
      },
    });
    service.fsmRepo.saveTaskEnvelope(envelope, "QUEUED");
    const processing = service.processQueue();
    for (let index = 0; index < 100 && service.getTask("p-srv", "task-cancel")?.status !== "RUNNING"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    service.cancelTask("p-srv", "task-cancel");
    await processing;

    expect(service.getTask("p-srv", "task-cancel")?.status).toBe("CANCELLED");
    expect(service.fsmRepo.listAttempts("p-srv", "task-cancel")).toMatchObject([
      { status: "CANCELLED" },
    ]);
  });

  it("retries through a fresh approval boundary without pre-creating an attempt", () => {
    const envelope: CliTaskEnvelopeV1 = {
      protocol: "gplusg.cli-task",
      version: 1,
      taskId: "task-retry",
      projectId: "p-srv",
      runId: "run-retry",
      parentTurnId: "turn-retry",
      executor: "codex",
      title: "Retry task",
      objective: "Retry safely",
      context: "Unit test",
      instructions: ["Create retry.txt"],
      allowedPaths: ["retry.txt"],
      forbiddenPaths: [],
      acceptanceCriteria: ["retry.txt exists"],
      verification: [{ type: "file_exists", path: "retry.txt" }],
      risk: "WORKSPACE_WRITE",
      requiresApproval: true,
      dependsOn: [],
    };
    service.fsmRepo.saveTaskEnvelope(envelope, "FAILED");
    expect(service.retryTask("p-srv", "task-retry").status).toBe("AWAITING_APPROVAL");
    expect(service.fsmRepo.listAttempts("p-srv", "task-retry")).toHaveLength(0);
  });

  it("fails malformed queued JSON instead of leaving it queued", async () => {
    const envelope: CliTaskEnvelopeV1 = {
      protocol: "gplusg.cli-task",
      version: 1,
      taskId: "task-malformed",
      projectId: "p-srv",
      runId: "run-malformed",
      parentTurnId: "turn-malformed",
      executor: "codex",
      title: "Malformed task",
      objective: "Never execute",
      context: "Unit test",
      instructions: ["Do nothing"],
      allowedPaths: ["malformed.txt"],
      forbiddenPaths: [],
      acceptanceCriteria: ["Never executes"],
      verification: [{ type: "file_exists", path: "malformed.txt" }],
      risk: "WORKSPACE_WRITE",
      requiresApproval: true,
      dependsOn: [],
    };
    service.fsmRepo.saveTaskEnvelope(envelope, "QUEUED");
    appDb.raw.prepare("UPDATE cli_tasks SET task_json = ? WHERE project_id = ? AND task_id = ?")
      .run("{broken", "p-srv", "task-malformed");

    await service.processQueue();
    expect(service.getTask("p-srv", "task-malformed")).toMatchObject({
      status: "FAILED",
      lastError: expect.stringContaining("Malformed queued task"),
    });
    expect(service.fsmRepo.listAttempts("p-srv", "task-malformed")).toHaveLength(0);
  });

  it("waits for same-project dependencies and then schedules the dependent task", async () => {
    const dependency: CliTaskEnvelopeV1 = {
      protocol: "gplusg.cli-task",
      version: 1,
      taskId: "task-dependency",
      projectId: "p-srv",
      runId: "run-dependency",
      parentTurnId: "turn-dependency",
      executor: "codex",
      title: "Dependency",
      objective: "Create dependency.txt",
      context: "Unit test",
      instructions: ["Create the file"],
      allowedPaths: ["dependency.txt"],
      forbiddenPaths: [],
      acceptanceCriteria: ["dependency.txt exists"],
      verification: [{ type: "file_exists", path: "dependency.txt" }],
      risk: "WORKSPACE_WRITE",
      requiresApproval: true,
      dependsOn: [],
    };
    const dependent: CliTaskEnvelopeV1 = {
      ...dependency,
      taskId: "task-dependent",
      title: "Dependent",
      objective: "Create dependent.txt",
      allowedPaths: ["dependent.txt"],
      verification: [{ type: "file_exists", path: "dependent.txt" }],
      dependsOn: ["task-dependency"],
    };
    service.broker.registerExecutor({
      id: "codex",
      capabilities: () => ({ supportsStreaming: true, supportedRisks: ["WORKSPACE_WRITE"], maxTimeoutMs: 5000 }),
      healthCheck: async () => ({ healthy: true, executorId: "codex" }),
      execute: async function* (input) {
        fs.writeFileSync(path.join(input.workspaceRoot, input.task.allowedPaths[0]!), "ok");
        yield { type: "PROCESS_EXITED", at: new Date().toISOString(), exitCode: 0 };
      },
    });
    service.fsmRepo.saveTaskEnvelope(dependent, "QUEUED");
    service.fsmRepo.saveTaskEnvelope(dependency, "QUEUED");

    await service.processQueue();
    expect(service.getTask("p-srv", "task-dependency")?.status).toBe("COMPLETED");
    expect(service.getTask("p-srv", "task-dependent")?.status).toBe("COMPLETED");
  });

  it("2. Transition task to QUEUED on approveTask and executes attempt to completion", async () => {
    const envelope: CliTaskEnvelopeV1 = {
      protocol: "gplusg.cli-task",
      version: 1,
      taskId: "task-srv-1",
      projectId: "p-srv",
      runId: "run-srv-1",
      parentTurnId: "turn-1",
      executor: "codex",
      title: "Create test file",
      objective: "Create test file sample.txt",
      context: "Unit test",
      instructions: ["Create file sample.txt with content hello"],
      allowedPaths: ["sample.txt"],
      forbiddenPaths: [],
      acceptanceCriteria: ["sample.txt exists"],
      verification: [{ type: "file_exists", path: "sample.txt" }],
      risk: "WORKSPACE_WRITE",
      requiresApproval: true,
      dependsOn: [],
    };

    service.broker.registerExecutor({
      id: "codex" as any,
      capabilities: () => ({ supportsStreaming: true, supportedRisks: ["WORKSPACE_WRITE"], maxTimeoutMs: 5000 }),
      healthCheck: async () => ({ healthy: true, executorId: "codex" }),
      execute: async function* (input) {
        fs.writeFileSync(path.join(input.workspaceRoot, "sample.txt"), "hello");
        yield { type: "STARTED", at: new Date().toISOString(), attemptId: input.attemptId };
        yield { type: "PROCESS_EXITED", at: new Date().toISOString(), exitCode: 0 };
      },
    });

    service.fsmRepo.saveTaskEnvelope(envelope, "VALIDATED");
    service.fsmRepo.transitionState("p-srv", "task-srv-1", "AWAITING_APPROVAL");

    const approvedTask = await service.approveTask("p-srv", "task-srv-1");
    expect(approvedTask.status).toBe("QUEUED");

    // Wait for queue processing worker
    await service.processQueue();

    const finalTask = service.fsmRepo.getTaskById("p-srv", "task-srv-1");
    expect(finalTask?.status).toBe("COMPLETED");
    expect(service.fsmRepo.listAttempts("p-srv", "task-srv-1")).toHaveLength(1);
    expect(service.fsmRepo.getTaskEvents("p-srv", "task-srv-1").some(
      (event) => event.eventType === "EXECUTION_RESULT_RECORDED",
    )).toBe(true);
  });
});
