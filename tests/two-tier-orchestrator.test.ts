import { describe, expect, it } from "vitest";
import { parseCliTasksFromBoardResponse, TwoTierOrchestrator } from "../src/orchestrator/two-tier-orchestrator.js";
import { CliExecutorBridge } from "../src/cli-executors/cli-executor-bridge.js";

describe("Two-Tier Orchestrator (V1 Protocol Only)", () => {
  const validV1TaskObj = {
    protocol: "gplusg.cli-task",
    version: 1,
    taskId: "task-tt-1",
    projectId: "proj-1",
    runId: "run-1",
    parentTurnId: "turn-1",
    executor: "codex",
    title: "Build UI theme",
    objective: "Build Telegram-grade UI theme",
    context: "Two-tier testing",
    instructions: ["Create index.css"],
    allowedPaths: ["src/index.css"],
    forbiddenPaths: [],
    acceptanceCriteria: ["CSS variables created"],
    verification: [{ type: "file_exists", path: "src/index.css" }],
    risk: "WORKSPACE_WRITE",
    requiresApproval: true,
    dependsOn: [],
  };

  it("parses CLI tasks correctly from board response with V1 tags", () => {
    const text = `
Here is our architectural plan.
[[G_PLUS_G_CLI_TASK_V1]]
${JSON.stringify(validV1TaskObj)}
[[/G_PLUS_G_CLI_TASK_V1]]
    `;

    const tasks = parseCliTasksFromBoardResponse(text, "gemini");
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.tool).toBe("codex");
    expect(tasks[0]?.task).toBe("Build Telegram-grade UI theme");
  });

  it("returns 0 tasks when board response contains legacy tags (legacy tags are NOT executed)", () => {
    const legacyText = `
Here is our plan.
[[G_PLUS_G_CLI_TASK:{"tool":"gemini","task":"Build UI theme"}]]
    `;

    const tasks = parseCliTasksFromBoardResponse(legacyText, "gemini");
    expect(tasks.length).toBe(0); // Legacy tags ignored safely
  });

  it("returns 0 tasks when no V1 CLI tags exist (NO raw text fallback allowed)", () => {
    const text = "Plan: Build beauty salon app with Telegram UI.";
    const tasks = parseCliTasksFromBoardResponse(text, "gemini");
    expect(tasks.length).toBe(0); // No unsafe fallback execution
  });

  it("builds strategy prompt with Telegram/Instagram UI directives", () => {
    const orchestrator = new TwoTierOrchestrator();
    const prompt = orchestrator.buildBoardStrategyPrompt("Beauty Salon App");
    expect(prompt).toContain("G_PLUS_G_CLI_TASK_V1");
    expect(prompt).toContain("Beauty Salon App");
  });

  it("executes two-tier cycle step with simulated V1 board response", async () => {
    const bridge = new CliExecutorBridge();
    const orchestrator = new TwoTierOrchestrator(bridge);

    const simulatedBoardResponse = `
    Architecture plan ready.
    [[G_PLUS_G_CLI_TASK_V1]]
    ${JSON.stringify({ ...validV1TaskObj, executor: "codex" })}
    [[/G_PLUS_G_CLI_TASK_V1]]
    `;

    const result = await orchestrator.executeCycleStep("Beauty Salon", simulatedBoardResponse);
    expect(result.iterationsCompleted).toBe(1);
    expect(result.cliExecutionResults.length).toBe(1);
  });
});
