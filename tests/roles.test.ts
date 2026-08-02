import { describe, expect, it } from "vitest";
import { assignRoles, evaluateDiscrepancy } from "../src/orchestrator/roles.js";

describe("Roles & Judge Evaluator (pre.14)", () => {
  it("assigns PROPOSER and REVIEWER roles correctly", () => {
    const roles = assignRoles(["chatgpt", "gemini"], "chatgpt");
    expect(roles).toEqual([
      { providerId: "chatgpt", role: "PROPOSER" },
      { providerId: "gemini", role: "REVIEWER" },
    ]);
  });

  it("detects discrepancies in review responses", () => {
    const agreeResult = evaluateDiscrepancy("Предложение", "Полностью согласен с предложенным кодом");
    expect(agreeResult.hasDiscrepancy).toBe(false);

    const disagreeResult = evaluateDiscrepancy("Предложение", "Тут есть ошибка в логике");
    expect(disagreeResult.hasDiscrepancy).toBe(true);
  });
});
