import type { DatabaseSync } from "node:sqlite";
import { TaskFsmRepository, type CliTaskRecord } from "../storage/task-fsm-repository.js";
import { SafeExecutionBroker, maskSecrets, type ExecutionResultV1 } from "./execution-broker.js";
import { CodexCliExecutor } from "./executors/codex-executor.js";
import { GeminiCliExecutor } from "./executors/gemini-executor.js";
import { AntigravityCliExecutor } from "./executors/antigravity-executor.js";
import { validateCliTaskEnvelopeV1, type CliTaskEnvelopeV1, type ExecutorId } from "./cli-task-schema.js";

export interface CliExecutionServiceOptions {
  workspaceRoot?: string;
  onResult?: (task: CliTaskRecord, result: ExecutionResultV1) => void | Promise<void>;
}

export interface ExecutorAvailability {
  id: ExecutorId;
  healthy: boolean;
  version?: string;
  reason?: string;
  capabilities: string[];
  supportedRisks: string[];
  maxTimeoutMs: number;
  hostProcessSandboxed: false;
  enforcement: "preflight-and-postflight-audit";
}

const RETRYABLE_STATES = new Set(["FAILED", "NEEDS_FIX", "INTERRUPTED", "BLOCKED"]);
const DEPENDENCY_FAILURE_STATES = new Set(["FAILED", "NEEDS_FIX", "INTERRUPTED", "BLOCKED", "CANCELLED", "REJECTED"]);

function taskKey(projectId: string, taskId: string): string {
  return `${projectId}\0${taskId}`;
}

export class CliExecutionService {
  public readonly fsmRepo: TaskFsmRepository;
  public readonly broker: SafeExecutionBroker;
  private isProcessing = false;
  private readonly workspaceRoot: string;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly onResult?: CliExecutionServiceOptions["onResult"];

  constructor(private readonly db: DatabaseSync, options?: CliExecutionServiceOptions) {
    this.fsmRepo = new TaskFsmRepository(db);
    this.broker = new SafeExecutionBroker();
    this.workspaceRoot = options?.workspaceRoot || process.cwd();
    this.onResult = options?.onResult;

    this.broker.registerExecutor(new CodexCliExecutor());
    this.broker.registerExecutor(new GeminiCliExecutor());
    this.broker.registerExecutor(new AntigravityCliExecutor());
    this.fsmRepo.recoverInterruptedTasksOnStartup();
  }

  public async getAvailableExecutors(): Promise<ExecutorAvailability[]> {
    return Promise.all(this.broker.listExecutors().map(async (executor) => {
      const capabilities = executor.capabilities();
      const health = await this.broker.getExecutorHealth(executor.id);
      return {
        id: executor.id,
        healthy: health.healthy,
        ...(health.version ? { version: health.version } : {}),
        ...(health.reason ? { reason: health.reason } : {}),
        capabilities: [
          "file_read",
          ...(capabilities.supportedRisks.includes("WORKSPACE_WRITE") ? ["file_write"] : []),
          ...(capabilities.supportedRisks.includes("COMMAND_EXECUTION") ? ["command_exec"] : []),
        ],
        supportedRisks: [...capabilities.supportedRisks],
        maxTimeoutMs: capabilities.maxTimeoutMs,
        hostProcessSandboxed: false as const,
        enforcement: "preflight-and-postflight-audit" as const,
      };
    }));
  }

  public getWorkspaceCapabilities(): Array<{
    id: string;
    label: string;
    allowedOperations: string[];
    hostProcessSandboxed: false;
    enforcement: "preflight-and-postflight-audit";
  }> {
    return [{
      id: "project",
      label: "Managed CLI Workspace",
      allowedOperations: ["read", "write", "create_dir"],
      hostProcessSandboxed: false,
      enforcement: "preflight-and-postflight-audit",
    }];
  }

  public getTask(projectId: string, taskId: string): CliTaskRecord | null {
    return this.fsmRepo.getTaskById(projectId, taskId);
  }

  public async approveTask(projectId: string, taskId: string): Promise<CliTaskRecord> {
    const task = this.fsmRepo.getTaskById(projectId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "AWAITING_APPROVAL" && task.status !== "PROPOSED" && task.status !== "VALIDATED") {
      throw new Error(`Task ${taskId} cannot be approved from state ${task.status}`);
    }
    if (task.status === "PROPOSED") {
      this.fsmRepo.transitionState(projectId, taskId, "VALIDATED");
      this.fsmRepo.transitionState(projectId, taskId, "AWAITING_APPROVAL");
    } else if (task.status === "VALIDATED") {
      this.fsmRepo.transitionState(projectId, taskId, "AWAITING_APPROVAL");
    }
    this.fsmRepo.transitionState(projectId, taskId, "QUEUED", { approvedAt: new Date().toISOString() });
    setImmediate(() => void this.processQueue());
    return this.fsmRepo.getTaskById(projectId, taskId)!;
  }

  public rejectTask(projectId: string, taskId: string, reason?: string): CliTaskRecord {
    this.fsmRepo.transitionState(projectId, taskId, "REJECTED", {
      lastError: reason || "User rejected task",
    });
    return this.fsmRepo.getTaskById(projectId, taskId)!;
  }

  public cancelTask(projectId: string, taskId: string): CliTaskRecord {
    const task = this.fsmRepo.getTaskById(projectId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === "CANCELLED") return task;
    this.activeControllers.get(taskKey(projectId, taskId))?.abort();
    return this.fsmRepo.transitionState(projectId, taskId, "CANCELLED", {
      cancelledAt: new Date().toISOString(),
      outcome: task.status === "RUNNING" || task.status === "VERIFYING" ? "UNKNOWN" : "NOT_STARTED",
    }, task.activeAttemptId);
  }

  public retryTask(projectId: string, taskId: string): CliTaskRecord {
    const task = this.fsmRepo.getTaskById(projectId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!RETRYABLE_STATES.has(task.status)) {
      throw new Error(`Task ${taskId} cannot be retried from state ${task.status}`);
    }
    return this.fsmRepo.transitionState(projectId, taskId, "AWAITING_APPROVAL", {
      retryRequestedAt: new Date().toISOString(),
    });
  }

  private dependencyCycle(projectId: string, taskId: string): string[] | null {
    const visiting: string[] = [];
    const visited = new Set<string>();
    const visit = (candidateId: string): string[] | null => {
      const cycleStart = visiting.indexOf(candidateId);
      if (cycleStart >= 0) return [...visiting.slice(cycleStart), candidateId];
      if (visited.has(candidateId)) return null;
      visited.add(candidateId);
      const candidate = this.fsmRepo.getTaskById(projectId, candidateId);
      if (!candidate) return null;
      let dependencies: string[] = [];
      try {
        const parsed = JSON.parse(candidate.taskJson) as { dependsOn?: unknown };
        if (Array.isArray(parsed.dependsOn)) {
          dependencies = parsed.dependsOn.filter((item): item is string => typeof item === "string");
        }
      } catch {
        return null;
      }
      visiting.push(candidateId);
      for (const dependencyId of dependencies) {
        const cycle = visit(dependencyId);
        if (cycle) return cycle;
      }
      visiting.pop();
      return null;
    };
    return visit(taskId);
  }

  private dependencyDecision(envelope: CliTaskEnvelopeV1): { ready: boolean; blockedReason?: string } {
    const cycle = this.dependencyCycle(envelope.projectId, envelope.taskId);
    if (cycle) return { ready: false, blockedReason: `Dependency cycle detected: ${cycle.join(" -> ")}` };
    for (const dependencyId of envelope.dependsOn) {
      const dependency = this.fsmRepo.getTaskById(envelope.projectId, dependencyId);
      if (!dependency) return { ready: false, blockedReason: `Dependency '${dependencyId}' does not exist` };
      if (DEPENDENCY_FAILURE_STATES.has(dependency.status)) {
        return { ready: false, blockedReason: `Dependency '${dependencyId}' ended in ${dependency.status}` };
      }
      if (dependency.status !== "COMPLETED") return { ready: false };
    }
    return { ready: true };
  }

  private async persistResult(task: CliTaskRecord, result: ExecutionResultV1): Promise<void> {
    this.fsmRepo.recordExecutionResult(task.projectId, task.taskId, result.attemptId, {
      ...result,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    });
    if (this.onResult) {
      try {
        await this.onResult(task, result);
      } catch {
        // Result persistence is authoritative; an observer hook cannot alter task state.
      }
    }
  }

  private completeAttempt(task: CliTaskRecord, result: ExecutionResultV1): void {
    const current = this.fsmRepo.getTaskById(task.projectId, task.taskId);
    if (!current) throw new Error(`Task ${task.taskId} disappeared during execution`);

    if (current.status === "CANCELLED" || result.status === "CANCELLED") {
      if (current.status !== "CANCELLED") {
        this.fsmRepo.transitionState(task.projectId, task.taskId, "CANCELLED", {
          outcome: "UNKNOWN",
          lastError: result.summary,
        }, result.attemptId);
      }
      this.fsmRepo.finishAttempt(result.attemptId, "CANCELLED");
      return;
    }

    if (result.status === "FAILED") {
      this.fsmRepo.transitionState(task.projectId, task.taskId, "FAILED", {
        lastError: result.summary,
      }, result.attemptId);
      this.fsmRepo.finishAttempt(result.attemptId, "FAILED");
      return;
    }

    this.fsmRepo.transitionState(task.projectId, task.taskId, "VERIFYING", undefined, result.attemptId);
    if (result.status === "COMPLETED") {
      this.fsmRepo.transitionState(task.projectId, task.taskId, "COMPLETED", undefined, result.attemptId);
      this.fsmRepo.finishAttempt(result.attemptId, "COMPLETED");
    } else {
      this.fsmRepo.transitionState(task.projectId, task.taskId, "NEEDS_FIX", {
        lastError: result.summary || "Verification failed",
      }, result.attemptId);
      this.fsmRepo.finishAttempt(result.attemptId, "FAILED");
    }
  }

  public async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      let madeProgress = true;
      while (madeProgress) {
        madeProgress = false;
        const queuedRows = this.db.prepare(
          "SELECT project_id, task_id FROM cli_tasks WHERE status = 'QUEUED' ORDER BY created_at ASC",
        ).all() as Array<{ project_id: string; task_id: string }>;

        for (const row of queuedRows) {
          const task = this.fsmRepo.getTaskById(row.project_id, row.task_id);
          if (!task || task.status !== "QUEUED") continue;

          let envelope: CliTaskEnvelopeV1;
          try {
            const parsed = JSON.parse(task.taskJson) as unknown;
            const validation = validateCliTaskEnvelopeV1(parsed, { workspaceRoot: this.workspaceRoot });
            if (!validation.success) throw new Error(`${validation.reasonCode}: ${validation.errorDetails}`);
            envelope = validation.envelope;
            if (envelope.projectId !== task.projectId || envelope.taskId !== task.taskId) {
              throw new Error("Stored envelope identity does not match its task record");
            }
          } catch (error: any) {
            this.fsmRepo.transitionState(task.projectId, task.taskId, "FAILED", {
              lastError: maskSecrets(`Malformed queued task: ${error?.message || String(error)}`),
            });
            madeProgress = true;
            continue;
          }

          const dependency = this.dependencyDecision(envelope);
          if (dependency.blockedReason) {
            this.fsmRepo.transitionState(task.projectId, task.taskId, "BLOCKED", {
              lastError: dependency.blockedReason,
            });
            madeProgress = true;
            continue;
          }
          if (!dependency.ready) continue;

          const attempt = this.fsmRepo.createAttempt(task.projectId, task.taskId);
          const controller = new AbortController();
          const key = taskKey(task.projectId, task.taskId);
          this.activeControllers.set(key, controller);
          this.fsmRepo.transitionState(task.projectId, task.taskId, "RUNNING", {
            activeAttemptId: attempt.id,
          }, attempt.id);

          try {
            const result = await this.broker.executeTaskEnvelope(
              envelope,
              attempt.id,
              this.workspaceRoot,
              controller.signal,
            );
            await this.persistResult(task, result);
            this.completeAttempt(task, result);
          } catch (error: any) {
            const current = this.fsmRepo.getTaskById(task.projectId, task.taskId);
            if (current?.status === "CANCELLED") {
              this.fsmRepo.finishAttempt(attempt.id, "CANCELLED");
            } else {
              this.fsmRepo.transitionState(task.projectId, task.taskId, "FAILED", {
                lastError: maskSecrets(error?.message || "Execution exception"),
              }, attempt.id);
              this.fsmRepo.finishAttempt(attempt.id, "FAILED");
            }
          } finally {
            this.activeControllers.delete(key);
          }
          madeProgress = true;
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
