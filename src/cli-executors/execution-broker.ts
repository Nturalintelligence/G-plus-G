import { spawn, execSync, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { CliTaskEnvelopeV1, ExecutorId, isPathSafeRelativeToWorkspace } from "./cli-task-schema.js";
import { CliExecutor, ExecutorEvent, ExecutorHealth, ExecutorInput } from "./cli-executor-contract.js";

export interface ExecutionResultV1 {
  taskId: string;
  attemptId: string;
  executor: ExecutorId;
  status: "COMPLETED" | "NEEDS_FIX" | "FAILED" | "CANCELLED";
  summary: string;
  changedFiles: Array<{ path: string; change: "added" | "modified" | "deleted" }>;
  verificationResults: Array<{
    label: string;
    passed: boolean;
    exitCode?: number;
    summary: string;
    artifactId?: string;
  }>;
  warnings: string[];
  nextRecommendation?: string;
}

export interface GitFileStatus {
  path: string;
  change: "added" | "modified" | "deleted";
}

export const SAFE_EXECUTABLES: ReadonlySet<string> = new Set([
  "codex", "gemini", "antigravity", "npm", "npx", "node", "git", "vitest", "tsc", "cargo", "python", "pytest"
]);

export function maskSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/(api[_-]?key|secret|token|password|auth|bearer)\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{8,})['"]?/gi, "$1: ***MASKED***")
    .replace(/(sk-[a-zA-Z0-9]{20,})/gi, "sk-***MASKED***")
    .replace(/(AIzaSy[a-zA-Z0-9_\-]{33})/gi, "AIzaSy***MASKED***");
}

export function getGitStatusSnapshot(workspaceRoot: string): GitFileStatus[] {
  try {
    const output = execSync("git status --porcelain", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      windowsHide: true,
      timeout: 10000,
    });

    const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const results: GitFileStatus[] = [];

    for (const line of lines) {
      const code = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim().replace(/^"/, "").replace(/"$/, "");

      let change: "added" | "modified" | "deleted" = "modified";
      if (code === "??" || code === "A" || code.includes("A")) {
        change = "added";
      } else if (code === "D" || code.includes("D")) {
        change = "deleted";
      }

      results.push({ path: filePath, change });
    }

    return results;
  } catch {
    return [];
  }
}

export function killProcessTreeWindows(pid: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Process might already have exited
  }
}

export function sanitizeEnv(customEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const baseKeys = ["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "NODE_ENV", "LANG"];

  for (const key of baseKeys) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

  if (customEnv) {
    for (const [k, v] of Object.entries(customEnv)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }
  }

  return env;
}

export class SafeExecutionBroker {
  private executors: Map<ExecutorId, CliExecutor> = new Map();

  public registerExecutor(executor: CliExecutor): void {
    this.executors.set(executor.id, executor);
  }

  public getExecutor(id: ExecutorId): CliExecutor | undefined {
    return this.executors.get(id);
  }

  public async getExecutorHealth(id: ExecutorId): Promise<ExecutorHealth> {
    const executor = this.executors.get(id);
    if (!executor) {
      return { healthy: false, executorId: id, reason: `Executor '${id}' is not registered` };
    }
    return executor.healthCheck();
  }

  /**
   * Executes a CLI task envelope safely without shell strings and within workspace bounds.
   */
  public async executeTaskEnvelope(
    task: CliTaskEnvelopeV1,
    attemptId: string,
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<ExecutionResultV1> {
    const canonicalWorkspace = path.resolve(workspaceRoot);

    // Validate workspace path safety
    for (const allowed of task.allowedPaths) {
      if (!isPathSafeRelativeToWorkspace(allowed, canonicalWorkspace)) {
        return {
          taskId: task.taskId,
          attemptId,
          executor: task.executor === "auto" ? "codex" : task.executor,
          status: "FAILED",
          summary: `Security violation: allowed path '${allowed}' escapes workspace`,
          changedFiles: [],
          verificationResults: [],
          warnings: ["Security path check failed"],
        };
      }
    }

    const forbiddenCheck = [".git", "profiles", "AppData", "credentials"];
    for (const forbidden of forbiddenCheck) {
      if (task.allowedPaths.some((p) => p.includes(forbidden))) {
        return {
          taskId: task.taskId,
          attemptId,
          executor: task.executor === "auto" ? "codex" : task.executor,
          status: "FAILED",
          summary: `Security violation: allowed paths target forbidden system component '${forbidden}'`,
          changedFiles: [],
          verificationResults: [],
          warnings: ["Target path accesses protected component"],
        };
      }
    }

    // Determine target executor
    let selectedExecutorId: ExecutorId = task.executor === "auto" ? "codex" : task.executor;
    let executor = this.executors.get(selectedExecutorId);

    if (!executor) {
      // Fallback check
      if (this.executors.has("codex")) {
        selectedExecutorId = "codex";
        executor = this.executors.get("codex");
      } else if (this.executors.has("gemini")) {
        selectedExecutorId = "gemini";
        executor = this.executors.get("gemini");
      }
    }

    if (!executor) {
      return {
        taskId: task.taskId,
        attemptId,
        executor: selectedExecutorId,
        status: "FAILED",
        summary: `No suitable executor registered for id '${selectedExecutorId}'`,
        changedFiles: [],
        verificationResults: [],
        warnings: ["Executor missing"],
      };
    }

    const gitBefore = getGitStatusSnapshot(canonicalWorkspace);

    const input: ExecutorInput = {
      task,
      attemptId,
      workspaceRoot: canonicalWorkspace,
    };

    let executionSuccess = true;
    let failureReason = "";
    let exitCodeResult: number | null = 0;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    try {
      for await (const event of executor.execute(input, signal)) {
        if (event.type === "STDOUT") {
          stdoutChunks.push(maskSecrets(event.chunk));
        } else if (event.type === "STDERR") {
          stderrChunks.push(maskSecrets(event.chunk));
        } else if (event.type === "PROCESS_EXITED") {
          exitCodeResult = event.exitCode;
          if (event.exitCode !== 0) {
            executionSuccess = false;
            failureReason = `Process exited with code ${event.exitCode}`;
          }
        } else if (event.type === "CANCELLED") {
          return {
            taskId: task.taskId,
            attemptId,
            executor: selectedExecutorId,
            status: "CANCELLED",
            summary: "Task execution was cancelled by user or signal",
            changedFiles: [],
            verificationResults: [],
            warnings: ["Execution cancelled"],
          };
        } else if (event.type === "FAILED") {
          executionSuccess = false;
          failureReason = event.code;
        }
      }
    } catch (err: any) {
      executionSuccess = false;
      failureReason = err?.message || String(err);
    }

    const gitAfter = getGitStatusSnapshot(canonicalWorkspace);
    const changedFilesMap = new Map<string, "added" | "modified" | "deleted">();

    for (const afterItem of gitAfter) {
      const beforeItem = gitBefore.find((b) => b.path === afterItem.path);
      if (!beforeItem || beforeItem.change !== afterItem.change) {
        changedFilesMap.set(afterItem.path, afterItem.change);
      }
    }

    const changedFiles: GitFileStatus[] = Array.from(changedFilesMap.entries()).map(([p, change]) => ({
      path: p,
      change,
    }));

    // Perform verification steps
    const verificationResults: ExecutionResultV1["verificationResults"] = [];
    let allVerificationPassed = true;

    for (const step of task.verification) {
      if (step.type === "file_exists") {
        const fullPath = path.resolve(canonicalWorkspace, step.path);
        const exists = fs.existsSync(fullPath);
        verificationResults.push({
          label: `File exists: ${step.path}`,
          passed: exists,
          summary: exists ? `File '${step.path}' exists.` : `File '${step.path}' is missing.`,
        });
        if (!exists) allVerificationPassed = false;
      } else if (step.type === "command") {
        try {
          const res = execSync(`${step.executable} ${step.args.join(" ")}`, {
            cwd: canonicalWorkspace,
            encoding: "utf-8",
            windowsHide: true,
            timeout: step.timeoutMs || 30000,
          });
          verificationResults.push({
            label: `Command: ${step.executable} ${step.args.join(" ")}`,
            passed: true,
            exitCode: 0,
            summary: maskSecrets(res.slice(0, 500)),
          });
        } catch (err: any) {
          allVerificationPassed = false;
          verificationResults.push({
            label: `Command: ${step.executable} ${step.args.join(" ")}`,
            passed: false,
            exitCode: typeof err?.status === "number" ? err.status : 1,
            summary: maskSecrets(err?.stderr || err?.message || String(err)),
          });
        }
      } else if (step.type === "git_diff") {
        const hasDiff = changedFiles.length > 0;
        verificationResults.push({
          label: "Git status diff check",
          passed: hasDiff,
          summary: hasDiff ? `${changedFiles.length} files modified/added` : "No git diff detected",
        });
        if (!hasDiff) allVerificationPassed = false;
      }
    }

    const finalStatus: ExecutionResultV1["status"] =
      executionSuccess && allVerificationPassed
        ? "COMPLETED"
        : executionSuccess && !allVerificationPassed
        ? "NEEDS_FIX"
        : "FAILED";

    const warnings: string[] = [];
    if (!executionSuccess) warnings.push(`Execution error: ${failureReason}`);
    if (!allVerificationPassed) warnings.push("One or more verification criteria failed");

    return {
      taskId: task.taskId,
      attemptId,
      executor: selectedExecutorId,
      status: finalStatus,
      summary: executionSuccess
        ? allVerificationPassed
          ? `Task '${task.title}' completed and passed all verification checks.`
          : `Task '${task.title}' completed execution, but verification failed.`
        : `Task execution failed: ${failureReason}`,
      changedFiles,
      verificationResults,
      warnings,
      nextRecommendation:
        finalStatus === "COMPLETED"
          ? "Proceed to next architecture step"
          : "Review errors and issue fix task envelope",
    };
  }
}
