import { fingerprint } from "../fingerprint.js";
import { newId } from "../ids.js";
import type { ModelAdapter, TurnRef } from "../adapters/adapter-contract.js";
import type { AppDatabase } from "../storage/database.js";
import { ProjectRepository } from "../storage/repository.js";
import {
  buildContinuationPrompt,
  buildDebatePrompt,
  buildPeerReviewPrompt,
} from "./prompt-builder.js";
import {
  defaultLimits,
  validateLimits,
  type OrchestrationLimits,
} from "./limits.js";

export type RunMode = "MANUAL" | "SEQUENTIAL" | "PARALLEL" | "DEBATE";
export type RunStatus =
  | "CREATED"
  | "RUNNING"
  | "PAUSED"
  | "AWAITING_CONFIRMATION"
  | "COMPLETED"
  | "STOPPED"
  | "FAILED";

export interface RunOutput {
  runId: string;
  status: RunStatus;
  responses: Array<{ providerId: string; text: string; round: number }>;
}

export interface RunHooks {
  editBeforeSend?: (providerId: string, message: string) => Promise<string>;
  confirm?: (summary: string) => Promise<boolean>;
}

export class Orchestrator {
  private stopped = false;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private activeRunId: string | null = null;
  private readonly activeTurns = new Map<string, TurnRef>();

  constructor(
    private readonly database: AppDatabase,
    private readonly adapters: Map<string, ModelAdapter>,
  ) {}

  pause(): void {
    this.paused = true;
    if (this.activeRunId) this.setStatus(this.activeRunId, "PAUSED");
  }

  resume(): void {
    this.paused = false;
    if (this.activeRunId && !this.stopped) this.setStatus(this.activeRunId, "RUNNING");
    this.resumeWaiters.splice(0).forEach((resolve) => resolve());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.activeRunId) this.setStatus(this.activeRunId, "STOPPED");
    this.paused = false;
    this.resumeWaiters.splice(0).forEach((resolve) => resolve());
    await this.cancelActiveTurns();
  }

  async run(
    projectId: string,
    mode: RunMode,
    task: string,
    providerIds: string[],
    limits: OrchestrationLimits = defaultLimits,
    hooks: RunHooks = {},
  ): Promise<RunOutput> {
    validateLimits(limits);
    if (providerIds.length === 0) throw new Error("At least one provider is required");
    const effectiveMode: RunMode =
      providerIds.length === 1 && (mode === "DEBATE" || mode === "SEQUENTIAL")
        ? "MANUAL"
        : mode;
    this.stopped = false;
    const runId = newId("run");
    this.activeRunId = runId;
    this.createRun(runId, projectId, effectiveMode, limits);
    const repository = new ProjectRepository(this.database);
    const history = repository.conversationEntries(projectId);
    const initialMessage = buildContinuationPrompt(history, task);
    repository.appendConversationEntry({
      projectId,
      runId,
      role: "USER",
      content: task,
    });
    const responses: RunOutput["responses"] = [];
    const startedAt = Date.now();

    try {
      this.setStatus(runId, "RUNNING");
      if (effectiveMode === "PARALLEL") {
        try {
          const independent = await Promise.all(
            providerIds.map(async (providerId) => ({
              providerId,
              text: await this.ask(projectId, repository, providerId, initialMessage, limits, hooks),
              round: 1,
            })),
          );
          responses.push(...independent);
          for (const response of independent) {
            repository.appendConversationEntry({
              projectId,
              runId,
              role: "ASSISTANT",
              providerId: response.providerId,
              round: response.round,
              content: response.text,
            });
          }
        } catch (error) {
          await this.cancelActiveTurns();
          throw error;
        }
      } else if (effectiveMode === "MANUAL") {
        const response = {
          providerId: providerIds[0]!,
          text: await this.ask(projectId, repository, providerIds[0]!, initialMessage, limits, hooks),
          round: 1,
        };
        responses.push(response);
        repository.appendConversationEntry({
          projectId,
          runId,
          role: "ASSISTANT",
          providerId: response.providerId,
          round: response.round,
          content: response.text,
        });
      } else {
        let message = initialMessage;
        const seen = new Set<string>();
        for (let turn = 0; turn < limits.maxTurns; turn += 1) {
          await this.waitIfPaused();
          this.assertWithinLimits(startedAt, limits);
          if (this.stopped) break;
          const providerId = providerIds[turn % providerIds.length]!;
          const text = await this.ask(projectId, repository, providerId, message, limits, hooks);
          responses.push({ providerId, text, round: turn + 1 });
          repository.appendConversationEntry({
            projectId,
            runId,
            role: "ASSISTANT",
            providerId,
            round: turn + 1,
            content: text,
          });
          const hash = fingerprint(text);
          if (seen.has(hash)) break;
          seen.add(hash);
          if ((turn + 1) % limits.confirmationEvery === 0 && hooks.confirm) {
            this.setStatus(runId, "AWAITING_CONFIRMATION");
            if (!(await hooks.confirm(`Continue after ${turn + 1} turns?`))) break;
            this.setStatus(runId, "RUNNING");
          }
          message =
            effectiveMode === "DEBATE"
              ? buildDebatePrompt(initialMessage, responses, turn + 2)
              : buildPeerReviewPrompt(initialMessage, text);
        }
      }
      const status: RunStatus = this.stopped ? "STOPPED" : "COMPLETED";
      this.setStatus(runId, status);
      return { runId, status, responses };
    } catch (error) {
      this.setStatus(runId, "FAILED");
      throw error;
    } finally {
      this.activeRunId = null;
    }
  }

  private async ask(
    projectId: string,
    repository: ProjectRepository,
    providerId: string,
    message: string,
    limits: OrchestrationLimits,
    hooks: RunHooks,
  ): Promise<string> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Adapter is not registered: ${providerId}`);
    const edited = hooks.editBeforeSend
      ? await hooks.editBeforeSend(providerId, message)
      : message;
    const conversation = repository.getOrCreateConversation(projectId, providerId);
    const started = repository.beginTurn(conversation.id);
    let attempt = started.attempt;
    repository.addMessage(started.turn.id, attempt.id, "USER", edited);
    let lastError: unknown;
    for (let attemptIndex = 0; attemptIndex <= limits.maxRetries; attemptIndex += 1) {
      let turn: TurnRef;
      try {
        repository.updateTurnStatus(started.turn.id, "SUBMITTING");
        turn = await adapter.sendMessage({ content: edited });
        repository.updateTurnStatus(started.turn.id, "WAITING_RESPONSE");
      } catch (error) {
        lastError = error;
        repository.finishAttempt(
          attempt.id,
          "FAILED",
          error instanceof Error ? error.message : String(error),
        );
        if (attemptIndex === limits.maxRetries || isNonRetryableTurnError(error)) {
          repository.updateTurnStatus(started.turn.id, "FAILED");
          break;
        }
        await adapter.recover();
        attempt = repository.beginAttempt(started.turn.id);
        continue;
      }

      this.activeTurns.set(providerId, turn);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${providerId} turn timed out`)),
          limits.maxTurnMs,
        );
      });
      try {
        const result = await Promise.race([adapter.getFinalResponse(turn), timeout]);
        repository.addMessage(started.turn.id, attempt.id, "ASSISTANT", result.response);
        repository.finishAttempt(attempt.id, "COMPLETED");
        repository.updateTurnStatus(started.turn.id, "COMPLETED");
        return result.response;
      } catch (error) {
        // A turn reference means submission may already have reached the provider.
        // Retrying here can duplicate the user message, so fail safely.
        await adapter.cancel(turn).catch(() => undefined);
        repository.finishAttempt(
          attempt.id,
          "FAILED",
          error instanceof Error ? error.message : String(error),
        );
        repository.updateTurnStatus(started.turn.id, "FAILED");
        throw error;
      } finally {
        this.activeTurns.delete(providerId);
        if (timer) clearTimeout(timer);
      }
    }
    throw lastError;
  }

  private async cancelActiveTurns(): Promise<void> {
    const pending = [...this.activeTurns.entries()];
    this.activeTurns.clear();
    await Promise.allSettled(
      pending.map(([providerId, turn]) =>
        this.adapters.get(providerId)?.cancel(turn),
      ),
    );
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }

  private assertWithinLimits(startedAt: number, limits: OrchestrationLimits): void {
    if (Date.now() - startedAt > limits.maxSessionMs) {
      throw new Error("Session time limit exceeded");
    }
  }

  private createRun(
    id: string,
    projectId: string,
    mode: RunMode,
    limits: OrchestrationLimits,
  ): void {
    const now = new Date().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO orchestration_runs
         (id, project_id, mode, status, limits_json, created_at, updated_at)
         VALUES (?, ?, ?, 'CREATED', ?, ?, ?)`,
      )
      .run(id, projectId, mode, JSON.stringify(limits), now, now);
  }

  private setStatus(id: string, status: RunStatus): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `UPDATE orchestration_runs
           SET status = ?, updated_at = ?,
               started_at = CASE WHEN ? = 'RUNNING' AND started_at IS NULL THEN ? ELSE started_at END,
               finished_at = CASE WHEN ? IN ('COMPLETED','STOPPED','FAILED') THEN ? ELSE finished_at END
           WHERE id = ?`,
        )
        .run(status, now, status, now, status, now, id);
      this.database.raw
        .prepare(
          `INSERT INTO events
           (id, aggregate_type, aggregate_id, event_type, payload_json, occurred_at)
           VALUES (?, 'OrchestrationRun', ?, 'RUN_STATUS_CHANGED', ?, ?)`,
        )
        .run(newId("evt"), id, JSON.stringify({ status }), now);
    });
  }
}

function isNonRetryableTurnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /target (page|context|browser).*closed|turn cancelled|profile is already in use/i.test(
    message,
  );
}
