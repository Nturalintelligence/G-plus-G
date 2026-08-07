import { describe, expect, it, beforeEach } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { ContextBudgetEstimator, ContextRolloverManager, ContinuationPackV1 } from "../src/context/context-rollover.js";
import { ThreeTierMemoryManager, MemoryItem } from "../src/context/three-tier-memory.js";

describe("Phase G: Context Compression & Web Chat Rollover", () => {
  let appDb: AppDatabase;
  let rolloverManager: ContextRolloverManager;
  let memoryManager: ThreeTierMemoryManager;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:");
    appDb.migrate();
    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('proj-g', 'Rollover Project', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();
    rolloverManager = new ContextRolloverManager(appDb.raw);
    memoryManager = new ThreeTierMemoryManager(appDb.raw);
  });

  it("should estimate context budget thresholds accurately", () => {
    const estimator = new ContextBudgetEstimator(100_000);

    const b1 = estimator.estimateBudget({ totalCharsSent: 10_000, turnCount: 2, briefSizeChars: 1000 });
    expect(b1.status).toBe("OK");

    const b2 = estimator.estimateBudget({ totalCharsSent: 60_000, turnCount: 10, briefSizeChars: 1000 });
    expect(b2.status).toBe("WARN");

    const b3 = estimator.estimateBudget({ totalCharsSent: 70_000, turnCount: 15, briefSizeChars: 1000 });
    expect(b3.status).toBe("PREPARE_CHECKPOINT");

    const b4 = estimator.estimateBudget({ totalCharsSent: 82_000, turnCount: 20, briefSizeChars: 1000 });
    expect(b4.status).toBe("ROLLOVER_REQUIRED");
  });

  it("should compile valid ContinuationPackV1 with SHA-256 checksum", () => {
    const item1 = memoryManager.addMemoryItem("proj-g", "CONSTRAINT", "No raw passwords in logs");
    const item2 = memoryManager.addMemoryItem("proj-g", "DECISION_ACCEPTED", "Use SQLite storage");

    const pack = rolloverManager.createContinuationPack({
      projectId: "proj-g",
      previousConversationId: "conv-old-123",
      objective: "Build local-first orchestrator",
      activeMemoryItems: [item1, item2],
      completedWork: ["Created migrations"],
      openTasks: ["Add task card UI"],
      failedAttempts: [],
      nextAction: "Execute task card UI implementation",
    });

    expect(pack.protocol).toBe("gplusg.continuation");
    expect(pack.constraints).toContain("No raw passwords in logs");
    expect(pack.decisions).toContain("Use SQLite storage");
    expect(pack.checksum).toBeDefined();
    expect(pack.checksum.length).toBe(64);
  });

  it("should reject checkpoint validation if active constraints or open tasks are missing", () => {
    const itemConstraint = memoryManager.addMemoryItem("proj-g", "CONSTRAINT", "Strict TypeScript checking");

    const pack = rolloverManager.createContinuationPack({
      projectId: "proj-g",
      previousConversationId: "conv-old-123",
      objective: "Build local-first orchestrator",
      activeMemoryItems: [itemConstraint],
      completedWork: [],
      openTasks: ["Task A"],
      failedAttempts: [],
      nextAction: "Execute Task A",
    });

    // Valid check
    expect(() => {
      rolloverManager.validateCheckpoint(pack, [itemConstraint], ["Task A"]);
    }).not.toThrow();

    // Invalid check: missing constraint
    const corruptedPack: ContinuationPackV1 = { ...pack, constraints: [] };
    expect(() => {
      rolloverManager.validateCheckpoint(corruptedPack, [itemConstraint], ["Task A"]);
    }).toThrow(/active constraint 'Strict TypeScript checking' missing/);
  });

  it("should save checkpoint into SQLite context_checkpoints table", () => {
    const pack = rolloverManager.createContinuationPack({
      projectId: "proj-g",
      previousConversationId: "conv-old-123",
      objective: "Build local-first orchestrator",
      activeMemoryItems: [],
      completedWork: [],
      openTasks: [],
      failedAttempts: [],
      nextAction: "Synthesize findings",
    });

    rolloverManager.saveCheckpoint(pack, "run-g-1");

    const row = appDb.raw.prepare("SELECT * FROM context_checkpoints WHERE checkpoint_id = ?").get(pack.checkpointId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.project_id).toBe("proj-g");
  });

  it("should validate handshake response from model after continuation pack prompt", () => {
    const pack = rolloverManager.createContinuationPack({
      projectId: "proj-g",
      previousConversationId: "conv-old-123",
      objective: "Build local-first desktop application orchestrator",
      activeMemoryItems: [],
      completedWork: [],
      openTasks: [],
      failedAttempts: [],
      nextAction: "Execute task card UI implementation",
    });

    const goodHandshake = `
HANDSHAKE CONFIRMATION
Objective: Build local-first desktop application orchestrator
Current State: Continuation pack loaded.
Next Action: Execute task card UI implementation
`;

    const resGood = rolloverManager.validateHandshake(goodHandshake, pack);
    expect(resGood.match).toBe(true);

    const badHandshake = `Hello, how can I help you today?`;
    const resBad = rolloverManager.validateHandshake(badHandshake, pack);
    expect(resBad.match).toBe(false);
    expect(resBad.diffs.length).toBeGreaterThan(0);
  });
});
