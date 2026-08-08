import { execFileSync } from "node:child_process";
import { CliExecutor, ExecutorCapabilities, ExecutorEvent, ExecutorHealth, ExecutorInput } from "../cli-executor-contract.js";
import { buildConstrainedExecutorPrompt } from "../executor-prompt.js";
import { executeSpawnedCli } from "../executor-process.js";

export class AntigravityCliExecutor implements CliExecutor {
  readonly id = "antigravity" as const;

  public capabilities(): ExecutorCapabilities {
    return {
      supportsStreaming: true,
      supportedRisks: ["READ_ONLY", "WORKSPACE_WRITE"],
      maxTimeoutMs: 60_000,
    };
  }

  public async healthCheck(): Promise<ExecutorHealth> {
    try {
      const out = execFileSync("antigravity", ["--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 3000,
        shell: false,
      });
      return { healthy: true, executorId: "antigravity", version: out.trim() };
    } catch {
      return { healthy: false, executorId: "antigravity", reason: "UNSUPPORTED: antigravity CLI binary not installed or available in PATH" };
    }
  }

  public async *execute(input: ExecutorInput, signal?: AbortSignal): AsyncIterable<ExecutorEvent> {
    const prompt = buildConstrainedExecutorPrompt(input.task);
    yield* executeSpawnedCli(
      "antigravity",
      ["exec", "--prompt", prompt],
      input,
      signal,
    );
  }
}
