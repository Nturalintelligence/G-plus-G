import { describe, expect, it } from "vitest";
import { CliExecutorBridge } from "../src/cli-executors/cli-executor-bridge.js";

describe("CLI Executor Bridge", () => {
  const bridge = new CliExecutorBridge();

  it("builds correct command string for gemini CLI", () => {
    const cmd = bridge.buildCliCommand("gemini", "Write a button component");
    expect(cmd).toBe('gemini -y -p "Write a button component"');
  });

  it("builds correct command string for codex CLI", () => {
    const cmd = bridge.buildCliCommand("codex", "Fix lint error");
    expect(cmd).toBe('codex exec -a never "Fix lint error"');
  });

  it("builds custom command string", () => {
    const cmd = bridge.buildCliCommand("custom", "echo test", "node -v");
    expect(cmd).toBe("node -v");
  });

  it("executes custom CLI command and receives output", async () => {
    const result = await bridge.executeCliTask({
      tool: "custom",
      prompt: "test",
      customCommand: "echo CLI Bridge Test",
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain("CLI Bridge Test");
    expect(result.tool).toBe("custom");
  });
});
