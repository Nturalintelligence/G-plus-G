import { execFileSync } from "node:child_process";
import { CliExecutor, ExecutorCapabilities, ExecutorEvent, ExecutorHealth, ExecutorInput } from "../cli-executor-contract.js";
import { buildConstrainedExecutorPrompt } from "../executor-prompt.js";
import { executeSpawnedCli } from "../executor-process.js";

export class GeminiCliExecutor implements CliExecutor {
  readonly id = "gemini" as const;

  public capabilities(): ExecutorCapabilities {
    return {
      supportsStreaming: true,
      supportedRisks: ["READ_ONLY", "WORKSPACE_WRITE"],
      maxTimeoutMs: 120_000,
    };
  }

  public async healthCheck(): Promise<ExecutorHealth> {
    try {
      const out = execFileSync("gemini", ["--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 5000,
        shell: false,
      });
      return { healthy: true, executorId: "gemini", version: out.trim() };
    } catch {
      return { healthy: false, executorId: "gemini", reason: "gemini CLI binary not found in PATH or non-zero exit code" };
    }
  }

  public async *execute(input: ExecutorInput, signal?: AbortSignal): AsyncIterable<ExecutorEvent> {
    const prompt = buildConstrainedExecutorPrompt(input.task);
    yield* executeSpawnedCli(
      "gemini",
      ["--approval-mode", "auto_edit", "-p", prompt],
      input,
      signal,
    );
  }
}
