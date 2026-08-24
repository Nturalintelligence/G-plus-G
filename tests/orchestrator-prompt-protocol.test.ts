import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";
import { COLLABORATION_PROTOCOL, COLLABORATION_PROTOCOL_HASH, COLLABORATION_PROTOCOL_VERSION, hasTerminalConsensusMarker, stripConsensusMarkers } from "../src/orchestrator/prompt-builder.js";
import { ProviderProtocolStateRepository } from "../src/orchestrator/provider-protocol-state.js";
import { buildProviderTurnPrompt, compactPeer } from "../src/orchestrator/provider-turn-envelope.js";

describe("orchestration prompt protocol", () => {
  it("accepts consensus only as the exact final non-whitespace line", () => {
    const token = "[[G_PLUS_G_DONE:run-1]]";
    expect(hasTerminalConsensusMarker(`answer\n${token}\n`, token)).toBe(true);
    expect(hasTerminalConsensusMarker(`quoted ${token} but incomplete`, token)).toBe(false);
    expect(hasTerminalConsensusMarker(`${token}\ntrailing`, token)).toBe(false);
    expect(stripConsensusMarkers(`answer\n${token}`)).toBe("answer");
  });

  it("sends bootstrap and task in one atomic provider message, then compact turns", () => {
    const db = new AppDatabase(":memory:");
    db.migrate();
    const repository = new ProjectRepository(db);
    const project = repository.createProject("Protocol");
    const conversation = repository.getOrCreateConversation(project.id, "chatgpt");
    const states = new ProviderProtocolStateRepository(db.raw);
    const identity = { version: COLLABORATION_PROTOCOL_VERSION, hash: COLLABORATION_PROTOCOL_HASH, text: COLLABORATION_PROTOCOL };
    const first = buildProviderTurnPrompt({ runId: "r1", round: 1, mode: "MANUAL", phase: "DISCUSSION", task: "тест", outputContract: { kind: "FINAL_ANSWER" } }, identity.version, states.plan("chatgpt", conversation.id, identity));
    expect(first).toContain(COLLABORATION_PROTOCOL);
    expect(first).toContain('\"task\":\"тест\"');
    expect(first.match(/\[G\+G TURN ENVELOPE V1\]/g)).toHaveLength(1);
    states.markInitialized("chatgpt", conversation.id, identity, "cp-1");
    const next = buildProviderTurnPrompt({ runId: "r2", round: 2, mode: "SEQUENTIAL", phase: "DISCUSSION", task: "дальше", peerContribution: compactPeer("gemini", "peer answer"), continuationInstruction: "continue from checkpoint", outputContract: { kind: "WORKING_ANSWER" } }, identity.version, states.plan("chatgpt", conversation.id, identity));
    expect(next).not.toContain(COLLABORATION_PROTOCOL);
    expect(next).toContain('\"peerContribution\"');
    expect(next).toContain('\"continuationInstruction\":\"continue from checkpoint\"');
    expect(states.get("chatgpt", conversation.id)?.projectCheckpointRevision).toBe("cp-1");
    db.close();
  });

  it("keeps provider conversations independent and emits a short delta on protocol change", () => {
    const db = new AppDatabase(":memory:");
    db.migrate();
    const repository = new ProjectRepository(db);
    const project = repository.createProject("Independent");
    const chatgpt = repository.getOrCreateConversation(project.id, "chatgpt");
    const gemini = repository.getOrCreateConversation(project.id, "gemini");
    const states = new ProviderProtocolStateRepository(db.raw);
    const v1 = { version: "v1", hash: "h1", text: "rule one\nrule two" };
    states.markInitialized("chatgpt", chatgpt.id, v1);
    expect(states.plan("gemini", gemini.id, v1).kind).toBe("BOOTSTRAP");
    const delta = states.plan("chatgpt", chatgpt.id, { version: "v2", hash: "h2", text: "rule one\nrule three" });
    expect(delta.kind).toBe("DELTA");
    expect(delta.preamble).toContain("rule three");
    expect(delta.preamble).not.toContain("rule two");
    expect(delta.preamble.length).toBeLessThan(4_500);
    db.close();
  });
});
