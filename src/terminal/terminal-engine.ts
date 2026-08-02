import { spawn } from "node:child_process";

export interface TerminalExecutionRequest {
  command: string;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface TerminalExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export async function executeTerminalCommand(
  request: TerminalExecutionRequest,
): Promise<TerminalExecutionResult> {
  const startTime = Date.now();
  const cwd = request.cwd || process.cwd();
  const timeoutMs = request.timeoutMs || 60_000;

  return new Promise<TerminalExecutionResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let isSettled = false;

    const child = spawn("cmd.exe", ["/c", request.command], {
      cwd,
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        child.kill();
        resolve({
          exitCode: 124,
          stdout,
          stderr: stderr + "\n[Error: Command timed out]",
          elapsedMs: Date.now() - startTime,
        });
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + `\n[Process Error: ${err.message}]`,
          elapsedMs: Date.now() - startTime,
        });
      }
    });

    child.on("close", (code) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
          elapsedMs: Date.now() - startTime,
        });
      }
    });
  });
}
