import { describe, expect, it } from "vitest";
import { AgentWorkspaceRepository } from "../src/agent-workspace/repository.js";
import { AppDatabase } from "../src/storage/database.js";
import { ToolBroker } from "../src/tool-broker/broker.js";

function setup() {
  const database = new AppDatabase(":memory:");
  database.migrate();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  database.raw.prepare("INSERT INTO projects(id,name,status,created_at,updated_at) VALUES('project-p','p','ACTIVE',?,?)").run(now, now);
  database.raw.prepare("INSERT INTO tool_workspaces(id,project_id,root_path,created_at) VALUES('workspace-w','project-p','C:/canonical/repository',?)").run(now);
  const repository = new AgentWorkspaceRepository(database.raw);
  const snapshot = repository.createCapabilitySnapshot({ id: "snapshot-s", projectId: "project-p", createdAt: now, expiresAt, capabilities: [
    { id: "x.read", state: "AVAILABLE", sourcePlugin: "builtin.x", scope: "workspace:workspace-w", approvalPolicy: "NONE", healthEvidence: {}, detectedAt: now, expiresAt },
    { id: "x.write", state: "AVAILABLE", sourcePlugin: "builtin.x", scope: "workspace:workspace-w", approvalPolicy: "PER_ACTION", healthEvidence: {}, detectedAt: now, expiresAt },
  ] });
  repository.createAgent({ id: "agent-a", projectId: "project-p", providerId: "chatgpt", role: "CODER", taskId: "task-t", requestedEffort: "MEDIUM", effectiveEffort: "MEDIUM", capabilitySnapshotId: snapshot.id, status: "READY" });
  const broker = new ToolBroker(database.raw);
  broker.register({ id: "builtin.x", actions: new Map([
    ["read", { id: "read", capabilityId: "x.read", risk: "READ_ONLY", allowedRoles: ["CODER"], automationArea: "debugging", validate: (value) => value }],
    ["write", { id: "write", capabilityId: "x.write", risk: "WORKSPACE_WRITE", allowedRoles: ["CODER"], automationArea: "codeChanges", validate: (value) => value }],
  ]) });
  const request = (id: string, actionId = "write") => ({ id, projectId: "project-p", taskId: "task-t", agentInstanceId: "agent-a", providerId: "chatgpt", pluginId: "builtin.x", actionId, capabilitySnapshotId: "snapshot-s", workspaceId: "workspace-w", arguments: {}, idempotencyKey: id, requestedAt: now });
  return { database, broker, request };
}

describe("ToolBroker", () => {
  it("rejects forged approval and ownership", () => {
    const { broker, request } = setup();
    expect(() => broker.propose({ ...request("1"), arguments: { approved: true } })).toThrow("Forged");
    expect(() => broker.propose({ ...request("2"), providerId: "gemini" })).toThrow("Provider");
  });

  it("consumes approval once and locks writer", () => {
    const { broker, request } = setup();
    broker.propose(request("1"));
    const release = broker.begin("1", broker.approve("1", true));
    expect(() => broker.begin("1")).toThrow();
    broker.propose(request("2"));
    const secondToken = broker.approve("2", true);
    expect(() => broker.begin("2", secondToken)).toThrow("writer locked");
    release();
  });

  it("allows parallel reads and blocks duplicate completed key", () => {
    const { database, broker, request } = setup();
    broker.propose(request("r1", "read"));
    broker.propose(request("r2", "read"));
    broker.begin("r1")();
    broker.begin("r2")();
    database.raw.prepare("UPDATE tool_actions SET state='COMPLETED' WHERE id='r1'").run();
    expect(() => broker.propose({ ...request("r3", "read"), idempotencyKey: "r1" })).toThrow("Duplicate");
  });
});
