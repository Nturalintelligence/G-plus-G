import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { AppDatabase } from "../src/storage/database.js";
import { TaskFsmRepository } from "../src/storage/task-fsm-repository.js";
import { TaskCompiler } from "../src/orchestrator/task-compiler.js";
import { SafeExecutionBroker, ExecutionResultV1 } from "../src/cli-executors/execution-broker.js";
import { CliTaskEnvelopeV1 } from "../src/cli-executors/cli-task-schema.js";

describe("Phase D: Orchestrator Integration & Review Routing", () => {
  let appDb: AppDatabase;
  let repository: TaskFsmRepository;
  let compiler: TaskCompiler;
  const workspaceRoot = path.resolve(process.cwd());

  beforeEach(() => {
    appDb = new AppDatabase(":memory:");
    appDb.migrate();
    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('proj-d', 'Phase D Test', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();
    repository = new TaskFsmRepository(appDb.raw);
    compiler = new TaskCompiler(repository);
  });

  const validEnvelopeObject: CliTaskEnvelopeV1 = {
    protocol: "gplusg.cli-task",
    version: 1,
    taskId: "task-d-1",
    projectId: "proj-d",
    runId: "run-d",
    parentTurnId: "turn-d",
    executor: "codex",
    title: "Implement routing module",
    objective: "Route execution results to reviewer model",
    context: "Phase D testing",
    instructions: ["Add routing logic"],
    allowedPaths: ["src/orchestrator/task-compiler.ts"],
    forbiddenPaths: [],
    acceptanceCriteria: ["Review prompt generated"],
    verification: [{ type: "file_exists", path: "package.json" }],
    risk: "WORKSPACE_WRITE",
    requiresApproval: true,
    dependsOn: [],
  };

  it("should clean public transcript by replacing raw task blocks with summary badges", () => {
    const rawResponse = `
I recommend the following task:

[[G_PLUS_G_CLI_TASK_V1]]
${JSON.stringify(validEnvelopeObject)}
[[/G_PLUS_G_CLI_TASK_V1]]

Let me know if approved.
`;

    const cleaned = compiler.cleanPublicTranscript(rawResponse);
    expect(cleaned).not.toContain("[[G_PLUS_G_CLI_TASK_V1]]");
    expect(cleaned).toContain("[CLI Task Proposed: Implement routing module]");
  });

  it("should process model turn response and apply risk approval policy", () => {
    const rawResponse = `
[[G_PLUS_G_CLI_TASK_V1]]
${JSON.stringify(validEnvelopeObject)}
[[/G_PLUS_G_CLI_TASK_V1]]
`;

    const processed = compiler.processModelTurnResponse(rawResponse, {
      workspaceRoot,
      autoExecuteReadOnly: false,
    });

    expect(processed.extractedEnvelopes).toHaveLength(1);
    expect(processed.savedTasks).toHaveLength(1);

    const saved0 = processed.savedTasks[0];
    expect(saved0).toBeDefined();
    expect(saved0?.status).toBe("AWAITING_APPROVAL");
  });

  it("should require approval for READ_ONLY task even when autoExecuteReadOnly is requested", () => {
    const readOnlyEnvelope: CliTaskEnvelopeV1 = {
      ...validEnvelopeObject,
      taskId: "task-d-readonly",
      risk: "READ_ONLY",
    };

    const rawResponse = `
[[G_PLUS_G_CLI_TASK_V1]]
${JSON.stringify(readOnlyEnvelope)}
[[/G_PLUS_G_CLI_TASK_V1]]
`;

    const processed = compiler.processModelTurnResponse(rawResponse, {
      workspaceRoot,
      autoExecuteReadOnly: true,
    });

    const saved0 = processed.savedTasks[0];
    expect(saved0).toBeDefined();
    expect(saved0?.status).toBe("AWAITING_APPROVAL");
  });

  it("should format ExecutionResultV1 into single-reviewer report prompt", () => {
    const mockResult: ExecutionResultV1 = {
      taskId: "task-d-1",
      attemptId: "att-1",
      executor: "codex",
      status: "COMPLETED",
      summary: "Task completed and verified",
      changedFiles: [{ path: "src/orchestrator/task-compiler.ts", change: "modified" }],
      verificationResults: [
        { label: "File exists: package.json", passed: true, summary: "File exists" },
      ],
      warnings: [],
      nextRecommendation: "Proceed to next step",
    };

    const prompt = compiler.buildReviewerPrompt(mockResult, validEnvelopeObject);
    expect(prompt).toContain("CLI EXECUTION REVIEW REPORT FOR TASK: 'Implement routing module'");
    expect(prompt).toContain("[MODIFIED] src/orchestrator/task-compiler.ts");
    expect(prompt).toContain("ACCEPT");
    expect(prompt).toContain("REQUEST_FIX");
    expect(prompt).toContain("ESCALATE_TO_USER");
  });
});
