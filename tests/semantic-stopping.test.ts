import { describe, expect, it } from "vitest";
import { classifyTaskComplexity, discussionTurnBudget } from "../src/orchestrator/semantic-stopping.js";

describe("semantic stopping policy", () => {
  it("caps trivial prompts at one discussion turn per provider", () => {
    for (const task of ["тест", "оба тут?", "hello", "2+2?"]) {
      expect(classifyTaskComplexity(task, false)).toBe("TRIVIAL");
    }
    expect(discussionTurnBudget({ requestedTurns: 7, providerCount: 2, complexity: "TRIVIAL" })).toBe(2);
  });

  it("does not shorten tasks with files, implementation intent, or substantial text", () => {
    expect(classifyTaskComplexity("исправь обработку файлов и запусти тесты", false)).toBe("STANDARD");
    expect(classifyTaskComplexity("что на скриншоте?", true)).toBe("STANDARD");
    expect(discussionTurnBudget({ requestedTurns: 7, providerCount: 2, complexity: "STANDARD" })).toBe(7);
  });
});
