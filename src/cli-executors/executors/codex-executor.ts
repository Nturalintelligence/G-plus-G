import { execFileSync } from "node:child_process";
import { CliExecutor, ExecutorCapabilities, ExecutorEvent, ExecutorHealth, ExecutorInput } from "../cli-executor-contract.js";
import { buildConstrainedExecutorPrompt } from "../executor-prompt.js";
import { executeSpawnedCli } from "../executor-process.js";

export class CodexCliExecutor implements CliExecutor {
  readonly id = "codex" as const;

  public capabilities(): ExecutorCapabilities {
    return {
      supportsStreaming: true,
      supportedRisks: ["READ_ONLY", "WORKSPACE_WRITE", "COMMAND_EXECUTION"],
      maxTimeoutMs: 120_000,
    };
  }

  public async healthCheck(): Promise<ExecutorHealth> {
    try {
      const out = execFileSync("codex", ["--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 5000,
        shell: false,
      });
      return { healthy: true, executorId: "codex", version: out.trim() };
    } catch {
      return { healthy: false, executorId: "codex", reason: "codex CLI binary not found in PATH or non-zero exit code" };
    }
  }

  public async *execute(input: ExecutorInput, signal?: AbortSignal): AsyncIterable<ExecutorEvent> {
    const prompt = buildConstrainedExecutorPrompt(input.task);
    yield* executeSpawnedCli(
      "codex",
      ["exec", "--sandbox", "workspace-write", "--ask-for-approval", "never", prompt],
      input,
      signal,
    );
  }
}
