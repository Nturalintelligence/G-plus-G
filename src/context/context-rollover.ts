import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MemoryItem } from "./three-tier-memory.js";

export interface ContinuationPackV1 {
  protocol: "gplusg.continuation";
  version: 1;
  projectId: string;
  checkpointId: string;
  previousConversationId: string;
  objective: string;
  constraints: string[];
  decisions: string[];
  rejectedOptions: string[];
  completedWork: string[];
  artifacts: string[];
  openTasks: string[];
  failedAttempts: string[];
  acceptanceCriteria: string[];
  nextAction: string;
  sourceMessageIds: string[];
  checksum: string;
}

export type BudgetStatus = "OK" | "WARN" | "PREPARE_CHECKPOINT" | "ROLLOVER_REQUIRED";

export interface BudgetEstimation {
  status: BudgetStatus;
  percentageUsed: number;
  totalChars: number;
  estimatedTokens: number;
  reason: string;
}

export class ContextBudgetEstimator {
  private defaultMaxChars: number;

  constructor(defaultMaxChars = 100_000) {
    this.defaultMaxChars = defaultMaxChars;
  }

  public estimateBudget(stats: {
    totalCharsSent: number;
    turnCount: number;
    briefSizeChars: number;
    customMaxChars?: number;
  }): BudgetEstimation {
    const maxChars = stats.customMaxChars || this.defaultMaxChars;
    const totalChars = stats.totalCharsSent + stats.briefSizeChars;
    const estimatedTokens = Math.round(totalChars / 4);

    const percentageUsed = Math.min(100, Math.round((totalChars / maxChars) * 100));

    let status: BudgetStatus = "OK";
    let reason = "Context budget within safe bounds";

    if (percentageUsed >= 80 || stats.turnCount >= 25) {
      status = "ROLLOVER_REQUIRED";
      reason = "Context utilization at or above 80% (or 25+ turns). Web chat rollover required.";
    } else if (percentageUsed >= 70) {
      status = "PREPARE_CHECKPOINT";
      reason = "Context utilization at 70%. Prepare checkpoint candidate.";
    } else if (percentageUsed >= 60) {
      status = "WARN";
      reason = "Context utilization at 60%. Approaching rollover threshold.";
    }

    return {
      status,
      percentageUsed,
      totalChars,
      estimatedTokens,
      reason,
    };
  }
}

export class ContextRolloverManager {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  public computeChecksum(packWithoutChecksum: Omit<ContinuationPackV1, "checksum">): string {
    const payload = JSON.stringify({
      projectId: packWithoutChecksum.projectId,
      checkpointId: packWithoutChecksum.checkpointId,
      objective: packWithoutChecksum.objective,
      decisions: packWithoutChecksum.decisions,
      constraints: packWithoutChecksum.constraints,
      openTasks: packWithoutChecksum.openTasks,
      acceptanceCriteria: packWithoutChecksum.acceptanceCriteria,
    });
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  public createContinuationPack(input: {
    projectId: string;
    previousConversationId: string;
    objective: string;
    activeMemoryItems: MemoryItem[];
    completedWork: string[];
    openTasks: string[];
    failedAttempts: string[];
    nextAction: string;
  }): ContinuationPackV1 {
    const checkpointId = `chk_${input.projectId}_${Date.now()}`;

    const constraints = input.activeMemoryItems.filter((m) => m.kind === "CONSTRAINT").map((m) => m.text);
    const decisions = input.activeMemoryItems.filter((m) => m.kind === "DECISION_ACCEPTED").map((m) => m.text);
    const rejectedOptions = input.activeMemoryItems.filter((m) => m.kind === "OPTION_REJECTED").map((m) => m.text);
    const artifacts = input.activeMemoryItems.filter((m) => m.kind === "ARTIFACT").map((m) => m.text);
    const acceptanceCriteria = input.activeMemoryItems.filter((m) => m.kind === "ACCEPTANCE_CRITERION").map((m) => m.text);

    const sourceMessageIds = Array.from(
      new Set(input.activeMemoryItems.flatMap((m) => m.sourceMessageIds || []))
    );

    const partialPack: Omit<ContinuationPackV1, "checksum"> = {
      protocol: "gplusg.continuation",
      version: 1,
      projectId: input.projectId,
      checkpointId,
      previousConversationId: input.previousConversationId,
      objective: input.objective,
      constraints,
      decisions,
      rejectedOptions,
      completedWork: input.completedWork,
      artifacts,
      openTasks: input.openTasks,
      failedAttempts: input.failedAttempts,
      acceptanceCriteria,
      nextAction: input.nextAction,
      sourceMessageIds,
    };

    const checksum = this.computeChecksum(partialPack);

    return {
      ...partialPack,
      checksum,
    };
  }

  /**
   * Validates continuation pack against required active constraints, open tasks, and acceptance criteria.
   * Throws Error if mandatory elements are missing.
   */
  public validateCheckpoint(
    pack: ContinuationPackV1,
    activeMemoryItems: MemoryItem[],
    openTasks: string[]
  ): void {
    const activeConstraints = activeMemoryItems.filter((m) => m.kind === "CONSTRAINT").map((m) => m.text);
    for (const c of activeConstraints) {
      if (!pack.constraints.includes(c)) {
        throw new Error(`Checkpoint validation failed: active constraint '${c}' missing from continuation pack`);
      }
    }

    for (const taskTitle of openTasks) {
      if (!pack.openTasks.includes(taskTitle)) {
        throw new Error(`Checkpoint validation failed: open task '${taskTitle}' missing from continuation pack`);
      }
    }

    const expectedChecksum = this.computeChecksum(pack);
    if (expectedChecksum !== pack.checksum) {
      throw new Error(`Checkpoint validation failed: checksum mismatch!`);
    }
  }

  public saveCheckpoint(pack: ContinuationPackV1, runId: string): void {
    const now = new Date().toISOString();
    const dbId = `chkrec_${pack.checkpointId}`;

    this.db.prepare(
      `INSERT INTO context_checkpoints (id, project_id, checkpoint_id, run_id, continuation_pack_json, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(dbId, pack.projectId, pack.checkpointId, runId, JSON.stringify(pack), pack.checksum, now);
  }

  /**
   * Performs handshake comparison on model's initial continuation response.
   */
  public validateHandshake(
    handshakeText: string,
    expectedPack: ContinuationPackV1
  ): { match: boolean; diffs: string[] } {
    const diffs: string[] = [];

    if (!handshakeText || typeof handshakeText !== "string") {
      return { match: false, diffs: ["Handshake response is empty"] };
    }

    const lowerHandshake = handshakeText.toLowerCase();
    const lowerObj = expectedPack.objective.toLowerCase();

    // Key objective check
    const objWords = lowerObj.split(/\s+/).filter((w) => w.length > 4);
    let matchedWords = 0;
    for (const word of objWords) {
      if (lowerHandshake.includes(word)) matchedWords++;
    }

    if (objWords.length > 0 && matchedWords / objWords.length < 0.4) {
      diffs.push(`Handshake objective mismatch: model response did not acknowledge core objective '${expectedPack.objective}'`);
    }

    // Next action check
    if (expectedPack.nextAction && expectedPack.nextAction.length > 3) {
      const lowerNext = expectedPack.nextAction.toLowerCase();
      if (!lowerHandshake.includes(lowerNext) && !lowerHandshake.includes("next action") && !lowerHandshake.includes("action")) {
        diffs.push(`Handshake next action mismatch: expected reference to '${expectedPack.nextAction}'`);
      }
    }

    return {
      match: diffs.length === 0,
      diffs,
    };
  }
}
