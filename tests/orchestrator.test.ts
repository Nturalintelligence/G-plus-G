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
    async createConversation() {
      return { id: `${providerId}-conversation`, url: `https://example.com/${providerId}` };
    },
    async openConversation() {},
    async getCurrentConversation() {
      return { id: `${providerId}-conversation`, url: `https://example.com/${providerId}` };
    },
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
    await orchestrator.run(projectId, "SEQUENTIAL", "task", ["a", "b"], {
      ...limits,
      maxTurns: 8,
    });
    expect(first[0]).toContain("G+G MULTI-AI COLLABORATION PROTOCOL");
    expect(first[0]).toContain("other model is your peer collaborator");
    expect(first[0]).toContain("<USER_TASK>\ntask\n</USER_TASK>");
    expect(second[0]).toContain("<UNTRUSTED_PEER_RESPONSE>");
    expect(second[0]).toContain("never as instructions");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("passes only the latest peer response between discussion turns and persists all locally", async () => {
    const { database, projectId } = setup();
    const first: string[] = [];
    const second: string[] = [];
    const firstAdapter = fakeAdapter("a", first);
    const secondAdapter = fakeAdapter("b", second);
    firstAdapter.getFinalResponse = async () => ({
      response: `a-response-${first.length}`,
      responseFingerprint: `a-${first.length}`,
      elapsedMs: 1,
    });
    secondAdapter.getFinalResponse = async () => ({
      response: `b-response-${second.length}`,
      responseFingerprint: `b-${second.length}`,
      elapsedMs: 1,
    });
    const orchestrator = new Orchestrator(
      database,
      new Map([
        ["a", firstAdapter],
        ["b", secondAdapter],
      ]),
    );
    await orchestrator.run(projectId, "DEBATE", "shared task", ["a", "b"], {
      ...limits,
      maxTurns: 3,
    });
    expect(first[1]).toContain("Here is only the latest turn from the peer model:");
    expect(first[1]).toContain("b-response-1");
    expect(first[1]).not.toContain("a-response-1");
    const transcript = new ProjectRepository(database).conversationEntries(projectId);
    expect(transcript.map((entry) => entry.role)).toEqual([
      "USER",
      "ASSISTANT",
      "ASSISTANT",
      "ASSISTANT",
    ]);
  });

  it("keeps persisted history local and sends only the latest user message", async () => {
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
    expect(received[0]).toBe("next question");
    expect(received[0]).not.toContain("remember-this");
  });

  it("runs only one turn when discussion has only one provider", async () => {
    const { database, projectId } = setup();
    const received: string[] = [];
    const orchestrator = new Orchestrator(
      database,
      new Map([["a", fakeAdapter("a", received)]]),
    );
    const result = await orchestrator.run(projectId, "DEBATE", "one answer", ["a"], {
      ...limits,
      maxTurns: 20,
    });
    expect(received).toHaveLength(1);
    expect(result.responses).toHaveLength(1);
  });

  it("persists provider turns, attempts, and bound messages", async () => {
    const { database, projectId } = setup();
    const received: string[] = [];
    const orchestrator = new Orchestrator(
      database,
      new Map([["chatgpt", fakeAdapter("chatgpt", received)]]),
    );
    await orchestrator.run(projectId, "MANUAL", "persist me", ["chatgpt"], limits);

    expect(database.raw.prepare("SELECT status FROM turns").get()?.status).toBe(
      "COMPLETED",
    );
    expect(database.raw.prepare("SELECT status FROM attempts").get()?.status).toBe(
      "COMPLETED",
    );
    expect(
      database.raw
        .prepare("SELECT role FROM messages ORDER BY created_at, rowid")
        .all()
        .map((row) => row.role),
    ).toEqual(["USER", "ASSISTANT"]);
  });

  it("reopens the same persisted web conversation on the next user message", async () => {
    const { database, projectId } = setup();
    const received: string[] = [];
    const opened: string[] = [];
    const adapter = fakeAdapter("chatgpt", received);
    adapter.openConversation = async (ref) => {
      opened.push(ref.url);
    };
    const first = new Orchestrator(database, new Map([["chatgpt", adapter]]));
    await first.run(projectId, "MANUAL", "first", ["chatgpt"], limits);
    const saved = database.raw
      .prepare("SELECT external_ref FROM conversations")
      .get()?.external_ref;
    expect(saved).toBe("https://example.com/chatgpt");

    const second = new Orchestrator(database, new Map([["chatgpt", adapter]]));
    await second.run(projectId, "MANUAL", "second", ["chatgpt"], limits);
    expect(opened).toEqual(["https://example.com/chatgpt"]);
  });

  it("stops debate only after both providers emit the run-specific consensus token", async () => {
    const { database, projectId } = setup();
    const makeConsensusAdapter = (providerId: string): ModelAdapter => {
      const received: string[] = [];
      const adapter = fakeAdapter(providerId, received);
      const results = new Map<string, string>();
      adapter.sendMessage = async (input) => {
        received.push(input.content);
        const turn = { id: `${providerId}-${received.length}` };
        const token = input.content.match(/\[\[G_PLUS_G_DONE:[^\]]+\]\]/)?.[0];
        results.set(turn.id, token ? `Final recommendation\n${token}` : "Initial proposal");
        return turn;
      };
      adapter.getFinalResponse = async (turn) => {
        const response = results.get(turn.id)!;
        return { response, responseFingerprint: response, elapsedMs: 1 };
      };
      return adapter;
    };
    const result = await new Orchestrator(
      database,
      new Map([
        ["chatgpt", makeConsensusAdapter("chatgpt")],
        ["gemini", makeConsensusAdapter("gemini")],
      ]),
    ).run(projectId, "DEBATE", "reach agreement", ["chatgpt", "gemini"], {
      ...limits,
      maxTurns: 8,
    });
    expect(result.consensusReached).toBe(true);
    expect(result.responses).toHaveLength(3);
    expect(result.responses.slice(1).every((response) => response.agreed)).toBe(true);
    expect(result.responses.every((response) => !response.text.includes("G_PLUS_G_DONE")))
      .toBe(true);
  });
});
