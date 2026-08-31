import { describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { AgentWorkspaceRepository } from "../src/agent-workspace/repository.js";
import { BuiltinPluginRegistry } from "../src/agent-workspace/plugin-registry.js";
import { DEFAULT_AUTOMATION_POLICY, decideAutomation, resolveEffort, validateAgentOwnership, validatePluginManifest, type AgentInstance, type CapabilityRecord } from "../src/agent-workspace/models.js";
import { SafeExecutionBroker } from "../src/cli-executors/execution-broker.js";
import type { CliExecutor } from "../src/cli-executors/cli-executor-contract.js";
import { AgentWorkspaceService } from "../src/agent-workspace/service.js";

const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString();
const capability = (overrides: Partial<CapabilityRecord> = {}): CapabilityRecord => ({ id: "executor.codex.cli", state: "AVAILABLE", sourcePlugin: "gplusg.safe-cli", scope: "project", approvalPolicy: "PER_ACTION", healthEvidence: { probe: "fixture" }, detectedAt: new Date().toISOString(), expiresAt: future(), ...overrides });

function setup() {
  const db = new AppDatabase(":memory:"); db.migrate(); const now = new Date().toISOString();
  db.raw.prepare("INSERT INTO projects(id,name,status,created_at,updated_at) VALUES ('project-aw','AW','ACTIVE',?,?)").run(now, now);
  const repo = new AgentWorkspaceRepository(db.raw); repo.registerBuiltinPlugins();
  const snapshot = repo.createCapabilitySnapshot({ id: "caps-aw", projectId: "project-aw", createdAt: now, expiresAt: future(), capabilities: [capability()] });
  return { db, repo, snapshot };
}

const agent = (role: AgentInstance["role"], taskId: string, id = `agent-${role.toLowerCase()}`): AgentInstance => ({ id, projectId: "project-aw", providerId: "chatgpt", role, taskId, requestedEffort: "HIGH", effectiveEffort: "HIGH", capabilitySnapshotId: "caps-aw", status: "READY" });

describe("Agent Workspace foundation", () => {
  it("validates and registers built-in manifests without executing plugin code", () => {
    const registry = new BuiltinPluginRegistry(); expect(registry.list().map((item) => item.id)).toEqual(["gplusg.provider-sessions", "gplusg.safe-cli", "gplusg.git-foundation"]);
    expect(() => validatePluginManifest({ id: "bad", version: "1", capabilities: ["git.read"], permissions: [], healthProbe: { kind: "STATIC" }, actions: [{ id: "oops", capabilityId: "undeclared", risk: "LOW", requiresApproval: false }], riskLevels: ["LOW"] })).toThrow("undeclared");
  });

  it("creates separate AgentInstance identities for multiple roles and questions of one provider", () => {
    const { db, repo } = setup();
    repo.createAgent(agent("ARCHITECT", "task-design", "agent-architect")); repo.createAgent(agent("CODER", "task-code", "agent-coder"));
    const rows = repo.listAgents("project-aw"); expect(rows).toHaveLength(2); expect(new Set(rows.map((item) => item.id)).size).toBe(2); expect(new Set(rows.map((item) => item.taskId))).toEqual(new Set(["task-design", "task-code"])); db.close();
  });

  it("enforces provider/task/role ownership without cross-provider substitution", () => {
    const value = agent("CODER", "task-code", "agent-owner");
    expect(() => validateAgentOwnership(value, { projectId: "project-aw", providerId: "gemini", taskId: "task-code", role: "CODER" })).toThrow("OWNERSHIP");
    expect(() => validateAgentOwnership(value, { projectId: "project-aw", providerId: "chatgpt", taskId: "task-other", role: "CODER" })).toThrow("OWNERSHIP");
  });

  it("never silently downgrades unavailable effort", () => {
    expect(resolveEffort("MAX", ["FAST", "MEDIUM", "HIGH"])).toEqual({ status: "USER_DECISION_REQUIRED", requestedEffort: "MAX", supportedEfforts: ["FAST", "MEDIUM", "HIGH"] });
    expect(resolveEffort("HIGH", ["FAST", "HIGH"])).toEqual({ status: "RESOLVED", effectiveEffort: "HIGH" });
  });

  it("seals capability snapshots and rejects expired capability evidence", () => {
    const { db, repo } = setup();
    expect(() => db.raw.prepare("UPDATE aw_capabilities SET state='BROKEN' WHERE snapshot_id='caps-aw'").run()).toThrow("immutable");
    db.raw.prepare("UPDATE aw_capabilities SET expires_at=? WHERE snapshot_id='caps-aw'");
    const now = new Date().toISOString(); db.raw.prepare("INSERT INTO aw_capability_snapshots(id,project_id,created_at,expires_at,immutable_hash,sealed) VALUES ('caps-expired','project-aw',?,?, 'expired-hash',1)").run(new Date(Date.now()-20_000).toISOString(), new Date(Date.now()-10_000).toISOString());
    expect(() => repo.createAgent({ ...agent("TESTER", "task-test", "agent-expired"), capabilitySnapshotId: "caps-expired" })).toThrow("EXPIRED"); db.close();
  });

  it("enforces MANUAL/SEMI_AUTO/AUTO, force-push and protected branch boundaries", () => {
    expect(decideAutomation(DEFAULT_AUTOMATION_POLICY, "commit", {})).toMatchObject({ allowed: false, reason: "USER_APPROVAL_REQUIRED" });
    const auto = { codeChanges: "AUTO", debugging: "AUTO", commit: "AUTO", push: "AUTO", derivedArtifacts: "AUTO" } as const;
    expect(decideAutomation(auto, "codeChanges", {})).toEqual({ allowed: true });
    expect(decideAutomation(auto, "push", { forcePush: true })).toMatchObject({ allowed: false, reason: "FORCE_PUSH_DENIED" });
    expect(decideAutomation(auto, "push", { protectedBranch: true })).toMatchObject({ allowed: false, reason: "PROTECTED_BRANCH_CONFIRMATION_REQUIRED" });
    expect(decideAutomation(auto, "push", { protectedBranch: true, protectedBranchConfirmed: true })).toEqual({ allowed: true });
    expect(decideAutomation({ ...auto, debugging: "SEMI_AUTO" }, "debugging", {})).toMatchObject({ allowed: false, reason: "SEMI_AUTO_CONFIRMATION_REQUIRED" });
  });

  it("allows only Delivery Owner to PASS and requires owned evidence", () => {
    const { db, repo } = setup(); const tester = repo.createAgent(agent("TESTER", "task-release", "agent-tester")); const owner = repo.createAgent(agent("DELIVERY_OWNER", "task-release", "agent-delivery"));
    expect(() => repo.recordDeliveryDecision({ projectId: "project-aw", taskId: "task-release", deliveryOwnerAgentId: tester.id, decision: "PASS", evidenceIds: [], reason: "no" })).toThrow("ONLY_DELIVERY_OWNER");
    expect(() => repo.recordDeliveryDecision({ projectId: "project-aw", taskId: "task-release", deliveryOwnerAgentId: owner.id, decision: "PASS", evidenceIds: [], reason: "no" })).toThrow("REQUIRES_EVIDENCE");
    const evidenceId = repo.addEvidence({ projectId: "project-aw", taskId: "task-release", agentInstanceId: tester.id, providerId: "chatgpt", evidenceType: "TEST", payloadHash: "a".repeat(64), summary: "tests passed" });
    expect(repo.recordDeliveryDecision({ projectId: "project-aw", taskId: "task-release", deliveryOwnerAgentId: owner.id, decision: "PASS", evidenceIds: [evidenceId], reason: "verified" })).toMatch(/^decision_/); db.close();
  });

  it("returns USER_DECISION_REQUIRED instead of substituting Gemini for requested Codex", async () => {
    const broker = new SafeExecutionBroker();
    const executor = (id: "codex" | "gemini", healthy: boolean): CliExecutor => ({ id, capabilities: () => ({ supportsStreaming: true, supportedRisks: ["READ_ONLY"], maxTimeoutMs: 1000 }), healthCheck: vi.fn(async () => ({ healthy, executorId: id, ...(healthy ? { version: "1" } : { reason: "missing" }) })), execute: async function* () {} });
    broker.registerExecutor(executor("codex", false)); broker.registerExecutor(executor("gemini", true));
    await expect(broker.resolveRequestedExecutor("codex", "READ_ONLY")).resolves.toEqual({ status: "USER_DECISION_REQUIRED", requestedExecutor: "codex", reason: "Executor 'codex' is unhealthy: missing", alternatives: ["gemini"] });
  });

  it("hydrates a persistent workspace without running declared health probes", () => {
    const db = new AppDatabase(":memory:"); db.migrate(); const now = new Date().toISOString();
    db.raw.prepare("INSERT INTO projects(id,name,status,created_at,updated_at) VALUES ('project-service','AW service','ACTIVE',?,?)").run(now, now);
    db.raw.prepare("INSERT INTO project_providers(project_id,provider_id) VALUES ('project-service','chatgpt'),('project-service','gemini')").run();
    const first = new AgentWorkspaceService(db.raw).getOrCreate("project-service");
    expect(new Set(first.agents.map((item) => item.role))).toEqual(new Set(["LEAD", "REVIEWER", "DELIVERY_OWNER"]));
    expect(new Set(first.agents.map((item) => item.id)).size).toBe(3);
    expect(new Set(first.agents.map((item) => item.taskId)).size).toBe(3);
    expect(first.capabilities.every((item) => item.state === "UNKNOWN" && item.healthEvidence.executed === false)).toBe(true);
    const second = new AgentWorkspaceService(db.raw).getOrCreate("project-service");
    expect(second.agents).toEqual(first.agents);
    expect(second.selectedLeadId).toBe(first.selectedLeadId);
    expect(second.deliveryOwnerId).toBe(first.deliveryOwnerId);
    db.close();
  });

  it("persists automation and refuses an unsupported effort without changing the agent", () => {
    const db = new AppDatabase(":memory:"); db.migrate(); const now = new Date().toISOString();
    db.raw.prepare("INSERT INTO projects(id,name,status,created_at,updated_at) VALUES ('project-effort','AW effort','ACTIVE',?,?)").run(now, now);
    db.raw.prepare("INSERT INTO project_providers(project_id,provider_id) VALUES ('project-effort','gemini')").run();
    const service = new AgentWorkspaceService(db.raw); const view = service.getOrCreate("project-effort");
    const gemini = view.agents.find((item) => item.providerId === "gemini")!;
    expect(service.setEffort("project-effort", gemini.id, "XHIGH")).toMatchObject({ status: "USER_DECISION_REQUIRED", requestedEffort: "XHIGH" });
    expect(service.getOrCreate("project-effort").agents.find((item) => item.id === gemini.id)?.requestedEffort).toBe("MEDIUM");
    const policy = { ...DEFAULT_AUTOMATION_POLICY, debugging: "AUTO" as const };
    expect(service.saveAutomationPolicy("project-effort", policy)).toEqual(policy);
    expect(new AgentWorkspaceService(db.raw).getOrCreate("project-effort").automationPolicy).toEqual(policy);
    db.close();
  });
});
