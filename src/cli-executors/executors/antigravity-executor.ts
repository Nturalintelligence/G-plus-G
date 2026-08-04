import { spawn, execSync } from "node:child_process";
import { CliExecutor, ExecutorCapabilities, ExecutorEvent, ExecutorHealth, ExecutorInput } from "../cli-executor-contract.js";
import { killProcessTreeWindows, sanitizeEnv } from "../execution-broker.js";

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
      const out = execSync("antigravity --version", { encoding: "utf-8", windowsHide: true, timeout: 3000 });
      return { healthy: true, executorId: "antigravity", version: out.trim() };
    } catch {
      return { healthy: false, executorId: "antigravity", reason: "UNSUPPORTED: antigravity CLI binary not installed or available in PATH" };
    }
  }

  public async *execute(input: ExecutorInput, signal?: AbortSignal): AsyncIterable<ExecutorEvent> {
    const atNow = () => new Date().toISOString();
    yield { type: "STARTED", at: atNow(), attemptId: input.attemptId };

    const health = await this.healthCheck();
    if (!health.healthy) {
      yield { type: "FAILED", at: atNow(), code: health.reason || "UNSUPPORTED" };
      return;
    }

    const promptText = `TASK: ${input.task.title}\nOBJECTIVE: ${input.task.objective}`;
    const executable = "antigravity";
    const args = ["exec", "--prompt", promptText];

    let childProcess;
    try {
      childProcess = spawn(executable, args, {
        cwd: input.workspaceRoot,
        shell: false,
        windowsHide: true,
        env: sanitizeEnv(),
      });
    } catch (err: any) {
      yield { type: "FAILED", at: atNow(), code: `SPAWN_ERROR: ${err?.message || String(err)}` };
      return;
    }

    if (signal) {
      signal.addEventListener("abort", () => {
        if (childProcess.pid) {
          killProcessTreeWindows(childProcess.pid);
        }
      });
    }

    const eventQueue: ExecutorEvent[] = [];
    let isFinished = false;
    let finishCode: number | null = null;

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      eventQueue.push({ type: "STDOUT", at: atNow(), chunk: chunk.toString("utf-8") });
    });

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      eventQueue.push({ type: "STDERR", at: atNow(), chunk: chunk.toString("utf-8") });
    });

    childProcess.on("close", (code: number | null) => {
      finishCode = code;
      isFinished = true;
    });

    while (!isFinished || eventQueue.length > 0) {
      if (signal?.aborted) {
        yield { type: "CANCELLED", at: atNow() };
        return;
      }
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }
      if (!isFinished) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    yield { type: "PROCESS_EXITED", at: atNow(), exitCode: finishCode };
  }
}
