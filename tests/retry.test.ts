import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelAdapter } from "../src/adapters/adapter-contract.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

describe("orchestrator retry", () => {
  it("recovers and retries only up to the configured bound", async () => {
    const database = new AppDatabase(join(mkdtempSync(join(tmpdir(), "retry-")), "db.sqlite"));
    database.migrate();
    const project = new ProjectRepository(database).createProject("Retry");
    let attempts = 0;
    let recoveries = 0;
    const adapter = {
      providerId: "fake",
      async sendMessage() {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return { id: "turn" };
      },
      async getFinalResponse() {
        return { response: "ok", responseFingerprint: "ok", elapsedMs: 1 };
      },
      async recover() {
        recoveries += 1;
        return { recovered: true };
      },
    } as unknown as ModelAdapter;
    const result = await new Orchestrator(
      database,
      new Map([["fake", adapter]]),
    ).run(
      project.id,
      "MANUAL",
      "task",
      ["fake"],
      {
        maxTurns: 1,
        maxTurnMs: 100,
        maxSessionMs: 1_000,
        maxRetries: 1,
        confirmationEvery: 1,
      },
    );
    expect(result.responses[0]?.text).toBe("ok");
    expect(attempts).toBe(2);
    expect(recoveries).toBe(1);
    database.close();
  });
});
