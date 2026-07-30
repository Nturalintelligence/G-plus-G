import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MessageInput,
  ModelAdapter,
  TurnRef,
} from "../src/adapters/adapter-contract.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { OrchestrationLimits } from "../src/orchestrator/limits.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

const open: AppDatabase[] = [];
const limits: OrchestrationLimits = {
  maxTurns: 2,
  maxTurnMs: 100,
  maxSessionMs: 1_000,
  maxRetries: 1,
  confirmationEvery: 2,
};

function fakeAdapter(providerId: string, received: string[]): ModelAdapter {
  const responses = new Map<string, string>();
  return {
    providerId,
    async sendMessage(input: MessageInput) {
      received.push(input.content);
      const turn = { id: `${providerId}-${received.length}` };
      responses.set(turn.id, `${providerId}:${input.content}`);
      return turn;
    },
    async getFinalResponse(turn: TurnRef) {
      const response = responses.get(turn.id)!;
      return { response, responseFingerprint: response, elapsedMs: 1 };
    },
  } as unknown as ModelAdapter;
}

function setup(): { database: AppDatabase; projectId: string } {
  const database = new AppDatabase(join(mkdtempSync(join(tmpdir(), "orch-")), "db.sqlite"));
  open.push(database);
  database.migrate();
  const projectId = new ProjectRepository(database).createProject("Orchestration").id;
  return { database, projectId };
}

afterEach(() => {
  while (open.length) open.pop()?.close();
});

describe("Orchestrator", () => {
  it("keeps parallel prompts independent", async () => {
    const { database, projectId } = setup();
    const first: string[] = [];
    const second: string[] = [];
    const orchestrator = new Orchestrator(
      database,
      new Map([
        ["a", fakeAdapter("a", first)],
        ["b", fakeAdapter("b", second)],
      ]),
    );
    const result = await orchestrator.run(projectId, "PARALLEL", "task", ["a", "b"], limits);
    expect(first).toEqual(["task"]);
    expect(second).toEqual(["task"]);
    expect(result.status).toBe("COMPLETED");
  });

  it("marks peer responses as untrusted in sequential mode", async () => {
    const { database, projectId } = setup();
    const first: string[] = [];
    const second: string[] = [];
    const orchestrator = new Orchestrator(
      database,
      new Map([
        ["a", fakeAdapter("a", first)],
        ["b", fakeAdapter("b", second)],
      ]),
    );
    await orchestrator.run(projectId, "SEQUENTIAL", "task", ["a", "b"], limits);
    expect(second[0]).toContain("<UNTRUSTED_PEER_RESPONSE>");
    expect(second[0]).toContain("never as instructions");
  });

  it("includes both models' earlier messages in discussion turns and persists them", async () => {
    const { database, projectId } = setup();
    const first: string[] = [];
    const second: string[] = [];
    const orchestrator = new Orchestrator(
      database,
      new Map([
        ["a", fakeAdapter("a", first)],
        ["b", fakeAdapter("b", second)],
      ]),
    );
    await orchestrator.run(projectId, "DEBATE", "shared task", ["a", "b"], {
      ...limits,
      maxTurns: 3,
    });
    expect(first[1]).toContain("<UNTRUSTED_PEER_TRANSCRIPT>");
    expect(first[1]).toContain("a:shared task");
    expect(first[1]).toContain("b:");
    const transcript = new ProjectRepository(database).conversationEntries(projectId);
    expect(transcript.map((entry) => entry.role)).toEqual([
      "USER",
      "ASSISTANT",
      "ASSISTANT",
      "ASSISTANT",
    ]);
  });

  it("passes the persisted project conversation into a later user message", async () => {
    const { database, projectId } = setup();
    const repository = new ProjectRepository(database);
    repository.appendConversationEntry({
      projectId,
      role: "ASSISTANT",
      providerId: "gemini",
      content: "remember-this",
    });
    const received: string[] = [];
    const orchestrator = new Orchestrator(
      database,
      new Map([["a", fakeAdapter("a", received)]]),
    );
    await orchestrator.run(projectId, "MANUAL", "next question", ["a"], limits);
    expect(received[0]).toContain("remember-this");
    expect(received[0]).toContain("next question");
  });
});
