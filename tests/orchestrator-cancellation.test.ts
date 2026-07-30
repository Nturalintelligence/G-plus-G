import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MessageInput,
  ModelAdapter,
  TurnRef,
} from "../src/adapters/adapter-contract.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

function limits() {
  return {
    maxTurns: 2,
    maxTurnMs: 1_000,
    maxSessionMs: 2_000,
    maxRetries: 1,
    confirmationEvery: 1,
  };
}

describe("parallel cancellation", () => {
  it("cancels the peer immediately when one browser page is closed", async () => {
    const database = new AppDatabase(join(mkdtempSync(join(tmpdir(), "cancel-")), "db.sqlite"));
    database.migrate();
    const project = new ProjectRepository(database).createProject("Cancellation");
    let peerCancelled = 0;
    let failedAttempts = 0;

    const closedAdapter = {
      providerId: "closed",
      async sendMessage(_input: MessageInput) {
        failedAttempts += 1;
        return { id: "closed-turn" };
      },
      async getFinalResponse() {
        throw new Error("Target page, context or browser has been closed");
      },
      async cancel() {},
      async recover() {
        throw new Error("must not retry a manually closed page");
      },
    } as unknown as ModelAdapter;

    const peerAdapter = {
      providerId: "peer",
      async sendMessage(_input: MessageInput) {
        return { id: "peer-turn" };
      },
      async getFinalResponse() {
        return new Promise<never>(() => undefined);
      },
      async cancel(_turn: TurnRef) {
        peerCancelled += 1;
      },
    } as unknown as ModelAdapter;

    const orchestrator = new Orchestrator(
      database,
      new Map([
        ["closed", closedAdapter],
        ["peer", peerAdapter],
      ]),
    );

    await expect(
      orchestrator.run(
        project.id,
        "PARALLEL",
        "task",
        ["closed", "peer"],
        limits(),
      ),
    ).rejects.toThrow(/has been closed/);
    expect(failedAttempts).toBe(1);
    expect(peerCancelled).toBe(1);
    database.close();
  });
});
