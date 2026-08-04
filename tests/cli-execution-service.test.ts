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

    service = new CliExecutionService(appDb.raw, { desktopPath: tmpDir });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("1. Registers standard CLI executors and desktop workspace capability", () => {
    const executors = service.getAvailableExecutors();
    expect(executors.some((e) => e.id === "codex")).toBe(true);
    expect(executors.some((e) => e.id === "gemini")).toBe(true);

    const workspaces = service.getWorkspaceCapabilities();
    expect(workspaces.some((w) => w.id === "desktop")).toBe(true);
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
  });
});
