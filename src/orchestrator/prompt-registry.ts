import { DatabaseSync } from "node:sqlite";
import { PRODUCTIVE_PROTOCOL_V1 } from "./productive-protocol.js";

export type PromptVersionStatus = "DRAFT" | "EVALUATING" | "APPROVED" | "ACTIVE" | "RETIRED";

export interface PromptVersionRecord {
  id: string;
  version: string;
  templateText: string;
  status: PromptVersionStatus;
  createdAt: string;
}

export interface PromptChangeProposal {
  id: string;
  baseVersion: string;
  observedProblem: string;
  evidenceMessageIds: string[];
  proposedDiff: string;
  expectedEffect: string;
  regressionRisks: string[];
  evaluationCases: string[];
  status: "DRAFT" | "APPROVED" | "REJECTED";
  createdAt: string;
}

export interface RunEvaluationRecord {
  id: string;
  runId: string;
  projectId: string;
  promptVersion: string;
  totalTurns: number;
  lowValueTurns: number;
  cliTasksCount: number;
  rejectedTasksCount: number;
  retriesCount: number;
  userInterventionsCount: number;
  cancelledDecisionsCount: number;
  acceptancePassed: boolean;
  rolloverCount: number;
  errorsCount: number;
  userRating?: number | null;
  evaluatedAt: string;
}

export class PromptRegistry {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.ensureDefaultActiveVersion();
  }

  private ensureDefaultActiveVersion(): void {
    const existing = this.db.prepare(
      "SELECT * FROM prompt_versions WHERE status = 'ACTIVE' LIMIT 1"
    ).get();

    if (!existing) {
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO prompt_versions (id, version, template_text, status, created_at)
         VALUES ('pv_v1_default', 'v1.0.0', ?, 'ACTIVE', ?)`
      ).run(PRODUCTIVE_PROTOCOL_V1, now);
    }
  }

  public getActivePromptVersion(): PromptVersionRecord {
    const row = this.db.prepare(
      "SELECT * FROM prompt_versions WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1"
    ).get() as Record<string, unknown>;

    return {
      id: String(row.id),
      version: String(row.version),
      templateText: String(row.template_text),
      status: row.status as PromptVersionStatus,
      createdAt: String(row.created_at),
    };
  }

  public recordRunEvaluation(evalData: Omit<RunEvaluationRecord, "id" | "evaluatedAt">): RunEvaluationRecord {
    const now = new Date().toISOString();
    const id = `runeval_${evalData.runId}`;

    this.db.prepare(
      `INSERT INTO run_evaluations (id, run_id, project_id, prompt_version, total_turns, low_value_turns, cli_tasks_count, rejected_tasks_count, retries_count, user_interventions_count, cancelled_decisions_count, acceptance_passed, rollover_count, errors_count, user_rating, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      evalData.runId,
      evalData.projectId,
      evalData.promptVersion,
      evalData.totalTurns,
      evalData.lowValueTurns,
      evalData.cliTasksCount,
      evalData.rejectedTasksCount,
      evalData.retriesCount,
      evalData.userInterventionsCount,
      evalData.cancelledDecisionsCount,
      evalData.acceptancePassed ? 1 : 0,
      evalData.rolloverCount,
      evalData.errorsCount,
      evalData.userRating || null,
      now
    );

    return {
      id,
      evaluatedAt: now,
      ...evalData,
    };
  }

  public createChangeProposal(
    proposalData: Omit<PromptChangeProposal, "id" | "status" | "createdAt">
  ): PromptChangeProposal {
    const now = new Date().toISOString();
    const id = `prop_${Date.now()}`;

    this.db.prepare(
      `INSERT INTO prompt_change_proposals (id, base_version, observed_problem, evidence_message_ids_json, proposed_diff, expected_effect, regression_risks_json, evaluation_cases_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`
    ).run(
      id,
      proposalData.baseVersion,
      proposalData.observedProblem,
      JSON.stringify(proposalData.evidenceMessageIds),
      proposalData.proposedDiff,
      proposalData.expectedEffect,
      JSON.stringify(proposalData.regressionRisks),
      JSON.stringify(proposalData.evaluationCases),
      now
    );

    return {
      id,
      status: "DRAFT",
      createdAt: now,
      ...proposalData,
    };
  }

  public approveChangeProposal(proposalId: string, newVersion: string, newTemplateText: string): PromptVersionRecord {
    const now = new Date().toISOString();

    // Mark proposal approved
    this.db.prepare(
      "UPDATE prompt_change_proposals SET status = 'APPROVED' WHERE id = ?"
    ).run(proposalId);

    // Retire old active versions
    this.db.prepare(
      "UPDATE prompt_versions SET status = 'RETIRED' WHERE status = 'ACTIVE'"
    ).run();

    // Insert new active prompt version
    const versionId = `pv_${newVersion.replace(/\./g, "_")}`;
    this.db.prepare(
      `INSERT INTO prompt_versions (id, version, template_text, status, created_at)
       VALUES (?, ?, ?, 'ACTIVE', ?)`
    ).run(versionId, newVersion, newTemplateText, now);

    return this.getActivePromptVersion();
  }

  public rollbackToVersion(targetVersion: string): PromptVersionRecord {
    const target = this.db.prepare(
      "SELECT * FROM prompt_versions WHERE version = ?"
    ).get(targetVersion) as Record<string, unknown> | undefined;

    if (!target) {
      throw new Error(`Cannot rollback: prompt version '${targetVersion}' does not exist in registry`);
    }

    this.db.prepare("UPDATE prompt_versions SET status = 'RETIRED' WHERE status = 'ACTIVE'").run();
    this.db.prepare("UPDATE prompt_versions SET status = 'ACTIVE' WHERE version = ?").run(targetVersion);

    return this.getActivePromptVersion();
  }
}
