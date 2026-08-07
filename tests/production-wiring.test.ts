import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppDatabase } from "../src/storage/database.js";
import { CliExecutionService } from "../src/cli-executors/cli-execution-service.js";
import { TaskCompiler } from "../src/orchestrator/task-compiler.js";
import type { CliTaskEnvelopeV1 } from "../src/cli-executors/cli-task-schema.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";

describe("Production Wiring Integration Tests (Scenarios A & B)", () => {
  let tmpDir: string;
  let appDb: AppDatabase;
  let service: CliExecutionService;
  let compiler: TaskCompiler;
  let store: LocalArtifactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-prod-test-"));
    appDb = new AppDatabase(":memory:");
    appDb.migrate();

    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('p-prod', 'Production Test Project', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();

    service = new CliExecutionService(appDb.raw, { workspaceRoot: tmpDir });
    compiler = new TaskCompiler(service.fsmRepo);
    store = new LocalArtifactStore(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Scenario A: Persists and links response artifacts safely without data corruption", () => {
    const fileBuf = Buffer.from("gotovo content sample");
    const ref = store.storeBuffer(fileBuf, {
      projectId: "p-prod",
      messageId: "msg-chatgpt-1",
      source: "chatgpt",
      originalFileName: "готово.txt",
    });

    appDb.raw.prepare(`
      INSERT INTO message_attachments
      (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref.id,
      ref.messageId,
      ref.projectId,
      ref.kind,
      ref.fileName,
      ref.mimeType,
      ref.sizeBytes,
      ref.sha256,
      ref.localRelativePath,
      ref.source,
      ref.status,
      new Date().toISOString()
    );

    const row = appDb.raw.prepare("SELECT * FROM message_attachments WHERE id = ?").get(ref.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.file_name).toBe("готово.txt");
    expect(row.mime_type).toBe("text/plain");

    const readBuf = store.readBuffer(ref.localRelativePath);
    expect(readBuf.toString("utf-8")).toBe("gotovo content sample");
  });

  it("Scenario B: Web Board -> TaskCompiler -> AWAITING_APPROVAL -> User Approval -> Execution Queue Worker -> COMPLETED", async () => {
    const webBoardTurn = `
Plan ready:

[[G_PLUS_G_CLI_TASK_V1]]
{
  "protocol": "gplusg.cli-task",
  "version": 1,
  "taskId": "task-board-1",
  "projectId": "p-prod",
  "runId": "run-board-1",
  "parentTurnId": "turn-b-1",
  "executor": "codex",
  "title": "Create desktop folder gotovo",
  "objective": "Create directory gotovo and file gotovo/gotovo.txt",
  "context": "Scenario B test",
  "instructions": [
    "Create directory gotovo in desktop",
    "Create file gotovo/gotovo.txt with text gotovo"
  ],
  "allowedPaths": ["gotovo", "gotovo/gotovo.txt"],
  "forbiddenPaths": [],
  "acceptanceCriteria": ["gotovo/gotovo.txt exists"],
  "verification": [{ "type": "file_exists", "path": "gotovo/gotovo.txt" }],
  "risk": "WORKSPACE_WRITE",
  "requiresApproval": true,
  "dependsOn": []
}
[[/G_PLUS_G_CLI_TASK_V1]]
    `;

    // 1. Web Board turn processed through TaskCompiler
    const compileResult = compiler.processModelTurnResponse(webBoardTurn, { workspaceRoot: tmpDir });
    expect(compileResult.extractedEnvelopes.length).toBe(1);

    // 2. Task recorded in database as AWAITING_APPROVAL
    const savedTask = service.fsmRepo.getTaskById("p-prod", "task-board-1");
    expect(savedTask).toBeDefined();
    expect(savedTask?.status).toBe("AWAITING_APPROVAL");

    // 3. Register mock executor that simulates creating local file gotovo/gotovo.txt
    service.broker.registerExecutor({
      id: "codex" as any,
      capabilities: () => ({ supportsStreaming: true, supportedRisks: ["WORKSPACE_WRITE"], maxTimeoutMs: 5000 }),
      healthCheck: async () => ({ healthy: true, executorId: "codex" }),
      execute: async function* (input) {
        const dir = path.join(input.workspaceRoot, "gotovo");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "gotovo.txt"), "gotovo", "utf-8");
        yield { type: "STARTED", at: new Date().toISOString(), attemptId: input.attemptId };
        yield { type: "PROCESS_EXITED", at: new Date().toISOString(), exitCode: 0 };
      },
    });

    // 4. User clicks Approve -> transitions state to QUEUED and triggers scheduler
    const approved = await service.approveTask("p-prod", "task-board-1");
    expect(approved.status).toBe("QUEUED");

    await service.processQueue();

    // 5. Task finishes in COMPLETED state and file actually exists
    const finalTask = service.fsmRepo.getTaskById("p-prod", "task-board-1");
    expect(finalTask?.status).toBe("COMPLETED");

    expect(fs.existsSync(path.join(tmpDir, "gotovo", "gotovo.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "gotovo", "gotovo.txt"), "utf-8")).toBe("gotovo");
  });
});
