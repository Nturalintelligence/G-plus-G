import { describe, expect, it } from "vitest";
import { ContextBudgeter } from "../src/context/context-budgeter.js";
import { DecisionLedger } from "../src/context/decision-ledger.js";
import { buildCanonicalSummary } from "../src/context/canonical-summary.js";

describe("Context Manager (pre.13)", () => {
  it("detects context overflow via ContextBudgeter", () => {
    const budgeter = new ContextBudgeter({ maxCharacters: 100, warnCharactersThreshold: 50 });
    const smallHistory = [{ content: "Hello world" }];
    const largeHistory = [{ content: "a".repeat(120) }];

    expect(budgeter.isOverflow(smallHistory)).toBe(false);
    expect(budgeter.isOverflow(largeHistory)).toBe(true);
  });

  it("builds and maintains Decision Ledger items", () => {
    const ledger = new DecisionLedger();
    ledger.addItem({
      category: "decision",
      title: "База данных",
      description: "Использовать SQLite в режиме WAL",
    });

    const summary = ledger.buildLedgerSummaryPrompt();
    expect(summary).toContain("DECISION LEDGER");
    expect(summary).toContain("База данных");
  });

  it("generates a valid Canonical Summary", () => {
    const summary = buildCanonicalSummary("proj_1", [
      { role: "USER", content: "Создать сайт" },
      { role: "ASSISTANT", content: "Готово" },
    ]);
    expect(summary.projectId).toBe("proj_1");
    expect(summary.turnCount).toBe(2);
  });
});
