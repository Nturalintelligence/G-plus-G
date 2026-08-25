import { fingerprint } from "../fingerprint.js";
import { TurnChannel } from "../adapters/turn-channel.js";
import type { AttachmentRefV1 } from "../attachments/attachments.js";
import {
  AttachmentDeliveryManager,
  ProviderSubmissionManager,
  type AttachmentDelivery,
  type ProviderSubmission,
} from "../attachments/attachment-delivery.js";
import { newId } from "../ids.js";
import type {
  ConversationRef,
  ModelAdapter,
  TurnRef,
} from "../adapters/adapter-contract.js";
import type { AppDatabase } from "../storage/database.js";
import { ProjectRepository } from "../storage/repository.js";
import {
  COLLABORATION_PROTOCOL,
  COLLABORATION_PROTOCOL_HASH,
  COLLABORATION_PROTOCOL_VERSION,
  hasTerminalConsensusMarker,
  stripConsensusMarkers,
  type PromptCustomizations,
} from "./prompt-builder.js";
import { ProviderProtocolStateRepository } from "./provider-protocol-state.js";
import {
  attachmentEnvelopeRefs,
  buildProviderTurnPrompt,
  compactCandidates,
  compactPeer,
  type ProviderTurnEnvelopeV1,
} from "./provider-turn-envelope.js";
import {
  defaultLimits,
  validateLimits,
  type OrchestrationLimits,
} from "./limits.js";
import { QualityMetrics } from "../observability/metrics.js";
import { logEvent } from "../observability/logger.js";
import { globalEventBus } from "../events/event-bus.js";
import { TaskCompiler } from "./task-compiler.js";
import { TaskFsmRepository } from "../storage/task-fsm-repository.js";
import { dataPath } from "../paths.js";
import { ConversationUnavailableError } from "../errors.js";
import { classifyTaskComplexity, discussionTurnBudget } from "./semantic-stopping.js";

export type RunMode = "MANUAL" | "SEQUENTIAL" | "PARALLEL" | "DEBATE";
export type FinalizerMode = "MANUAL" | "LEAD_SELECTS" | "PEER_AGREEMENT";
export type RunOutcome =
  | "COMPLETED"
  | "CONSENSUS_REACHED"
  | "NO_CONSENSUS"
  | "LIMIT_REACHED"
  | "USER_STOPPED";
export type RunPhase = "DISCUSSION" | "FINALIZE";
export type RunStatus =
  | "CREATED"
  | "RUNNING"
  | "PAUSED"
  | "AWAITING_CONFIRMATION"
  | "COMPLETED"
  | "STOPPED"
  | "FAILED";

const VALID_FSM_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  CREATED: ["RUNNING", "FAILED", "STOPPED"],
  RUNNING: ["PAUSED", "AWAITING_CONFIRMATION", "COMPLETED", "STOPPED", "FAILED"],
  PAUSED: ["RUNNING", "STOPPED", "FAILED"],
  AWAITING_CONFIRMATION: ["RUNNING", "STOPPED", "FAILED"],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
};

export function isValidFsmTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  const allowed = VALID_FSM_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export interface RunOutput {
  runId: string;
  status: RunStatus;
  responses: Array<{
    providerId: string;
    sourceProviderId?: string;
    text: string;
    round: number;
    agreed?: boolean;
    phase?: RunPhase;
    final?: boolean;
  }>;
  consensusReached?: boolean;
  outcome: RunOutcome;
  finalResponse?: {
    providerId: string;
    text: string;
    round?: number;
    finalizerProviderId?: string;
  };
}

export interface RunProgressEvent {
  projectId: string;
  runId: string;
  turnId: string;
  providerId: string;
  phase: RunPhase;
  text: string;
}

export interface PromptMemoryContext {
  projectBrief?: string;
  decisionLedger?: string[];
  checkpointId?: string;
}

export interface ContextTurnDirective {
  /** A validated continuation/handshake preamble produced by an external rollover service. */
  continuationPrompt?: string;
}

export interface OrchestrationContextHooks {
  loadPromptContext?: (input: {
    projectId: string;
    runId: string;
  }) => Promise<PromptMemoryContext | undefined> | PromptMemoryContext | undefined;
  beforeTurn?: (input: {
    projectId: string;
    runId: string;
    providerId: string;
    phase: RunPhase;
    round: number;
    charsSent: number;
  }) => Promise<ContextTurnDirective | undefined> | ContextTurnDirective | undefined;
  onTurnCompleted?: (input: {
    projectId: string;
    runId: string;
    providerId: string;
    phase: RunPhase;
    round: number;
    responseText: string;
  }) => Promise<void> | void;
  onRunCompleted?: (input: {
    projectId: string;
    runId: string;
    outcome: RunOutcome;
    checkpointId?: string;
  }) => Promise<void> | void;
}

export interface RunOptions {
  limits?: OrchestrationLimits;
  hooks?: RunHooks;
  attachments?: AttachmentRefV1[];
  finalizerMode?: FinalizerMode;
  finalResponder?: string;
  promptCustomizations?: Record<string, PromptCustomizations>;
  contextHooks?: OrchestrationContextHooks;
  /** Stable renderer-generated id used to bind the persisted user entry to staged artifacts. */
  userMessageId?: string;
}

export interface RunHooks {
  editBeforeSend?: (providerId: string, message: string) => Promise<string>;
  confirm?: (summary: string) => Promise<boolean>;
  onResponseUpdate?: (providerId: string, text: string, event?: RunProgressEvent) => void;
  onProgress?: (event: RunProgressEvent) => void;
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

  public async run(
    projectId: string,
    mode: RunMode,
    task: string,
    providerIds: string[],
    limitsOrOptions: OrchestrationLimits | RunOptions = defaultLimits,
    legacyHooks: RunHooks = {},
    legacyAttachments?: AttachmentRefV1[],
  ): Promise<RunOutput> {
    const options = normalizeRunOptions(limitsOrOptions, legacyHooks, legacyAttachments);
    const limits = options.limits ?? defaultLimits;
    const hooks = options.hooks ?? {};
    const attachments = options.attachments;
    validateLimits(limits);
    if (providerIds.length === 0) throw new Error("At least one provider is required");
    const userMessageId = validateOptionalMessageId(options.userMessageId);
    const effectiveMode: RunMode =
      providerIds.length === 1 && (mode === "DEBATE" || mode === "SEQUENTIAL")
        ? "MANUAL"
        : mode;
    const taskComplexity = classifyTaskComplexity(task, Boolean(options.attachments?.length));
    const selectedFinalizerProvider = effectiveMode === "MANUAL"
      ? providerIds[0]!
      : selectFinalizerProvider(providerIds, options);
    this.stopped = false;
    const runId = newId("run");
    this.preparedConversations.clear();
    this.activeRunId = runId;
    this.createRun(runId, projectId, effectiveMode, limits);
    const repository = new ProjectRepository(this.database);
    const taskCompiler = new TaskCompiler(new TaskFsmRepository(this.database.raw));
    let memoryContext: PromptMemoryContext | undefined;
    const protocolStates = new ProviderProtocolStateRepository(this.database.raw);
    const protocolIdentity = {
      version: COLLABORATION_PROTOCOL_VERSION,
      hash: COLLABORATION_PROTOCOL_HASH,
      text: COLLABORATION_PROTOCOL,
    };
    let persistedUserMessageId = userMessageId;
    const responseEntryIds = new Map<string, string>();
    let charsSent = 0;
    const processModelText = (rawText: string): string => {
      const processed = taskCompiler.processModelTurnResponse(rawText, {
        workspaceRoot: dataPath("cli-workspace"),
        expectedProjectId: projectId,
        expectedRunId: runId,
      });
      if (processed.rejectedBlocks.length > 0) {
        logEvent("WARN", "cli_task.proposal_rejected", {
          projectId,
          runId,
          reasonCodes: processed.rejectedBlocks.map((block) => block.success ? "UNKNOWN" : block.reasonCode),
        });
      }
      return processed.cleanPublicText;
    };
    const cleanProgressText = (rawText: string): string =>
      stripConsensusMarkers(taskCompiler.cleanPublicTranscript(rawText));
    const customizationsFor = (providerId: string): PromptCustomizations => ({
      ...(options.promptCustomizations?.[providerId] ?? {}),
      ...(memoryContext?.projectBrief ? { projectBrief: memoryContext.projectBrief } : {}),
      ...(memoryContext?.decisionLedger ? { decisionLedger: memoryContext.decisionLedger } : {}),
    });
    const askInPhase = async (
      providerId: string,
      envelope: Omit<ProviderTurnEnvelopeV1, "protocolVersion" | "role" | "customInstructions">,
      phase: RunPhase,
      round: number,
      turnAttachments?: AttachmentRefV1[],
    ): Promise<string> => {
      this.assertWithinLimits(startedAt, limits);
      const directive = await options.contextHooks?.beforeTurn?.({
        projectId,
        runId,
        providerId,
        phase,
        round,
        charsSent,
      });
      const conversation = repository.getOrCreateConversation(projectId, providerId);
      const protocolPlan = protocolStates.plan(providerId, conversation.id, protocolIdentity);
      const preparedMessage = buildProviderTurnPrompt(
        {
          ...envelope,
          ...(directive?.continuationPrompt
            ? { continuationInstruction: directive.continuationPrompt }
            : {}),
        },
        COLLABORATION_PROTOCOL_VERSION,
        protocolPlan,
        customizationsFor(providerId),
      );
      charsSent += preparedMessage.length;
      const responseEntryId = newId("entry");
      responseEntryIds.set(`${providerId}:${phase}:${round}`, responseEntryId);
      const rawText = await this.ask(
        projectId,
        repository,
        providerId,
        preparedMessage,
        limits,
        hooks,
        phase,
        cleanProgressText,
        turnAttachments,
        persistedUserMessageId,
        responseEntryId,
        runId,
        round,
      );
      protocolStates.markInitialized(
        providerId,
        conversation.id,
        protocolIdentity,
        memoryContext?.checkpointId,
      );
      await options.contextHooks?.onTurnCompleted?.({
        projectId,
        runId,
        providerId,
        phase,
        round,
        responseText: rawText,
      });
      return rawText;
    };
    const initialMessage = task;
    const responses: RunOutput["responses"] = [];
    const startedAt = Date.now();
    const runMetrics = new QualityMetrics(this.database);
    let consensusReached = false;
    const persistStoppedMarker = (): void => {
      const markerId = `entry_stopped_${runId}`;
      repository.upsertConversationEntry({
        id: markerId,
        projectId,
        runId,
        role: "SYSTEM",
        content: "Обсуждение остановлено пользователем",
      });
    };

    logEvent("INFO", "orchestration.run.started", {
      runId,
      projectId,
      mode: effectiveMode,
      providers: providerIds,
      taskLength: task.length,
      turnLimit: effectiveMode === "SEQUENTIAL" ? providerIds.length : limits.maxTurns,
      taskComplexity,
    });

    try {
      this.setStatus(runId, "RUNNING");
      memoryContext = await options.contextHooks?.loadPromptContext?.({ projectId, runId });
      const existingUserEntry = userMessageId
        ? repository.conversationEntryById(userMessageId)
        : null;
      if (existingUserEntry && (
        existingUserEntry.projectId !== projectId
        || existingUserEntry.role !== "USER"
        || existingUserEntry.content !== task
      )) {
        throw new Error("Saved message id belongs to different project content");
      }
      const userEntry = existingUserEntry ?? repository.appendConversationEntry({
        ...(userMessageId ? { id: userMessageId } : {}),
        projectId,
        runId,
        role: "USER",
        content: task,
      });
      persistedUserMessageId = userEntry.id;
      let outcome: RunOutcome = "COMPLETED";
      let finalResponse: RunOutput["finalResponse"];
      const persistResponse = (response: RunOutput["responses"][number]): void => {
        responses.push(response);
        const entryId = responseEntryIds.get(
          `${response.sourceProviderId ?? response.providerId}:${response.phase ?? "DISCUSSION"}:${response.round}`,
        );
        const entry = {
          projectId,
          runId,
          role: "ASSISTANT",
          providerId: response.providerId,
          round: response.round,
          content: response.text,
        } as const;
        if (entryId) repository.upsertConversationEntry({ id: entryId, ...entry });
        else repository.appendConversationEntry(entry);
      };

      if (effectiveMode === "PARALLEL") {
        const independent = providerIds.map(async (providerId) => {
          const rawText = await this.withSessionLimit(
            startedAt,
            limits,
            askInPhase(
              providerId,
              {
                runId,
                round: 1,
                mode: effectiveMode,
                phase: "DISCUSSION",
                task: initialMessage,
                ...buildRelevantContextField(memoryContext),
                ...buildAttachmentRefsField(attachments),
                outputContract: { kind: "WORKING_ANSWER" },
              },
              "DISCUSSION",
              1,
              attachments,
            ),
          );
          const response: RunOutput["responses"][number] = {
            providerId,
            text: processModelText(rawText),
            round: 1,
            phase: "DISCUSSION",
          };
          persistResponse(response);
          return response;
        });
        try {
          await Promise.all(independent);
        } catch (error) {
          // Promise.all rejects on the first provider failure; do not wait for
          // unrelated peers to reach their individual/session timeout.
          await this.cancelActiveTurns();
          throw error;
        }
      } else if (effectiveMode === "MANUAL") {
        const providerId = providerIds[0]!;
        const rawText = await this.withSessionLimit(
          startedAt,
          limits,
          askInPhase(
            providerId,
            {
              runId,
              round: 1,
              mode: effectiveMode,
              phase: "DISCUSSION",
              task: initialMessage,
              ...buildRelevantContextField(memoryContext),
              ...buildAttachmentRefsField(attachments),
              outputContract: { kind: "FINAL_ANSWER" },
            },
            "DISCUSSION",
            1,
            attachments,
          ),
        );
        const response: RunOutput["responses"][number] = {
          providerId,
          text: processModelText(rawText),
          round: 1,
          phase: "DISCUSSION",
          final: true,
        };
        persistResponse(response);
        finalResponse = {
          providerId: providerIds[0]!,
          text: response.text,
          round: 1,
        };
      } else {
        const seen = new Set<string>();
        const consensusToken = `[[G_PLUS_G_DONE:${runId}]]`;
        const agreedProviders = new Set<string>();
        const requestedTurnLimit = effectiveMode === "SEQUENTIAL" ? providerIds.length : limits.maxTurns;
        const turnLimit = discussionTurnBudget({
          requestedTurns: requestedTurnLimit,
          providerCount: providerIds.length,
          complexity: taskComplexity,
        });
        let termination: "COMPLETED" | "CONSENSUS" | "DUPLICATE" | "LIMIT" | "USER_STOPPED" =
          effectiveMode === "DEBATE" ? "LIMIT" : "COMPLETED";
        for (let turn = 0; turn < turnLimit; turn += 1) {
          await this.waitIfPaused();
          this.assertWithinLimits(startedAt, limits);
          if (this.stopped) {
            termination = "USER_STOPPED";
            break;
          }
          const providerId = providerIds[turn % providerIds.length]!;
          const previous = responses.at(-1);
          const message: Omit<ProviderTurnEnvelopeV1, "protocolVersion" | "role" | "customInstructions"> = {
            runId,
            round: turn + 1,
            mode: effectiveMode,
            phase: "DISCUSSION",
            task: initialMessage,
            ...buildRelevantContextField(memoryContext),
            ...(previous ? { peerContribution: compactPeer(previous.providerId, previous.text) } : {}),
            ...(turn < providerIds.length ? buildAttachmentRefsField(attachments) : {}),
            outputContract: {
              kind: "WORKING_ANSWER",
              ...(effectiveMode === "DEBATE" ? { consensusToken } : {}),
              maxChars: 12_000,
            },
          };
          const rawText = await this.withSessionLimit(
            startedAt,
            limits,
            askInPhase(
              providerId,
              message,
              "DISCUSSION",
              turn + 1,
              turn < providerIds.length ? attachments : undefined,
            ),
          );
          const agreed =
            effectiveMode === "DEBATE" && hasTerminalConsensusMarker(rawText, consensusToken);
          const text = processModelText(stripConsensusMarkers(rawText));
          if (agreed) agreedProviders.add(providerId);
          else agreedProviders.delete(providerId);
          persistResponse({
            providerId,
            text,
            round: turn + 1,
            agreed,
            phase: "DISCUSSION",
          });
          if (
            effectiveMode === "DEBATE" &&
            providerIds.every((candidate) => agreedProviders.has(candidate))
          ) {
            consensusReached = true;
            termination = "CONSENSUS";
            break;
          }
          const hash = fingerprint(text);
          if (seen.has(hash)) {
            termination = "DUPLICATE";
            break;
          }
          seen.add(hash);
          if (
            limits.requireConfirmation === true &&
            turn + 1 < turnLimit &&
            (turn + 1) % limits.confirmationEvery === 0 &&
            hooks.confirm
          ) {
            this.setStatus(runId, "AWAITING_CONFIRMATION");
            if (!(await hooks.confirm(`Continue after ${turn + 1} turns?`))) {
              termination = "USER_STOPPED";
              break;
            }
            this.setStatus(runId, "RUNNING");
          }
        }
        if (termination === "USER_STOPPED" || this.stopped) outcome = "USER_STOPPED";
        else if (termination === "CONSENSUS") outcome = "CONSENSUS_REACHED";
        else if (termination === "LIMIT") outcome = taskComplexity === "TRIVIAL" ? "COMPLETED" : "LIMIT_REACHED";
        else if (termination === "DUPLICATE") outcome = "NO_CONSENSUS";
      }

      if (effectiveMode !== "MANUAL" && outcome !== "USER_STOPPED" && responses.length > 0) {
        const finalizerProviderId = selectedFinalizerProvider;
        const finalRound = responses.length + 1;
        const finalRawText = await this.withSessionLimit(
          startedAt,
          limits,
          askInPhase(
            finalizerProviderId,
            {
              runId,
              round: finalRound,
              mode: effectiveMode,
              phase: "FINALIZE",
              task: initialMessage,
              ...buildRelevantContextField(memoryContext),
              candidates: compactCandidates(responses),
              outputContract: { kind: "FINAL_ANSWER", discussionOutcome: outcome },
            },
            "FINALIZE",
            finalRound,
          ),
        );
        const finalText = processModelText(stripConsensusMarkers(finalRawText));
        persistResponse({
          providerId: "final",
          sourceProviderId: finalizerProviderId,
          text: finalText,
          round: finalRound,
          phase: "FINALIZE",
          final: true,
        });
        finalResponse = {
          providerId: "final",
          finalizerProviderId,
          text: finalText,
          round: finalRound,
        };
      }

      const status: RunStatus = outcome === "USER_STOPPED" || this.stopped ? "STOPPED" : "COMPLETED";
      if (status === "STOPPED") persistStoppedMarker();
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
        outcome,
        elapsedMs: Date.now() - startedAt,
      });
      await options.contextHooks?.onRunCompleted?.({
        projectId,
        runId,
        outcome,
        ...(memoryContext?.checkpointId ? { checkpointId: memoryContext.checkpointId } : {}),
      });
      return {
        runId,
        status,
        responses,
        consensusReached,
        outcome,
        ...(finalResponse ? { finalResponse } : {}),
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
        persistStoppedMarker();
        this.setStatus(runId, "STOPPED");
        runMetrics.record("orchestration.run.success", 0, { mode: effectiveMode });
        runMetrics.record("orchestration.run.elapsed_ms", Date.now() - startedAt, {
          mode: effectiveMode,
        });
        await options.contextHooks?.onRunCompleted?.({
          projectId,
          runId,
          outcome: "USER_STOPPED",
          ...(memoryContext?.checkpointId ? { checkpointId: memoryContext.checkpointId } : {}),
        });
        return { runId, status: "STOPPED", responses, outcome: "USER_STOPPED" };
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
    phase: RunPhase,
    sanitizeProgress: (text: string) => string,
    attachments?: AttachmentRefV1[],
    messageId?: string,
    responseMessageId?: string,
    runId?: string,
    round?: number,
  ): Promise<string> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Adapter is not registered: ${providerId}`);
    const edited = hooks.editBeforeSend
      ? await hooks.editBeforeSend(providerId, message)
      : message;
    const conversation = repository.getOrCreateConversation(projectId, providerId);
    let attachmentSubmission: ProviderSubmission | undefined;
    let attachmentDeliveries: AttachmentDelivery[] = [];
    if (attachments && attachments.length > 0) {
      if (!messageId) throw new Error("Attachments require a persisted user message id");
      if (attachments.some((attachment) => attachment.messageId !== messageId)) {
        throw new Error("Attachment/message binding mismatch");
      }
      const submissionManager = new ProviderSubmissionManager(this.database.raw);
      attachmentSubmission = submissionManager.createSubmission(
        messageId,
        providerId,
        attachments.map((attachment) => attachment.id),
      );
      if (attachmentSubmission.state !== "PREPARING") {
        throw new Error(
          `Provider submission ${attachmentSubmission.submissionId} is ${attachmentSubmission.state}; manual reconciliation is required`,
        );
      }
      const deliveryManager = new AttachmentDeliveryManager(this.database.raw);
      attachmentDeliveries = attachments.map((attachment) =>
        deliveryManager.getOrCreateDelivery(attachment.id, providerId, conversation.id),
      );
      for (const delivery of attachmentDeliveries) {
        if (delivery.status === "DELIVERED" || delivery.status === "UNSUPPORTED") {
          throw new Error(`Attachment delivery ${delivery.id} is already terminal: ${delivery.status}`);
        }
        deliveryManager.updateDeliveryStatus(delivery.id, "UPLOADING");
      }
    }
    const markAttachmentSubmissionUnknown = (): void => {
      if (!attachmentSubmission) return;
      const deliveryManager = new AttachmentDeliveryManager(this.database.raw);
      for (const delivery of attachmentDeliveries) {
        try {
          deliveryManager.updateDeliveryStatus(delivery.id, "FAILED");
        } catch {
          // Preserve the original provider error; terminal/concurrent states are
          // recoverable through the persisted evidence.
        }
      }
      const submissionManager = new ProviderSubmissionManager(this.database.raw);
      try {
        submissionManager.markUnknown(attachmentSubmission.submissionId);
      } catch {
        // The state record remains the authority if another observer advanced it.
      }
    };
    const markAttachmentFilesUploaded = (attachmentIds: readonly string[] | undefined): void => {
      if (!attachmentSubmission) return;
      const expected = [...attachmentSubmission.attachmentIds].sort();
      const actual = [...new Set(attachmentIds ?? [])].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Provider upload evidence does not match the submitted attachment set");
      const deliveryManager = new AttachmentDeliveryManager(this.database.raw);
      for (const delivery of attachmentDeliveries) {
        deliveryManager.updateDeliveryStatus(delivery.id, "DELIVERED");
      }
      const submissionManager = new ProviderSubmissionManager(this.database.raw);
      submissionManager.updateState(attachmentSubmission.submissionId, "FILES_UPLOADED");
    };
    const markAttachmentMessageSubmitted = (): void => {
      if (!attachmentSubmission) return;
      const submissionManager = new ProviderSubmissionManager(this.database.raw);
      submissionManager.updateState(attachmentSubmission.submissionId, "SUBMITTED");
    };
    const confirmAttachmentSubmission = (): void => {
      if (!attachmentSubmission) return;
      const submissionManager = new ProviderSubmissionManager(this.database.raw);
      submissionManager.updateState(attachmentSubmission.submissionId, "CONFIRMED");
    };
    logEvent("INFO", "provider.turn.preparing", {
      runId: this.activeRunId,
      projectId,
      providerId,
      conversationId: conversation.id,
      hasExternalRef: Boolean(conversation.externalRef),
      messageLength: edited.length,
    });
    await this.prepareWebConversation(adapter, repository, conversation.id, conversation.externalRef);
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
        const responseArtifactTarget = responseMessageId ? { projectId, messageId: responseMessageId } : undefined;
        turn = await adapter.sendMessage({
          content: edited,
          ...(attachments ? { attachments } : {}),
          ...(responseArtifactTarget ? { responseArtifactTarget } : {}),
        });
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
        markAttachmentSubmissionUnknown();
        repository.finishAttempt(
          attempt.id,
          "FAILED",
          error instanceof Error ? error.message : String(error),
        );
        if (
          attemptIndex === limits.maxRetries ||
          isNonRetryableTurnError(error) ||
          Boolean(attachmentSubmission)
        ) {
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
                if (event.type === "ATTACHMENTS_UPLOADED") {
                  markAttachmentFilesUploaded(event.attachmentIds);
                } else if (event.type === "MESSAGE_SUBMITTED") {
                  markAttachmentMessageSubmitted();
                } else if (event.type === "RESPONSE_UPDATED" && event.text) {
                  const cleanText = sanitizeProgress(event.text);
                  if (responseMessageId && cleanText.trim()) {
                    repository.upsertConversationEntry({
                      id: responseMessageId,
                      projectId,
                      runId: runId ?? this.activeRunId,
                      role: "ASSISTANT",
                      providerId,
                      round: round ?? null,
                      content: cleanText,
                    });
                  }
                  const progress: RunProgressEvent = {
                    projectId,
                    runId: this.activeRunId ?? "unknown-run",
                    turnId: started.turn.id,
                    providerId,
                    phase,
                    text: cleanText,
                  };
                  hooks.onResponseUpdate?.(providerId, progress.text, progress);
                  hooks.onProgress?.(progress);
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
          if (attachmentSubmission) throw error;
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
        // Observation is part of the turn contract and must not be able to
        // outlive the same turn deadline after the final result resolves.
        await Promise.race([observePromise, timeout]);
        if (timer) clearTimeout(timer);
        confirmAttachmentSubmission();
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
        await observePromise.catch((observationError) => {
          logEvent("ERROR", "provider.turn.observation_failed", {
            runId: this.activeRunId,
            providerId,
            turnId: started.turn.id,
            error: observationError,
          });
        });
        await adapter.cancel(turn).catch(() => undefined);
        markAttachmentSubmissionUnknown();
        repository.finishAttempt(
          attempt.id,
          this.stopped ? "INTERRUPTED" : "FAILED",
          error instanceof Error ? error.message : String(error),
        );
        repository.updateTurnStatus(started.turn.id, this.stopped ? "CANCELLED" : "FAILED");
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
    repository: ProjectRepository,
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
      try {
        await adapter.openConversation(ref);
      } catch (error) {
        if (!(error instanceof ConversationUnavailableError)) throw error;
        logEvent("WARN", "provider.conversation.remote_unavailable", {
          runId: this.activeRunId,
          providerId: adapter.providerId,
          conversationId,
        });
        repository.clearConversationExternalRef(conversationId);
        const created = await adapter.createConversation();
        if (created.url) repository.updateConversationExternalRef(conversationId, created.url);
      }
    } else {
      logEvent("INFO", "provider.conversation.creating", {
        runId: this.activeRunId,
        providerId: adapter.providerId,
        conversationId,
      });
      const created = await adapter.createConversation();
      if (created.url) repository.updateConversationExternalRef(conversationId, created.url);
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
  return /target (page|context|browser).*closed|turn cancelled|profile is already in use|manual reconciliation is required/i.test(
    message,
  );
}

function buildRelevantContextField(memoryContext: PromptMemoryContext | undefined):
  Pick<ProviderTurnEnvelopeV1, "relevantContext"> | Record<string, never> {
  if (!memoryContext?.projectBrief && !memoryContext?.decisionLedger?.length && !memoryContext?.checkpointId) {
    return {};
  }
  return {
    relevantContext: {
      ...(memoryContext.projectBrief ? { projectBrief: memoryContext.projectBrief } : {}),
      ...(memoryContext.decisionLedger?.length ? { acceptedDecisions: memoryContext.decisionLedger } : {}),
      ...(memoryContext.checkpointId ? { checkpointRevision: memoryContext.checkpointId } : {}),
    },
  };
}

function buildAttachmentRefsField(attachments: readonly AttachmentRefV1[] | undefined):
  Pick<ProviderTurnEnvelopeV1, "attachmentRefs"> | Record<string, never> {
  const attachmentRefs = attachmentEnvelopeRefs(attachments);
  return attachmentRefs?.length ? { attachmentRefs } : {};
}

function normalizeRunOptions(
  limitsOrOptions: OrchestrationLimits | RunOptions,
  legacyHooks: RunHooks,
  legacyAttachments?: AttachmentRefV1[],
): RunOptions {
  if ("maxTurns" in limitsOrOptions) {
    return {
      limits: limitsOrOptions,
      hooks: legacyHooks,
      ...(legacyAttachments ? { attachments: legacyAttachments } : {}),
    };
  }
  const normalizedAttachments = limitsOrOptions.attachments ?? legacyAttachments;
  return {
    ...limitsOrOptions,
    limits: limitsOrOptions.limits ?? defaultLimits,
    hooks: limitsOrOptions.hooks ?? legacyHooks,
    ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}),
  };
}

function validateOptionalMessageId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  if (!clean) throw new Error("userMessageId cannot be empty");
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(clean)) {
    throw new Error("userMessageId contains unsupported characters or exceeds 200 characters");
  }
  return clean;
}

function selectFinalizerProvider(providerIds: string[], options: RunOptions): string {
  const mode = options.finalizerMode ?? "MANUAL";
  if (!(["MANUAL", "LEAD_SELECTS", "PEER_AGREEMENT"] as const).includes(mode)) {
    throw new Error(`Invalid finalizer mode: ${String(mode)}`);
  }
  if (mode === "MANUAL" && options.finalResponder && options.finalResponder !== "auto") {
    if (!providerIds.includes(options.finalResponder)) {
      throw new Error(`Final responder is not participating in this run: ${options.finalResponder}`);
    }
    return options.finalResponder;
  }
  // The first provider is the stable lead. PEER_AGREEMENT controls the
  // discussion outcome; the lead renders the already agreed candidates.
  return providerIds[0]!;
}
