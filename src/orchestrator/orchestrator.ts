import { fingerprint } from "../fingerprint.js";
import { newId } from "../ids.js";
import type {
  ConversationRef,
  ModelAdapter,
  TurnRef,
} from "../adapters/adapter-contract.js";
import type { AppDatabase } from "../storage/database.js";
import { ProjectRepository } from "../storage/repository.js";
import {
  buildPeerReviewPrompt,
  buildIncrementalPrompt,
  buildInitialCollaborationPrompt,
} from "./prompt-builder.js";
import {
  defaultLimits,
  validateLimits,
  type OrchestrationLimits,
} from "./limits.js";
import { QualityMetrics } from "../observability/metrics.js";
import { logEvent } from "../observability/logger.js";
import { globalEventBus } from "../events/event-bus.js";

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
  responses: Array<{
    providerId: string;
    text: string;
    round: number;
    agreed?: boolean;
  }>;
  consensusReached?: boolean;
}

export interface RunHooks {
  editBeforeSend?: (providerId: string, message: string) => Promise<string>;
  confirm?: (summary: string) => Promise<boolean>;
  onResponseUpdate?: (providerId: string, text: string) => void;
}

export class Orchestrator {
  private stopped = false;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private activeRunId: string | null = null;
  private readonly activeTurns = new Map<string, TurnRef>();
  private readonly preparedConversations = new Set<string>();

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
    this.preparedConversations.clear();
    this.activeRunId = runId;
    this.createRun(runId, projectId, effectiveMode, limits);
    const repository = new ProjectRepository(this.database);
    // Each provider web chat already owns its history. Re-sending the local
    // transcript duplicates old messages and makes every later prompt larger.
    const initialMessage = task;
    repository.appendConversationEntry({
      projectId,
      runId,
      role: "USER",
      content: task,
    });
    const responses: RunOutput["responses"] = [];
    const startedAt = Date.now();
    const runMetrics = new QualityMetrics(this.database);
    let consensusReached = false;

    logEvent("INFO", "orchestration.run.started", {
      runId,
      projectId,
      mode: effectiveMode,
      providers: providerIds,
      taskLength: task.length,
      turnLimit: effectiveMode === "SEQUENTIAL" ? providerIds.length : limits.maxTurns,
    });

    try {
      this.setStatus(runId, "RUNNING");
      if (effectiveMode === "PARALLEL") {
        const independent = await Promise.allSettled(
          providerIds.map(async (providerId) => ({
              providerId,
              text: await this.withSessionLimit(
                startedAt,
                limits,
                this.ask(
                  projectId,
                  repository,
                  providerId,
                  initialMessage,
                  limits,
                  hooks,
                ),
              ),
              round: 1,
            })),
        );
        for (const result of independent) {
          if (result.status === "fulfilled") {
            const response = result.value;
            responses.push(response);
            repository.appendConversationEntry({
              projectId,
              runId,
              role: "ASSISTANT",
              providerId: response.providerId,
              round: response.round,
              content: response.text,
            });
          }
        }
        const failure = independent.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) {
          await this.cancelActiveTurns();
          throw failure.reason;
        }
      } else if (effectiveMode === "MANUAL") {
        const response = {
          providerId: providerIds[0]!,
          text: await this.withSessionLimit(
            startedAt,
            limits,
            this.ask(
              projectId,
              repository,
              providerIds[0]!,
              initialMessage,
              limits,
              hooks,
            ),
          ),
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
        let message = buildInitialCollaborationPrompt(
          initialMessage,
          effectiveMode === "DEBATE",
        );
        const seen = new Set<string>();
        const consensusToken = `[[G_PLUS_G_DONE:${runId}]]`;
        const agreedProviders = new Set<string>();
        const turnLimit =
          effectiveMode === "SEQUENTIAL" ? providerIds.length : limits.maxTurns;
        for (let turn = 0; turn < turnLimit; turn += 1) {
          await this.waitIfPaused();
          this.assertWithinLimits(startedAt, limits);
          if (this.stopped) break;
          const providerId = providerIds[turn % providerIds.length]!;
          const rawText = await this.ask(
            projectId,
            repository,
            providerId,
            message,
            limits,
            hooks,
          );
          const agreed =
            effectiveMode === "DEBATE" && rawText.includes(consensusToken);
          const text = rawText.replaceAll(consensusToken, "").trim();
          if (agreed) agreedProviders.add(providerId);
          else agreedProviders.delete(providerId);
          responses.push({ providerId, text, round: turn + 1, agreed });
          repository.appendConversationEntry({
            projectId,
            runId,
            role: "ASSISTANT",
            providerId,
            round: turn + 1,
            content: text,
          });
          if (
            effectiveMode === "DEBATE" &&
            providerIds.every((candidate) => agreedProviders.has(candidate))
          ) {
            consensusReached = true;
            break;
          }
          const hash = fingerprint(text);
          if (seen.has(hash)) break;
          seen.add(hash);
          if (
            limits.requireConfirmation === true &&
            (turn + 1) % limits.confirmationEvery === 0 &&
            hooks.confirm
          ) {
            this.setStatus(runId, "AWAITING_CONFIRMATION");
            if (!(await hooks.confirm(`Continue after ${turn + 1} turns?`))) break;
            this.setStatus(runId, "RUNNING");
          }
          message = effectiveMode === "DEBATE"
            ? buildIncrementalPrompt(
                initialMessage,
                [responses[responses.length - 1]!],
                turn + 2,
                consensusToken,
              )
            : buildPeerReviewPrompt(initialMessage, text);
        }
      }
      const status: RunStatus = this.stopped ? "STOPPED" : "COMPLETED";
      this.setStatus(runId, status);
      runMetrics.record("orchestration.run.success", status === "COMPLETED" ? 1 : 0, {
        mode: effectiveMode,
      });
      runMetrics.record("orchestration.run.elapsed_ms", Date.now() - startedAt, {
        mode: effectiveMode,
      });
      logEvent("INFO", "orchestration.run.completed", {
        runId,
        mode: effectiveMode,
        status,
        responseCount: responses.length,
        consensusReached,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        runId,
        status,
        responses,
        consensusReached,
      };
    } catch (error) {
      logEvent("ERROR", "orchestration.run.failed", {
        runId,
        mode: effectiveMode,
        responseCount: responses.length,
        elapsedMs: Date.now() - startedAt,
        error,
      });
      await this.cancelActiveTurns();
      if (this.stopped) {
        this.setStatus(runId, "STOPPED");
        runMetrics.record("orchestration.run.success", 0, { mode: effectiveMode });
        runMetrics.record("orchestration.run.elapsed_ms", Date.now() - startedAt, {
          mode: effectiveMode,
        });
        return { runId, status: "STOPPED", responses };
      }
      this.setStatus(runId, "FAILED");
      runMetrics.record("orchestration.run.success", 0, { mode: effectiveMode });
      runMetrics.record("orchestration.run.elapsed_ms", Date.now() - startedAt, {
        mode: effectiveMode,
      });
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
    logEvent("INFO", "provider.turn.preparing", {
      runId: this.activeRunId,
      projectId,
      providerId,
      conversationId: conversation.id,
      hasExternalRef: Boolean(conversation.externalRef),
      messageLength: edited.length,
    });
    await this.prepareWebConversation(adapter, conversation.id, conversation.externalRef);
    const started = repository.beginTurn(conversation.id);
    let attempt = started.attempt;
    repository.addMessage(started.turn.id, attempt.id, "USER", edited);
    let lastError: unknown;
    const metricStartedAt = Date.now();
    const metrics = new QualityMetrics(this.database);
    for (let attemptIndex = 0; attemptIndex <= limits.maxRetries; attemptIndex += 1) {
      let turn: TurnRef;
      try {
        logEvent("INFO", "provider.turn.submitting", {
          runId: this.activeRunId,
          providerId,
          turnId: started.turn.id,
          attempt: attemptIndex + 1,
        });
        repository.updateTurnStatus(started.turn.id, "SUBMITTING");
        turn = await adapter.sendMessage({ content: edited });
        repository.updateTurnStatus(started.turn.id, "WAITING_RESPONSE");
        logEvent("INFO", "provider.turn.submitted", {
          runId: this.activeRunId,
          providerId,
          turnId: started.turn.id,
          adapterTurnId: turn.id,
        });
      } catch (error) {
        logEvent("ERROR", "provider.turn.submit_failed", {
          runId: this.activeRunId,
          providerId,
          turnId: started.turn.id,
          attempt: attemptIndex + 1,
          error,
        });
        lastError = error;
        repository.finishAttempt(
          attempt.id,
          "FAILED",
          error instanceof Error ? error.message : String(error),
        );
        if (attemptIndex === limits.maxRetries || isNonRetryableTurnError(error)) {
          repository.updateTurnStatus(started.turn.id, "FAILED");
          metrics.record("provider.turn.success", 0, { providerId });
          metrics.record("provider.turn.retry_count", attemptIndex, { providerId });
          break;
        }
        await adapter.recover();
        attempt = repository.beginAttempt(started.turn.id);
        continue;
      }

      this.activeTurns.set(providerId, turn);
      const observePromise = (async () => {
        try {
          if (typeof adapter.observeTurn === "function") {
            const iterable = adapter.observeTurn(turn);
            if (iterable && typeof iterable[Symbol.asyncIterator] === "function") {
              for await (const event of iterable) {
                if (event.type === "RESPONSE_UPDATED" && event.text && hooks.onResponseUpdate) {
                  hooks.onResponseUpdate(providerId, event.text);
                }
                logEvent("INFO", "provider.turn.event", {
                  runId: this.activeRunId,
                  providerId,
                  turnId: started.turn.id,
                  eventType: event.type,
                  textLength: event.text?.length ?? 0,
                  elapsedMs: Date.now() - metricStartedAt,
                });
              }
            }
          }
        } catch (error) {
          console.error(`[${providerId}] Streaming error:`, error);
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${providerId} turn timed out`)),
          limits.maxTurnMs,
        );
      });
      try {
        const result = await Promise.race([adapter.getFinalResponse(turn), timeout]);
        if (timer) clearTimeout(timer);
        await observePromise;
        repository.addMessage(started.turn.id, attempt.id, "ASSISTANT", result.response);
        repository.finishAttempt(attempt.id, "COMPLETED");
        repository.updateTurnStatus(started.turn.id, "COMPLETED");
        metrics.record("provider.turn.success", 1, { providerId });
        metrics.record("provider.turn.elapsed_ms", Date.now() - metricStartedAt, {
          providerId,
        });
        metrics.record("provider.turn.retry_count", attemptIndex, { providerId });
        const currentConversation =
          typeof adapter.getCurrentConversation === "function"
            ? await adapter.getCurrentConversation().catch(() => undefined)
            : undefined;
        if (currentConversation?.url) {
          repository.updateConversationExternalRef(
            conversation.id,
            currentConversation.url,
          );
        }
        logEvent("INFO", "provider.turn.completed", {
          runId: this.activeRunId,
          providerId,
          turnId: started.turn.id,
          responseLength: result.response.length,
          elapsedMs: Date.now() - metricStartedAt,
        });
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
        metrics.record("provider.turn.success", 0, { providerId });
        metrics.record("provider.turn.elapsed_ms", Date.now() - metricStartedAt, {
          providerId,
        });
        metrics.record("provider.turn.retry_count", attemptIndex, { providerId });
        logEvent("ERROR", "provider.turn.failed", {
          runId: this.activeRunId,
          providerId,
          turnId: started.turn.id,
          elapsedMs: Date.now() - metricStartedAt,
          error,
        });
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

  private async prepareWebConversation(
    adapter: ModelAdapter,
    conversationId: string,
    externalRef: string | null,
  ): Promise<void> {
    if (this.preparedConversations.has(conversationId)) return;
    if (
      typeof adapter.createConversation !== "function" ||
      typeof adapter.openConversation !== "function"
    ) {
      // Some deterministic test adapters intentionally implement only turn methods.
      this.preparedConversations.add(conversationId);
      return;
    }
    if (externalRef) {
      logEvent("INFO", "provider.conversation.opening", {
        runId: this.activeRunId,
        providerId: adapter.providerId,
        conversationId,
      });
      const ref: ConversationRef = { id: conversationId, url: externalRef };
      await adapter.openConversation(ref);
    } else {
      logEvent("INFO", "provider.conversation.creating", {
        runId: this.activeRunId,
        providerId: adapter.providerId,
        conversationId,
      });
      await adapter.createConversation();
    }
    this.preparedConversations.add(conversationId);
    logEvent("INFO", "provider.conversation.ready", {
      runId: this.activeRunId,
      providerId: adapter.providerId,
      conversationId,
      reused: Boolean(externalRef),
    });
  }

  private async withSessionLimit<T>(
    startedAt: number,
    limits: OrchestrationLimits,
    operation: Promise<T>,
  ): Promise<T> {
    const remaining = limits.maxSessionMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("Session time limit exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Session time limit exceeded")),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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

    globalEventBus.emit({
      event_type: "phase:changed",
      run_id: id,
      payload: {
        target: "orchestrator",
        phase: status === "RUNNING" ? "RUNNING" : status === "COMPLETED" ? "COMPLETED" : status === "FAILED" ? "FAILED" : "IDLE",
        details: `Orchestrator status: ${status}`,
      },
    });
  }
}

function isNonRetryableTurnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /target (page|context|browser).*closed|turn cancelled|profile is already in use/i.test(
    message,
  );
}
