import { describe, expect, it } from "vitest";
import {
  buildProductiveBoardPrompt,
  PRODUCTIVE_PROTOCOL_V1,
} from "../src/orchestrator/productive-protocol.js";
import {
  TurnValueGate,
  parseProtocolSections,
  computeTokenJaccardSimilarity,
} from "../src/orchestrator/turn-value-gate.js";

describe("Phase E: Productive Board Protocol & TurnValueGate", () => {
  it("should construct prompt with protocol v1, role overlay, project brief, and decision ledger", () => {
    const prompt = buildProductiveBoardPrompt({
      role: "ARCHITECT",
      projectBriefText: "Objective: Build Desktop App",
      decisionLedgerText: "Accepted: Use SQLite",
      userPrompt: "How to add CLI tasks?",
    });

    expect(prompt).toContain(PRODUCTIVE_PROTOCOL_V1);
    expect(prompt).toContain("ROLE OVERLAY: ARCHITECT");
    expect(prompt).toContain("PROJECT BRIEF (WORKING MEMORY):");
    expect(prompt).toContain("DECISION LEDGER (CLOSED DECISIONS):");
    expect(prompt).toContain("How to add CLI tasks?");
  });

  it("should parse structured protocol response sections correctly", () => {
    const responseText = `
DELTA
We added SQLite migration 6 for CLI tasks and memory items.

DECISION_UPDATE
Accepted decision to use TaskCompiler for response processing.

RISKS
Potential risk of path traversal in allowedPaths.

NEXT_ACTION
EXECUTE

CLI_TASKS
[[G_PLUS_G_CLI_TASK_V1]]
{"protocol": "gplusg.cli-task"}
[[/G_PLUS_G_CLI_TASK_V1]]

PUBLIC_SUMMARY
Added migration 6 and TaskCompiler.

DONE
NO
`;

    const parsed = parseProtocolSections(responseText);
    expect(parsed.delta).toContain("migration 6");
    expect(parsed.decisionUpdate).toContain("TaskCompiler");
    expect(parsed.risks).toContain("path traversal");
    expect(parsed.nextAction).toBe("EXECUTE");
    expect(parsed.hasCliTasks).toBe(true);
    expect(parsed.done).toBe(false);
  });

  it("should compute token Jaccard similarity accurately", () => {
    const textA = "We added SQLite migration 6 for CLI tasks and memory items.";
    const textB = "We added SQLite migration 6 for CLI tasks and memory items.";
    const textC = "Different completely unrelated content about UI theme styles.";

    expect(computeTokenJaccardSimilarity(textA, textB)).toBe(1.0);
    expect(computeTokenJaccardSimilarity(textA, textC)).toBeLessThan(0.2);
  });

  it("should evaluate valuable turns and track consecutive low-value turns", () => {
    const gate = new TurnValueGate(3);

    const val1 = gate.evaluateTurn(`
DELTA
Material new feature implementation for execution broker.

DECISION_UPDATE
NONE

RISKS
NONE

NEXT_ACTION
DISCUSS

PUBLIC_SUMMARY
Implemented execution broker.

DONE
NO
`);

    expect(val1.isValuable).toBe(true);

    const val2 = gate.evaluateTurn(`
DELTA
NONE

DECISION_UPDATE
NONE

RISKS
NONE

NEXT_ACTION
DISCUSS

PUBLIC_SUMMARY
No new progress.

DONE
NO
`);

    expect(val2.isValuable).toBe(false);
    expect(val2.consecutiveLowValueCount).toBe(1);
    expect(val2.shouldSendCorrectivePrompt).toBe(false);

    const val3 = gate.evaluateTurn(`
DELTA
NONE

DECISION_UPDATE
NONE

RISKS
NONE

NEXT_ACTION
DISCUSS

PUBLIC_SUMMARY
Still talking without material output.

DONE
NO
`);

    expect(val3.isValuable).toBe(false);
    expect(val3.consecutiveLowValueCount).toBe(2);
    expect(val3.shouldSendCorrectivePrompt).toBe(true);
    expect(val3.correctivePromptText).toContain("CORRECTIVE DIRECTIVE");

    const val4 = gate.evaluateTurn(`
DELTA
NONE

DECISION_UPDATE
NONE

RISKS
NONE

NEXT_ACTION
DISCUSS

PUBLIC_SUMMARY
3rd filler turn.

DONE
NO
`);

    expect(val4.isValuable).toBe(false);
    expect(val4.consecutiveLowValueCount).toBe(3);
    expect(val4.shouldStopRun).toBe(true);
  });
});
