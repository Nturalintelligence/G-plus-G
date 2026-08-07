import { describe, expect, it, beforeEach } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { ThreeTierMemoryManager } from "../src/context/three-tier-memory.js";

describe("Phase F: Three-Tier Memory System", () => {
  let appDb: AppDatabase;
  let memoryManager: ThreeTierMemoryManager;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:");
    appDb.migrate();
    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('proj-f', 'Memory Test Project', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();
    memoryManager = new ThreeTierMemoryManager(appDb.raw);
  });

  it("should add structured memory items and query active items", () => {
    const item1 = memoryManager.addMemoryItem(
      "proj-f",
      "REQUIREMENT",
      "Must support SQLite storage",
      ["msg-1"]
    );
    expect(item1.kind).toBe("REQUIREMENT");
    expect(item1.status).toBe("ACTIVE");

    const activeReqs = memoryManager.getActiveMemoryItems("proj-f", "REQUIREMENT");
    expect(activeReqs).toHaveLength(1);
    const firstReq = activeReqs[0];
    expect(firstReq).toBeDefined();
    expect(firstReq?.text).toBe("Must support SQLite storage");
  });

  it("should handle decision supersession cleanly without silent overwrite", () => {
    const origDecision = memoryManager.addMemoryItem(
      "proj-f",
      "DECISION_ACCEPTED",
      "Use custom IPC handler"
    );

    expect(origDecision.status).toBe("ACTIVE");

    const newDecision = memoryManager.addMemoryItem(
      "proj-f",
      "DECISION_ACCEPTED",
      "Use typed Electron preload IPC bridge",
      ["msg-2"],
      origDecision.id
    );

    const oldRefetched = memoryManager.getMemoryItemById(origDecision.id);
    expect(oldRefetched?.status).toBe("SUPERSEDED");

    expect(newDecision.status).toBe("ACTIVE");
    expect(newDecision.supersedesId).toBe(origDecision.id);

    const activeDecisions = memoryManager.getActiveMemoryItems("proj-f", "DECISION_ACCEPTED");
    expect(activeDecisions).toHaveLength(1);
    const firstDecision = activeDecisions[0];
    expect(firstDecision).toBeDefined();
    expect(firstDecision?.text).toBe("Use typed Electron preload IPC bridge");
  });

  it("should generate incremental RollingBrief on material events", () => {
    memoryManager.addMemoryItem("proj-f", "REQUIREMENT", "Responsive UI");
    memoryManager.addMemoryItem("proj-f", "DECISION_ACCEPTED", "Dark mode default");

    const briefV1 = memoryManager.updateRollingBriefOnMaterialEvent("proj-f", {
      type: "DECISION_MADE",
      description: "Accepted dark mode default",
    });

    expect(briefV1.version).toBe(1);
    expect(briefV1.activeRequirements).toContain("Responsive UI");
    expect(briefV1.acceptedDecisions).toContain("Dark mode default");

    const briefV2 = memoryManager.updateRollingBriefOnMaterialEvent("proj-f", {
      type: "CLI_EXECUTION_COMPLETED",
      description: "Finished styles module task",
      completedTaskTitle: "Create CSS tokens",
    });

    expect(briefV2.version).toBe(2);
    expect(briefV2.completedWork).toContain("Create CSS tokens");

    const latest = memoryManager.getLatestRollingBrief("proj-f");
    expect(latest?.version).toBe(2);
  });
});
