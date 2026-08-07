import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { AppDatabase } from "../src/storage/database.js";
import { TaskFsmRepository } from "../src/storage/task-fsm-repository.js";
import { TaskCompiler } from "../src/orchestrator/task-compiler.js";
import { SafeExecutionBroker, ExecutionResultV1 } from "../src/cli-executors/execution-broker.js";
import { ThreeTierMemoryManager } from "../src/context/three-tier-memory.js";
import { ContextBudgetEstimator, ContextRolloverManager } from "../src/context/context-rollover.js";
import { TurnValueGate } from "../src/orchestrator/turn-value-gate.js";
import { PromptRegistry } from "../src/orchestrator/prompt-registry.js";
import { CliExecutor, ExecutorCapabilities, ExecutorEvent, ExecutorHealth, ExecutorInput } from "../src/cli-executors/cli-executor-contract.js";

class E2EMockExecutor implements CliExecutor {
  readonly id = "codex" as const;

  public capabilities(): ExecutorCapabilities {
    return {
      supportsStreaming: true,
      supportedRisks: ["READ_ONLY", "WORKSPACE_WRITE"],
      maxTimeoutMs: 30000,
    };
  }

  public async healthCheck(): Promise<ExecutorHealth> {
    return { healthy: true, executorId: "codex" };
  }

  public async *execute(input: ExecutorInput, signal?: AbortSignal): AsyncIterable<ExecutorEvent> {
    const at = () => new Date().toISOString();
    yield { type: "STARTED", at: at(), attemptId: input.attemptId };

    if (input.task.taskId === "task-e2e-1") {
      yield { type: "STDOUT", at: at(), chunk: "Created src/components/card.tsx" };
      yield { type: "PROCESS_EXITED", at: at(), exitCode: 0 };
    } else {
      // Task 2 initial failure
      yield { type: "STDERR", at: at(), chunk: "Syntax error in styles module" };
      yield { type: "PROCESS_EXITED", at: at(), exitCode: 1 };
    }
  }
}

describe("Phase I: End-to-End Long Board Cycle Fixture Test", () => {
  let appDb: AppDatabase;
  let taskRepo: TaskFsmRepository;
  let compiler: TaskCompiler;
  let broker: SafeExecutionBroker;
  let memoryMgr: ThreeTierMemoryManager;
  let rolloverMgr: ContextRolloverManager;
  let estimator: ContextBudgetEstimator;
  let gate: TurnValueGate;
  let registry: PromptRegistry;
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-e2e-"));
    execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot, windowsHide: true });
    appDb = new AppDatabase(":memory:");
    appDb.migrate();
    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('proj-e2e', 'Full E2E Cycle', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();

    taskRepo = new TaskFsmRepository(appDb.raw);
    compiler = new TaskCompiler(taskRepo);
    broker = new SafeExecutionBroker();
    broker.registerExecutor(new E2EMockExecutor());
    memoryMgr = new ThreeTierMemoryManager(appDb.raw);
    rolloverMgr = new ContextRolloverManager(appDb.raw);
    estimator = new ContextBudgetEstimator(100_000);
    gate = new TurnValueGate(3);
    registry = new PromptRegistry(appDb.raw);
  });

  afterEach(() => {
    appDb.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("should complete a full 8-step long board cycle successfully", async () => {
    // Step 1: Decision Ledger - Register 3 accepted decisions & 1 rejected option
    const dec1 = memoryMgr.addMemoryItem("proj-e2e", "DECISION_ACCEPTED", "Use React + CSS modules for task cards");
    const dec2 = memoryMgr.addMemoryItem("proj-e2e", "DECISION_ACCEPTED", "Enforce strict schema validation on CLI envelopes");
    const dec3 = memoryMgr.addMemoryItem("proj-e2e", "DECISION_ACCEPTED", "Store checkpoints in SQLite");
    const rej1 = memoryMgr.addMemoryItem("proj-e2e", "OPTION_REJECTED", "Allow arbitrary shell string commands");

    expect(dec1.status).toBe("ACTIVE");
    expect(dec2.status).toBe("ACTIVE");
    expect(dec3.status).toBe("ACTIVE");
    expect(rej1.status).toBe("ACTIVE");

    // Step 2: Web Board emits Task 1
    const task1Envelope = {
      protocol: "gplusg.cli-task",
      version: 1,
      taskId: "task-e2e-1",
      projectId: "proj-e2e",
      runId: "run-e2e",
      parentTurnId: "turn-1",
      executor: "codex",
      title: "Create Task Card Component",
      objective: "Build card component",
      context: "Phase I test",
      instructions: ["Create card.tsx"],
      allowedPaths: ["package.json"],
      forbiddenPaths: [],
      acceptanceCriteria: ["Card component created"],
      verification: [{
        type: "command",
        executable: "git",
        args: ["status", "--porcelain"],
        timeoutMs: 5000,
      }],
      risk: "WORKSPACE_WRITE",
      requiresApproval: true,
      dependsOn: [],
    };

    const turn1Text = `
DELTA
Proposed task card UI component.

DECISION_UPDATE
Accepted Task Card design

NEXT_ACTION
EXECUTE

CLI_TASKS
[[G_PLUS_G_CLI_TASK_V1]]
${JSON.stringify(task1Envelope)}
[[/G_PLUS_G_CLI_TASK_V1]]

PUBLIC_SUMMARY
Proposed task 1.

DONE
NO
`;

    const processed1 = compiler.processModelTurnResponse(turn1Text, { workspaceRoot });
    expect(processed1.extractedEnvelopes).toHaveLength(1);
    const savedTask1 = processed1.savedTasks[0];
    expect(savedTask1).toBeDefined();

    // Step 3: Approve & Execute Task 1
    taskRepo.createAttempt("task-e2e-1");
    taskRepo.transitionState("proj-e2e", "task-e2e-1", "QUEUED");
    taskRepo.transitionState("proj-e2e", "task-e2e-1", "RUNNING");

    const execRes1 = await broker.executeTaskEnvelope(task1Envelope as any, "att-1", workspaceRoot);
    expect(execRes1.status).toBe("COMPLETED");
    taskRepo.transitionState("proj-e2e", "task-e2e-1", "VERIFYING");
    taskRepo.transitionState("proj-e2e", "task-e2e-1", "COMPLETED");

    memoryMgr.updateRollingBriefOnMaterialEvent("proj-e2e", {
      type: "CLI_EXECUTION_COMPLETED",
      description: "Completed Task 1",
      completedTaskTitle: "Create Task Card Component",
    });

    // Step 4: Web Board emits Task 2 (Will require fix)
    const task2Envelope = {
      ...task1Envelope,
      taskId: "task-e2e-2",
      title: "Add CSS Tokens",
      instructions: ["Add bad CSS"],
    };

    taskRepo.saveTaskEnvelope(task2Envelope as any, "QUEUED");
    taskRepo.createAttempt("task-e2e-2");
    taskRepo.transitionState("proj-e2e", "task-e2e-2", "RUNNING");

    const execRes2 = await broker.executeTaskEnvelope(task2Envelope as any, "att-1", workspaceRoot);
    expect(execRes2.status).toBe("FAILED");
    taskRepo.transitionState("proj-e2e", "task-e2e-2", "FAILED");

    // Reviewer requests fix
    const reviewerPrompt = compiler.buildReviewerPrompt(execRes2, task2Envelope as any);
    expect(reviewerPrompt).toContain("FAILED");

    // Retry Task 2 -> Fix attempt succeeds (Attempt #2)
    const att2 = taskRepo.createAttempt("task-e2e-2");
    expect(att2.attemptNumber).toBe(2);
    taskRepo.transitionState("proj-e2e", "task-e2e-2", "QUEUED");
    taskRepo.transitionState("proj-e2e", "task-e2e-2", "RUNNING");

    // Mock successful fix execution
    taskRepo.transitionState("proj-e2e", "task-e2e-2", "VERIFYING");
    taskRepo.transitionState("proj-e2e", "task-e2e-2", "COMPLETED");

    memoryMgr.updateRollingBriefOnMaterialEvent("proj-e2e", {
      type: "CLI_EXECUTION_COMPLETED",
      description: "Completed Task 2 fix",
      completedTaskTitle: "Add CSS Tokens",
    });

    // Step 5: TurnValueGate evaluation & Context budget check
    const evalResult = gate.evaluateTurn(turn1Text);
    expect(evalResult.isValuable).toBe(true);

    const budget = estimator.estimateBudget({
      totalCharsSent: 85_000,
      turnCount: 26,
      briefSizeChars: 2000,
    });
    expect(budget.status).toBe("ROLLOVER_REQUIRED");

    // Step 6: Create Checkpoint & Continuation Pack V1
    const activeItems = memoryMgr.getActiveMemoryItems("proj-e2e");
    const continuationPack = rolloverMgr.createContinuationPack({
      projectId: "proj-e2e",
      previousConversationId: "conv-old-999",
      objective: "Build local-first desktop application",
      activeMemoryItems: activeItems,
      completedWork: ["Create Task Card Component", "Add CSS Tokens"],
      openTasks: [],
      failedAttempts: [],
      nextAction: "Synthesize final output",
    });

    expect(continuationPack.decisions.length).toBeGreaterThanOrEqual(3);
    rolloverMgr.validateCheckpoint(continuationPack, activeItems, []);
    rolloverMgr.saveCheckpoint(continuationPack, "run-e2e");

    // Step 7: Rollover & Handshake
    const handshakeResponse = `
HANDSHAKE CONFIRMATION
Objective: Build local-first desktop application
Current State: Loaded 3 decisions and continuation pack.
Next Action: Synthesize final output
`;

    const handshakeRes = rolloverMgr.validateHandshake(handshakeResponse, continuationPack);
    expect(handshakeRes.match).toBe(true);

    // Step 8: Run Evaluation & Final Synthesis
    registry.recordRunEvaluation({
      runId: "run-e2e",
      projectId: "proj-e2e",
      promptVersion: registry.getActivePromptVersion().version,
      totalTurns: 8,
      lowValueTurns: 0,
      cliTasksCount: 2,
      rejectedTasksCount: 0,
      retriesCount: 1,
      userInterventionsCount: 1,
      cancelledDecisionsCount: 0,
      acceptancePassed: true,
      rolloverCount: 1,
      errorsCount: 0,
      userRating: 5,
    });

    const finalBrief = memoryMgr.getLatestRollingBrief("proj-e2e");
    expect(finalBrief).toBeDefined();
    expect(finalBrief?.completedWork).toContain("Create Task Card Component");
  });
});
