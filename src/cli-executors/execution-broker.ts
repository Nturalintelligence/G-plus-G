import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  CliTaskEnvelopeV1,
  ExecutorId,
  PROTECTED_WORKSPACE_SEGMENTS,
  isAllowedVerificationCommand,
  isPathSafeRelativeToWorkspace,
  isProtectedWorkspacePath,
} from "./cli-task-schema.js";
import { CliExecutor, ExecutorHealth, ExecutorInput } from "./cli-executor-contract.js";

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
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
  objectiveEvidenceObserved?: boolean;
  security?: {
    hostProcessSandboxed: false;
    enforcement: "preflight-and-postflight-audit";
  };
}

export interface GitFileStatus {
  path: string;
  change: "added" | "modified" | "deleted";
}

export type ExecutorRequestResolution =
  | { status: "AVAILABLE"; executorId: ExecutorId; version?: string }
  | { status: "USER_DECISION_REQUIRED"; requestedExecutor: ExecutorId; reason: string; alternatives: ExecutorId[] };

const MAX_CAPTURED_OUTPUT_CHARS = 16 * 1024;
const HEALTH_CHECK_TIMEOUT_MS = 6_000;
const PROTECTED_TREE_ENTRY_LIMIT = 4_096;
const HOST_PROCESS_WARNING = "Executor runs as the host user; path controls are audited before and after execution, not an OS sandbox.";

export function maskSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[PRIVATE KEY MASKED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer ***MASKED***")
    .replace(/(api[_-]?key|secret|token|password|auth(?:orization)?|cookie|session)\s*[:=]\s*['"]?([^\s'",;]{8,})['"]?/gi, "$1: ***MASKED***")
    .replace(/(sk-[a-zA-Z0-9]{20,})/gi, "sk-***MASKED***")
    .replace(/(AIzaSy[a-zA-Z0-9_\-]{33})/gi, "AIzaSy***MASKED***")
    .replace(/\bgh[opsu]_[a-zA-Z0-9_]{20,}\b/g, "gh_***MASKED***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***MASKED***");
}

function appendBoundedOutput(
  current: string,
  chunk: string,
): { value: string; truncated: boolean } {
  if (current.length >= MAX_CAPTURED_OUTPUT_CHARS) {
    return { value: current, truncated: chunk.length > 0 };
  }
  const remaining = MAX_CAPTURED_OUTPUT_CHARS - current.length;
  return {
    value: current + chunk.slice(0, remaining),
    truncated: chunk.length > remaining,
  };
}

export function getGitStatusSnapshot(workspaceRoot: string): GitFileStatus[] {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
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
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
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

function fileAssertionFingerprint(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) return "SYMLINK";
  if (stat.isDirectory()) return `DIRECTORY:${stat.mtimeMs}`;
  if (!stat.isFile()) return `SPECIAL:${stat.mode}`;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsWithinScope(filePath: string, scope: string): boolean {
  const file = normalizeRelativePath(filePath);
  const root = normalizeRelativePath(scope);
  return file === root || file.startsWith(`${root}/`);
}

function snapshotWorkspace(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (directory: string, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!relativeDirectory && PROTECTED_WORKSPACE_SEGMENTS.has(entry.name.toLowerCase())) continue;
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        snapshot.set(relative, "SYMLINK");
      } else if (stat.isDirectory()) {
        visit(fullPath, relative);
      } else if (stat.isFile()) {
        snapshot.set(relative, createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex"));
      } else {
        snapshot.set(relative, `SPECIAL:${stat.mode}`);
      }
      if (snapshot.size > 20_000) throw new Error("Workspace snapshot file limit exceeded");
    }
  };
  visit(root);
  return snapshot;
}

function fingerprintProtectedTree(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  const hash = createHash("sha256");
  let entries = 0;

  const visit = (current: string, relative = "") => {
    if (entries >= PROTECTED_TREE_ENTRY_LIMIT) return;
    const stat = fs.lstatSync(current);
    entries += 1;
    hash.update(`${relative}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0`);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    const children = fs.readdirSync(current).sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      if (entries >= PROTECTED_TREE_ENTRY_LIMIT) break;
      visit(path.join(current, child), relative ? `${relative}/${child}` : child);
    }
  };

  visit(root);
  hash.update(entries >= PROTECTED_TREE_ENTRY_LIMIT ? "TRUNCATED" : "COMPLETE");
  return hash.digest("hex");
}

function snapshotProtectedRoots(workspaceRoot: string): Map<string, string | null> {
  const rootEntries = fs.readdirSync(workspaceRoot).sort((left, right) => left.localeCompare(right));
  return new Map(
    Array.from(PROTECTED_WORKSPACE_SEGMENTS, (segment) => {
      const matchingEntries = rootEntries.filter((entry) => entry.toLowerCase() === segment);
      if (matchingEntries.length === 0) return [segment, null] as const;
      const hash = createHash("sha256");
      for (const entry of matchingEntries) {
        hash.update(entry);
        hash.update(fingerprintProtectedTree(path.join(workspaceRoot, entry)) || "MISSING");
      }
      return [segment, hash.digest("hex")] as const;
    }),
  );
}

function protectedRootChanges(
  before: Map<string, string | null>,
  after: Map<string, string | null>,
): GitFileStatus[] {
  const changes: GitFileStatus[] = [];
  for (const segment of PROTECTED_WORKSPACE_SEGMENTS) {
    const beforeHash = before.get(segment) ?? null;
    const afterHash = after.get(segment) ?? null;
    if (beforeHash === afterHash) continue;
    changes.push({
      path: segment,
      change: beforeHash === null ? "added" : afterHash === null ? "deleted" : "modified",
    });
  }
  return changes;
}

async function withPromiseTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SafeExecutionBroker {
  private executors: Map<ExecutorId, CliExecutor> = new Map();

  public registerExecutor(executor: CliExecutor): void {
    this.executors.set(executor.id, executor);
  }

  public getExecutor(id: ExecutorId): CliExecutor | undefined {
    return this.executors.get(id);
  }

  public listExecutors(): CliExecutor[] {
    return Array.from(this.executors.values());
  }

  public async getExecutorHealth(id: ExecutorId): Promise<ExecutorHealth> {
    const executor = this.executors.get(id);
    if (!executor) {
      return { healthy: false, executorId: id, reason: `Executor '${id}' is not registered` };
    }
    try {
      return await withPromiseTimeout(executor.healthCheck(), HEALTH_CHECK_TIMEOUT_MS, `${id} health check`);
    } catch (error: any) {
      return {
        healthy: false,
        executorId: id,
        reason: maskSecrets(error?.message || String(error)),
      };
    }
  }

  /** Resolves only the explicitly requested executor and never substitutes another provider. */
  public async resolveRequestedExecutor(id: ExecutorId, risk: CliTaskEnvelopeV1["risk"]): Promise<ExecutorRequestResolution> {
    const executor = this.executors.get(id);
    let reason = `Executor '${id}' is not registered`;
    if (executor) {
      if (!executor.capabilities().supportedRisks.includes(risk)) reason = `Executor '${id}' does not support risk '${risk}'`;
      else {
        const health = await this.getExecutorHealth(id);
        if (health.healthy) return { status: "AVAILABLE", executorId: id, ...(health.version ? { version: health.version } : {}) };
        reason = `Executor '${id}' is unhealthy: ${health.reason || "unknown reason"}`;
      }
    }
    const alternatives: ExecutorId[] = [];
    for (const candidate of this.executors.values()) {
      if (candidate.id === id || !candidate.capabilities().supportedRisks.includes(risk)) continue;
      if ((await this.getExecutorHealth(candidate.id)).healthy) alternatives.push(candidate.id);
    }
    return { status: "USER_DECISION_REQUIRED", requestedExecutor: id, reason, alternatives };
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
    const requestedExecutor: ExecutorId = task.executor === "auto" ? "codex" : task.executor;
    const security = {
      hostProcessSandboxed: false as const,
      enforcement: "preflight-and-postflight-audit" as const,
    };
    const earlyResult = (
      status: ExecutionResultV1["status"],
      summary: string,
      warnings: string[],
      executor: ExecutorId = requestedExecutor,
    ): ExecutionResultV1 => ({
      taskId: task.taskId,
      attemptId,
      executor,
      status,
      summary,
      changedFiles: [],
      verificationResults: [],
      warnings: [HOST_PROCESS_WARNING, ...warnings],
      stdout: "",
      stderr: "",
      outputTruncated: false,
      objectiveEvidenceObserved: false,
      security,
    });

    if (signal?.aborted) {
      return earlyResult("CANCELLED", "Task execution was cancelled before launch", ["Execution cancelled"]);
    }

    const requestedWorkspace = path.resolve(workspaceRoot);
    if (
      !fs.existsSync(requestedWorkspace) ||
      !fs.lstatSync(requestedWorkspace).isDirectory() ||
      fs.lstatSync(requestedWorkspace).isSymbolicLink()
    ) {
      return earlyResult("FAILED", "Workspace root must be an existing non-symlink directory", ["Workspace preflight failed"]);
    }
    const canonicalWorkspace = fs.realpathSync(requestedWorkspace);

    const verificationPaths = task.verification.flatMap((step) =>
      step.type === "file_exists" ? [step.path] : step.type === "git_diff" ? step.allowedPaths : [],
    );
    const scopedPaths = [...task.allowedPaths, ...verificationPaths];
    for (const scopedPath of scopedPaths) {
      if (!isPathSafeRelativeToWorkspace(scopedPath, canonicalWorkspace)) {
        return earlyResult("FAILED", `Security violation: path '${scopedPath}' escapes workspace or crosses a link`, ["Security path check failed"]);
      }
      if (isProtectedWorkspacePath(scopedPath)) {
        return earlyResult("FAILED", `Security violation: path '${scopedPath}' targets a protected workspace component`, ["Protected path rejected"]);
      }
    }
    const candidateIds: ExecutorId[] = task.executor === "auto"
      ? ["codex", "gemini", "antigravity"]
      : [task.executor];
    let selectedExecutorId: ExecutorId = requestedExecutor;
    let executor: CliExecutor | undefined;
    let selectionFailure = "No suitable executor is registered";
    for (const candidateId of candidateIds) {
      const candidate = this.executors.get(candidateId);
      if (!candidate) {
        selectionFailure = `Executor '${candidateId}' is not registered`;
        continue;
      }
      const capabilities = candidate.capabilities();
      if (!capabilities.supportedRisks.includes(task.risk)) {
        selectionFailure = `Executor '${candidateId}' does not support risk '${task.risk}'`;
        continue;
      }
      const health = await this.getExecutorHealth(candidateId);
      if (!health.healthy) {
        selectionFailure = `Executor '${candidateId}' is unhealthy: ${health.reason || "unknown reason"}`;
        continue;
      }
      selectedExecutorId = candidateId;
      executor = candidate;
      break;
    }
    if (!executor) {
      return earlyResult("FAILED", task.executor === "auto" ? selectionFailure : `USER_DECISION_REQUIRED: ${selectionFailure}`, ["Executor unavailable or incompatible; provider substitution was not performed"]);
    }

    const capabilities = executor.capabilities();
    if (!Number.isFinite(capabilities.maxTimeoutMs) || capabilities.maxTimeoutMs <= 0) {
      return earlyResult("FAILED", `Executor '${selectedExecutorId}' advertises an invalid runtime timeout`, ["Invalid executor capabilities"], selectedExecutorId);
    }

    const workspaceBefore = snapshotWorkspace(canonicalWorkspace);
    const protectedBefore = snapshotProtectedRoots(canonicalWorkspace);
    const fileAssertionsBefore = new Map<string, string | null>();
    for (const step of task.verification) {
      if (step.type === "file_exists") {
        fileAssertionsBefore.set(step.path, fileAssertionFingerprint(path.resolve(canonicalWorkspace, step.path)));
      }
    }

    const input: ExecutorInput = { task, attemptId, workspaceRoot: canonicalWorkspace };
    const controller = new AbortController();
    let cancelledByCaller = false;
    let cancelledByExecutor = false;
    let timedOut = false;
    let executionSuccess = true;
    let failureReason = "";
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    const forwardAbort = () => {
      cancelledByCaller = true;
      controller.abort();
    };
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, capabilities.maxTimeoutMs);

    const abortMarker = Symbol("executor-aborted");
    const abortPromise = controller.signal.aborted
      ? Promise.resolve(abortMarker)
      : new Promise<typeof abortMarker>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(abortMarker), { once: true });
        });
    const iterator = executor.execute(input, controller.signal)[Symbol.asyncIterator]();

    try {
      while (true) {
        const item = await Promise.race([iterator.next(), abortPromise]);
        if (item === abortMarker) break;
        if (item.done) break;
        const event = item.value;
        if (event.type === "STDOUT" || event.type === "STDERR") {
          const bounded = appendBoundedOutput(
            event.type === "STDOUT" ? stdout : stderr,
            maskSecrets(event.chunk),
          );
          if (event.type === "STDOUT") stdout = bounded.value;
          else stderr = bounded.value;
          outputTruncated ||= bounded.truncated;
        } else if (event.type === "PROCESS_EXITED" && event.exitCode !== 0) {
          executionSuccess = false;
          failureReason = `Process exited with code ${event.exitCode}`;
        } else if (event.type === "CANCELLED") {
          cancelledByExecutor = true;
          break;
        } else if (event.type === "FAILED") {
          executionSuccess = false;
          failureReason = maskSecrets(event.code);
        }
      }
    } catch (error: any) {
      executionSuccess = false;
      failureReason = maskSecrets(error?.message || String(error));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
      if (controller.signal.aborted || cancelledByExecutor) {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      }
    }

    if (timedOut) {
      executionSuccess = false;
      failureReason = `Executor exceeded its ${capabilities.maxTimeoutMs} ms runtime limit`;
    }

    const workspaceAfter = snapshotWorkspace(canonicalWorkspace);
    const protectedAfter = snapshotProtectedRoots(canonicalWorkspace);
    const changedFilesMap = new Map<string, "added" | "modified" | "deleted">();
    for (const [filePath, hash] of workspaceAfter) {
      const beforeHash = workspaceBefore.get(filePath);
      if (beforeHash === undefined) changedFilesMap.set(filePath, "added");
      else if (beforeHash !== hash) changedFilesMap.set(filePath, "modified");
    }
    for (const filePath of workspaceBefore.keys()) {
      if (!workspaceAfter.has(filePath)) changedFilesMap.set(filePath, "deleted");
    }
    for (const change of protectedRootChanges(protectedBefore, protectedAfter)) {
      changedFilesMap.set(change.path, change.change);
    }
    const changedFiles: GitFileStatus[] = Array.from(changedFilesMap, ([changedPath, change]) => ({
      path: changedPath,
      change,
    }));

    const unsafePostflightPath = scopedPaths.find((scopedPath) =>
      !isPathSafeRelativeToWorkspace(scopedPath, canonicalWorkspace) || isProtectedWorkspacePath(scopedPath),
    );
    if (unsafePostflightPath) {
      executionSuccess = false;
      failureReason = `Postflight security violation at '${unsafePostflightPath}'`;
    }
    const unexpectedChanges = changedFiles.filter(({ path: changedPath }) =>
      isProtectedWorkspacePath(changedPath) ||
      !task.allowedPaths.some((allowed) => pathIsWithinScope(changedPath, allowed)) ||
      task.forbiddenPaths.some((forbidden) => pathIsWithinScope(changedPath, forbidden)),
    );
    if (unexpectedChanges.length > 0) {
      executionSuccess = false;
      failureReason = `Executor changed paths outside the approved scope: ${unexpectedChanges.map((item) => item.path).join(", ")}`;
    }

    const verificationResults: ExecutionResultV1["verificationResults"] = [];
    let allVerificationPassed = executionSuccess && !timedOut && !cancelledByCaller && !cancelledByExecutor;
    if (allVerificationPassed) {
      for (const step of task.verification) {
        if (step.type === "file_exists") {
          const fullPath = path.resolve(canonicalWorkspace, step.path);
          const afterFingerprint = fileAssertionFingerprint(fullPath);
          const beforeFingerprint = fileAssertionsBefore.get(step.path) ?? null;
          const exists = afterFingerprint !== null;
          const producedByAttempt = exists && afterFingerprint !== beforeFingerprint;
          verificationResults.push({
            label: `File exists: ${step.path}`,
            passed: producedByAttempt,
            summary: !exists
              ? `File '${step.path}' is missing.`
              : producedByAttempt
                ? `File '${step.path}' was created or changed by this attempt.`
                : `File '${step.path}' existed unchanged before this attempt.`,
          });
          if (!producedByAttempt) allVerificationPassed = false;
        } else if (step.type === "command") {
          try {
            if (!isAllowedVerificationCommand(step.executable, step.args)) {
              throw new Error("Verification command is not in the trusted read-only registry");
            }
            const output = execFileSync(step.executable, step.args, {
              cwd: canonicalWorkspace,
              encoding: "utf-8",
              windowsHide: true,
              timeout: step.timeoutMs,
              shell: false,
            });
            verificationResults.push({
              label: `Command: ${step.executable} ${step.args.join(" ")}`,
              passed: true,
              exitCode: 0,
              summary: maskSecrets(output.slice(0, 500)) || "Command exited successfully; objective evidence is evaluated separately.",
            });
          } catch (error: any) {
            allVerificationPassed = false;
            verificationResults.push({
              label: `Command: ${step.executable} ${step.args.join(" ")}`,
              passed: false,
              exitCode: typeof error?.status === "number" ? error.status : 1,
              summary: maskSecrets(error?.stderr || error?.message || String(error)),
            });
          }
        } else if (step.type === "git_diff") {
          const scopedChanges = changedFiles.filter(({ path: changedPath }) =>
            step.allowedPaths.some((allowed) => pathIsWithinScope(changedPath, allowed)),
          );
          const hasDiff = scopedChanges.length > 0;
          verificationResults.push({
            label: "Observed scoped diff",
            passed: hasDiff,
            summary: hasDiff ? `${scopedChanges.length} approved files changed` : "No approved-path diff detected",
          });
          if (!hasDiff) allVerificationPassed = false;
        }
      }
    }

    const objectiveEvidenceObserved = changedFiles.some(({ path: changedPath }) =>
      !isProtectedWorkspacePath(changedPath) &&
      task.allowedPaths.some((allowed) => pathIsWithinScope(changedPath, allowed)),
    ) || verificationResults.some((result) => result.passed && result.label.startsWith("File exists:"));
    if (executionSuccess && allVerificationPassed && !objectiveEvidenceObserved) {
      allVerificationPassed = false;
      verificationResults.push({
        label: "Observed task effect",
        passed: false,
        summary: "Read-only git command success without an observed artifact or scoped change cannot prove task completion.",
      });
    }

    const cancelled = cancelledByCaller || cancelledByExecutor;
    const finalStatus: ExecutionResultV1["status"] = cancelled
      ? "CANCELLED"
      : executionSuccess && allVerificationPassed
        ? "COMPLETED"
        : executionSuccess
          ? "NEEDS_FIX"
          : "FAILED";
    const warnings: string[] = [HOST_PROCESS_WARNING];
    if (!executionSuccess) warnings.push(`Execution error: ${failureReason || "unknown failure"}`);
    if (!allVerificationPassed && !cancelled) warnings.push("One or more verification criteria failed");
    if (outputTruncated) warnings.push("Executor output was truncated to bounded in-memory limits");

    return {
      taskId: task.taskId,
      attemptId,
      executor: selectedExecutorId,
      status: finalStatus,
      summary: cancelled
        ? "Task execution was cancelled by user or executor"
        : executionSuccess
          ? allVerificationPassed
            ? `Task '${task.title}' completed with observed objective evidence.`
            : `Task '${task.title}' ran, but objective evidence or verification was insufficient.`
          : `Task execution failed: ${failureReason || "unknown failure"}`,
      changedFiles,
      verificationResults,
      warnings,
      nextRecommendation: finalStatus === "COMPLETED"
        ? "Proceed to reviewer validation"
        : "Review execution evidence before retrying",
      stdout,
      stderr,
      outputTruncated,
      objectiveEvidenceObserved,
      security,
    };
  }
}
