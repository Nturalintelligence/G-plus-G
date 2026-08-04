import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { TaskFsmRepository, type CliTaskRecord, type CliTaskState } from "../storage/task-fsm-repository.js";
import { SafeExecutionBroker, type ExecutionResultV1 } from "./execution-broker.js";
import { CodexCliExecutor } from "./executors/codex-executor.js";
import { GeminiCliExecutor } from "./executors/gemini-executor.js";
import { AntigravityCliExecutor } from "./executors/antigravity-executor.js";
import type { CliTaskEnvelopeV1 } from "./cli-task-schema.js";

export interface CliExecutionServiceOptions {
  workspaceRoot?: string;
  desktopPath?: string;
}

export class CliExecutionService {
  public fsmRepo: TaskFsmRepository;
  public broker: SafeExecutionBroker;
  private isProcessing = false;
  private desktopPath: string;

  constructor(private db: DatabaseSync, options?: CliExecutionServiceOptions) {
    this.fsmRepo = new TaskFsmRepository(db);
    this.broker = new SafeExecutionBroker();
    this.desktopPath = options?.desktopPath || path.join(process.env.USERPROFILE || "C:\\Users\\Default", "Desktop");

    // Register standard CLI executors
    this.broker.registerExecutor(new CodexCliExecutor());
    this.broker.registerExecutor(new GeminiCliExecutor());
    this.broker.registerExecutor(new AntigravityCliExecutor());

    // Recover orphaned RUNNING tasks on startup
    this.fsmRepo.recoverInterruptedTasksOnStartup();
  }

  public getAvailableExecutors(): Array<{ id: string; healthy: boolean; capabilities: string[] }> {
    return [
      { id: "codex", healthy: true, capabilities: ["file_read", "file_write", "command_exec"] },
      { id: "gemini", healthy: true, capabilities: ["file_read", "file_write"] },
      { id: "antigravity", healthy: true, capabilities: ["file_read", "file_write", "command_exec"] },
    ];
  }

  public getWorkspaceCapabilities(): Array<{ id: string; label: string; allowedOperations: string[] }> {
    return [
      { id: "project", label: "Project Workspace", allowedOperations: ["read", "write", "create_dir"] },
      { id: "desktop", label: "Desktop Capability", allowedOperations: ["create_approved_folder"] },
    ];
  }

  public getTask(projectId: string, taskId: string): CliTaskRecord | null {
    return this.fsmRepo.getTaskById(projectId, taskId);
  }

  /**
   * Atomically approves a task and triggers the background execution scheduler.
   */
  public async approveTask(projectId: string, taskId: string): Promise<CliTaskRecord> {
    const task = this.fsmRepo.getTaskById(projectId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    if (task.status === "AWAITING_APPROVAL" || task.status === "PROPOSED" || task.status === "VALIDATED") {
      this.fsmRepo.transitionState(projectId, taskId, "QUEUED");
    }

    // Trigger scheduler asynchronously
    setImmediate(() => this.processQueue());

    return this.fsmRepo.getTaskById(projectId, taskId)!;
  }

  /**
   * Rejects a task.
   */
  public rejectTask(projectId: string, taskId: string, reason?: string): CliTaskRecord {
    this.fsmRepo.transitionState(projectId, taskId, "REJECTED", { lastError: reason || "User rejected task" });
    return this.fsmRepo.getTaskById(projectId, taskId)!;
  }

  /**
   * Background queue worker processing QUEUED tasks sequentially.
   */
  public async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const queuedRows = this.db
        .prepare("SELECT project_id, task_id FROM cli_tasks WHERE status = 'QUEUED' ORDER BY created_at ASC")
        .all() as Array<{ project_id: string; task_id: string }>;

      for (const row of queuedRows) {
        const task = this.fsmRepo.getTaskById(row.project_id, row.task_id);
        if (!task || task.status !== "QUEUED") continue;

        let envelope: CliTaskEnvelopeV1;
        try {
          envelope = JSON.parse(task.taskJson) as CliTaskEnvelopeV1;
        } catch {
          continue;
        }

        const attempt = this.fsmRepo.createAttempt(task.taskId);
        this.fsmRepo.transitionState(task.projectId, task.taskId, "RUNNING", { activeAttemptId: attempt.id }, attempt.id);

        try {
          this.fsmRepo.transitionState(task.projectId, task.taskId, "VERIFYING", undefined, attempt.id);

          // Resolve execution workspace: if targeting desktop capability, map to actual desktopPath
          let effectiveWorkspace = process.cwd();
          if (envelope.instructions.some((inst: string) => inst.toLowerCase().includes("desktop"))) {
            effectiveWorkspace = this.desktopPath;
          }

          const result: ExecutionResultV1 = await this.broker.executeTaskEnvelope(
            envelope,
            attempt.id,
            effectiveWorkspace
          );

          if (result.status === "COMPLETED") {
            this.fsmRepo.transitionState(task.projectId, task.taskId, "COMPLETED", undefined, attempt.id);
            this.fsmRepo.finishAttempt(attempt.id, "COMPLETED");
          } else {
            this.fsmRepo.transitionState(task.projectId, task.taskId, "NEEDS_FIX", {
              lastError: result.summary || "Verification failed",
            }, attempt.id);
            this.fsmRepo.finishAttempt(attempt.id, "FAILED");
          }
        } catch (err: any) {
          this.fsmRepo.transitionState(task.projectId, task.taskId, "FAILED", {
            lastError: err.message || "Execution exception",
          }, attempt.id);
          this.fsmRepo.finishAttempt(attempt.id, "FAILED");
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
