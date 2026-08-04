import { describe, expect, it, beforeEach } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { PromptRegistry } from "../src/orchestrator/prompt-registry.js";

describe("Phase H: Prompt Evaluation & Improvement System", () => {
  let appDb: AppDatabase;
  let registry: PromptRegistry;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:");
    appDb.migrate();
    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('proj-h', 'Eval Project', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();
    registry = new PromptRegistry(appDb.raw);
  });

  it("should initialize default active prompt version v1.0.0", () => {
    const active = registry.getActivePromptVersion();
    expect(active.version).toBe("v1.0.0");
    expect(active.status).toBe("ACTIVE");
  });

  it("should record run evaluation metrics cleanly", () => {
    const record = registry.recordRunEvaluation({
      runId: "run-h-1",
      projectId: "proj-h",
      promptVersion: "v1.0.0",
      totalTurns: 8,
      lowValueTurns: 1,
      cliTasksCount: 3,
      rejectedTasksCount: 0,
      retriesCount: 1,
      userInterventionsCount: 0,
      cancelledDecisionsCount: 0,
      acceptancePassed: true,
      rolloverCount: 0,
      errorsCount: 0,
      userRating: 5,
    });

    expect(record.id).toBe("runeval_run-h-1");
    expect(record.acceptancePassed).toBe(true);

    const row = appDb.raw.prepare("SELECT * FROM run_evaluations WHERE run_id = ?").get("run-h-1") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(Number(row.total_turns)).toBe(8);
  });

  it("should create DRAFT proposal and require explicit approval to activate new version", () => {
    const proposal = registry.createChangeProposal({
      baseVersion: "v1.0.0",
      observedProblem: "Models occasionally emit verbose chain-of-thought",
      evidenceMessageIds: ["msg-101"],
      proposedDiff: "- reveal thought\n+ concise reasons only",
      expectedEffect: "Reduces token cost by 15%",
      regressionRisks: ["May omit rationale"],
      evaluationCases: ["Test turn 1"],
    });

    expect(proposal.status).toBe("DRAFT");

    // Active version remains v1.0.0 before user approval
    expect(registry.getActivePromptVersion().version).toBe("v1.0.0");

    // User approves proposal
    const updatedActive = registry.approveChangeProposal(
      proposal.id,
      "v1.1.0",
      "G+G PRODUCTIVE COLLABORATION PROTOCOL v1.1"
    );

    expect(updatedActive.version).toBe("v1.1.0");
    expect(updatedActive.status).toBe("ACTIVE");
    expect(registry.getActivePromptVersion().templateText).toContain("v1.1");
  });

  it("should support rollback to previous active version", () => {
    const proposal = registry.createChangeProposal({
      baseVersion: "v1.0.0",
      observedProblem: "Minor issue",
      evidenceMessageIds: [],
      proposedDiff: "diff",
      expectedEffect: "improvement",
      regressionRisks: [],
      evaluationCases: [],
    });

    registry.approveChangeProposal(proposal.id, "v1.1.0", "Version 1.1 text");
    expect(registry.getActivePromptVersion().version).toBe("v1.1.0");

    // Rollback to v1.0.0
    const rolledBack = registry.rollbackToVersion("v1.0.0");
    expect(rolledBack.version).toBe("v1.0.0");
    expect(rolledBack.status).toBe("ACTIVE");
  });
});
