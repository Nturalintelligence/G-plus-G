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

    const startedAt = Date.now();
    await expect(
      orchestrator.run(
        project.id,
        "PARALLEL",
        "task",
        ["closed", "peer"],
        limits(),
      ),
    ).rejects.toThrow(/has been closed/);
    expect(Date.now() - startedAt).toBeLessThan(800);
    expect(failedAttempts).toBe(1);
    expect(peerCancelled).toBe(1);
    database.close();
  });

  it("keeps a completed peer response when the other provider fails", async () => {
    const database = new AppDatabase(join(mkdtempSync(join(tmpdir(), "partial-")), "db.sqlite"));
    database.migrate();
    const repository = new ProjectRepository(database);
    const project = repository.createProject("Partial");
    const completed = {
      providerId: "completed",
      async sendMessage() {
        return { id: "completed-turn" };
      },
      async getFinalResponse() {
        return { response: "valuable answer", responseFingerprint: "x", elapsedMs: 1 };
      },
    } as unknown as ModelAdapter;
    const failed = {
      providerId: "failed",
      async sendMessage() {
        return { id: "failed-turn" };
      },
      async getFinalResponse() {
        throw new Error("provider failed");
      },
      async cancel() {},
    } as unknown as ModelAdapter;
    await expect(
      new Orchestrator(
        database,
        new Map([
          ["completed", completed],
          ["failed", failed],
        ]),
      ).run(project.id, "PARALLEL", "task", ["completed", "failed"], limits()),
    ).rejects.toThrow(/provider failed/);
    expect(repository.conversationEntries(project.id).map((entry) => entry.content)).toContain(
      "valuable answer",
    );
    database.close();
  });

  it("keeps STOPPED as the terminal status after cancelling an active turn", async () => {
    const database = new AppDatabase(join(mkdtempSync(join(tmpdir(), "stop-")), "db.sqlite"));
    database.migrate();
    const project = new ProjectRepository(database).createProject("Stop");
    let rejectTurn: ((error: Error) => void) | undefined;
    const adapter = {
      providerId: "slow",
      async sendMessage() {
        return { id: "slow-turn" };
      },
      async getFinalResponse() {
        return new Promise<never>((_resolve, reject) => {
          rejectTurn = reject;
        });
      },
      async cancel() {
        rejectTurn?.(new Error("cancelled"));
      },
    } as unknown as ModelAdapter;
    const orchestrator = new Orchestrator(database, new Map([["slow", adapter]]));
    const running = orchestrator.run(project.id, "MANUAL", "task", ["slow"], limits());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await orchestrator.stop();
    await expect(running).resolves.toMatchObject({ status: "STOPPED" });
    expect(
      database.raw.prepare("SELECT status FROM orchestration_runs").get()?.status,
    ).toBe("STOPPED");
    database.close();
  });
});
