import { describe, expect, it } from "vitest";
import { executeTerminalCommand } from "../src/terminal/terminal-engine.js";

describe("Terminal Execution Engine", () => {
  it("executes echo command successfully", async () => {
    const result = await executeTerminalCommand({ command: "echo Antigravity Test" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Antigravity Test");
  });

  it("handles non-zero exit codes gracefully", async () => {
    const result = await executeTerminalCommand({ command: "exit 1" });
    expect(result.exitCode).toBe(1);
  });
});
