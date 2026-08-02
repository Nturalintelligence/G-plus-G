import { describe, expect, it } from "vitest";
import { parseCliTasksFromBoardResponse, TwoTierOrchestrator } from "../src/orchestrator/two-tier-orchestrator.js";
import { CliExecutorBridge } from "../src/cli-executors/cli-executor-bridge.js";

describe("Two-Tier Orchestrator", () => {
  it("parses CLI tasks correctly from board response with JSON tags", () => {
    const text = `
Here is our architectural plan.
[[G_PLUS_G_CLI_TASK:{"tool":"gemini","task":"Build UI theme"}]]
[[G_PLUS_G_CLI_TASK:{"tool":"codex","task":"Run tests"}]]
    `;

    const tasks = parseCliTasksFromBoardResponse(text, "gemini");
    expect(tasks.length).toBe(2);
    expect(tasks[0]?.tool).toBe("gemini");
    expect(tasks[0]?.task).toBe("Build UI theme");
    expect(tasks[1]?.tool).toBe("codex");
    expect(tasks[1]?.task).toBe("Run tests");
  });

  it("handles fallback when no CLI tags exist", () => {
    const text = "Plan: Build beauty salon app with Telegram UI.";
    const tasks = parseCliTasksFromBoardResponse(text, "gemini");
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.tool).toBe("gemini");
    expect(tasks[0]?.task).toContain("Execute commercial implementation");
  });

  it("builds strategy prompt with Telegram/Instagram UI directives", () => {
    const orchestrator = new TwoTierOrchestrator();
    const prompt = orchestrator.buildBoardStrategyPrompt("Beauty Salon App");
    expect(prompt).toContain("PREMIUM COMMERCIAL GRADE");
    expect(prompt).toContain("Telegram / Instagram level UI aesthetics");
    expect(prompt).toContain("Beauty Salon App");
  });

  it("executes two-tier cycle step with simulated board response", async () => {
    const bridge = new CliExecutorBridge();
    const orchestrator = new TwoTierOrchestrator(bridge);

    const simulatedBoardResponse = `
    Architecture plan ready.
    [[G_PLUS_G_CLI_TASK:{"tool":"custom","task":"echo Test Execution"}]]
    `;

    const result = await orchestrator.executeCycleStep("Beauty Salon", simulatedBoardResponse);
    expect(result.iterationsCompleted).toBe(1);
    expect(result.cliExecutionResults.length).toBe(1);
    expect(result.cliExecutionResults[0]?.success).toBe(true);
    expect(result.finalBoardReport).toContain("TACTICAL CLI EXECUTION & QA REPORT");
  });
});
