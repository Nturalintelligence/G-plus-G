import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BuiltinPluginRegistry } from "./plugin-registry.js";
import { DEFAULT_AUTOMATION_POLICY, immutableSnapshotHash, validateAgentInstance, validateAutomationPolicy, validateCapability, validatePluginManifest, type AgentInstance, type AutomationPolicy, type CapabilitySnapshot, type PluginManifest } from "./models.js";

export class AgentWorkspaceRepository {
  constructor(private readonly database: DatabaseSync) {}

  registerBuiltinPlugins(registry = new BuiltinPluginRegistry()): PluginManifest[] {
    const now = new Date().toISOString(); const manifests = registry.list();
    const statement = this.database.prepare(`INSERT INTO aw_plugins(id,version,manifest_json,source,enabled,registered_at) VALUES (?,?,?,'BUILTIN',1,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,manifest_json=excluded.manifest_json,enabled=1`);
    for (const manifest of manifests) { const valid = validatePluginManifest(manifest); statement.run(valid.id, valid.version, JSON.stringify(valid), now); }
    return manifests;
  }

  createCapabilitySnapshot(input: Omit<CapabilitySnapshot, "id"> & { id?: string }): CapabilitySnapshot {
    const capabilities = input.capabilities.map(validateCapability); const createdAt = new Date(input.createdAt).toISOString(); const expiresAt = new Date(input.expiresAt).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error("Capability snapshot is already expired");
    const immutableHash = immutableSnapshotHash({ projectId: input.projectId, createdAt, expiresAt, capabilities });
    const id = input.id ?? `caps_${crypto.randomUUID()}`;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO aw_capability_snapshots(id,project_id,created_at,expires_at,immutable_hash) VALUES (?,?,?,?,?)").run(id, input.projectId, createdAt, expiresAt, immutableHash);
      const insert = this.database.prepare(`INSERT INTO aw_capabilities(snapshot_id,capability_id,state,source_plugin,scope,approval_policy,health_evidence_json,detected_version,failure_reason,detected_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of capabilities) insert.run(id, item.id, item.state, item.sourcePlugin, item.scope, item.approvalPolicy, JSON.stringify(item.healthEvidence), item.detectedVersion ?? null, item.failureReason ?? null, item.detectedAt, item.expiresAt);
      this.database.prepare("UPDATE aw_capability_snapshots SET sealed=1 WHERE id=? AND sealed=0").run(id);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return { id, projectId: input.projectId, createdAt, expiresAt, capabilities };
  }

  createAgent(value: unknown): AgentInstance {
    const agent = validateAgentInstance(value);
    const snapshot = this.database.prepare("SELECT project_id,expires_at FROM aw_capability_snapshots WHERE id=?").get(agent.capabilitySnapshotId) as { project_id: string; expires_at: string } | undefined;
    if (!snapshot || snapshot.project_id !== agent.projectId) throw new Error("Capability snapshot does not belong to the agent project");
    if (Date.parse(snapshot.expires_at) <= Date.now()) throw new Error("EXPIRED_CAPABILITY_SNAPSHOT");
    const expired = this.database.prepare("SELECT COUNT(1) count FROM aw_capabilities WHERE snapshot_id=? AND expires_at<=?").get(agent.capabilitySnapshotId, new Date().toISOString()) as { count: number };
    if (expired.count > 0) throw new Error("EXPIRED_CAPABILITY_IN_SNAPSHOT");
    this.database.prepare(`INSERT INTO aw_agent_instances(id,project_id,provider_id,role,task_id,conversation_id,experience,requested_effort,effective_effort,capability_snapshot_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(agent.id, agent.projectId, agent.providerId, agent.role, agent.taskId, agent.conversationId ?? null, agent.experience ?? null, agent.requestedEffort, agent.effectiveEffort ?? null, agent.capabilitySnapshotId, agent.status, new Date().toISOString());
    this.database.prepare("INSERT INTO aw_role_assignments(project_id,role,agent_instance_id,assigned_at) VALUES (?,?,?,?)").run(agent.projectId, agent.role, agent.id, new Date().toISOString());
    return agent;
  }

  listAgents(projectId: string): AgentInstance[] {
    return (this.database.prepare("SELECT * FROM aw_agent_instances WHERE project_id=? ORDER BY created_at,id").all(projectId) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), projectId: String(row.project_id), providerId: String(row.provider_id), role: row.role as AgentInstance["role"], taskId: String(row.task_id),
      requestedEffort: row.requested_effort as AgentInstance["requestedEffort"], capabilitySnapshotId: String(row.capability_snapshot_id), status: row.status as AgentInstance["status"],
      ...(row.conversation_id ? { conversationId: String(row.conversation_id) } : {}), ...(row.experience ? { experience: String(row.experience) } : {}), ...(row.effective_effort ? { effectiveEffort: String(row.effective_effort) as NonNullable<AgentInstance["effectiveEffort"]> } : {}),
    }));
  }

  saveAutomationPolicy(projectId: string, value: unknown): AutomationPolicy { const policy = validateAutomationPolicy(value); this.database.prepare(`INSERT INTO aw_automation_policies(project_id,code_changes,debugging,commit_mode,push_mode,derived_artifacts,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET code_changes=excluded.code_changes,debugging=excluded.debugging,commit_mode=excluded.commit_mode,push_mode=excluded.push_mode,derived_artifacts=excluded.derived_artifacts,updated_at=excluded.updated_at`).run(projectId, policy.codeChanges, policy.debugging, policy.commit, policy.push, policy.derivedArtifacts, new Date().toISOString()); return policy; }
  getAutomationPolicy(projectId: string): AutomationPolicy { const row = this.database.prepare("SELECT * FROM aw_automation_policies WHERE project_id=?").get(projectId) as Record<string, unknown> | undefined; return row ? { codeChanges: row.code_changes as AutomationPolicy["codeChanges"], debugging: row.debugging as AutomationPolicy["debugging"], commit: row.commit_mode as AutomationPolicy["commit"], push: row.push_mode as AutomationPolicy["push"], derivedArtifacts: row.derived_artifacts as AutomationPolicy["derivedArtifacts"] } : structuredClone(DEFAULT_AUTOMATION_POLICY); }

  addEvidence(input: { id?: string; projectId: string; taskId: string; agentInstanceId: string; providerId: string; evidenceType: string; payloadHash: string; summary: string }): string {
    const agent = this.database.prepare("SELECT project_id,task_id,provider_id FROM aw_agent_instances WHERE id=?").get(input.agentInstanceId) as Record<string, unknown> | undefined;
    if (!agent || agent.project_id !== input.projectId || agent.task_id !== input.taskId || agent.provider_id !== input.providerId) throw new Error("EVIDENCE_OWNERSHIP_MISMATCH");
    const id = input.id ?? `ev_${crypto.randomUUID()}`; this.database.prepare("INSERT INTO aw_evidence(id,project_id,task_id,agent_instance_id,provider_id,evidence_type,payload_hash,summary,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, input.projectId, input.taskId, input.agentInstanceId, input.providerId, input.evidenceType, input.payloadHash, input.summary, new Date().toISOString()); return id;
  }

  recordDeliveryDecision(input: { id?: string; projectId: string; taskId: string; deliveryOwnerAgentId: string; decision: "PASS" | "FAIL" | "NEEDS_WORK"; evidenceIds: string[]; reason: string }): string {
    const owner = this.database.prepare("SELECT project_id,task_id,role FROM aw_agent_instances WHERE id=?").get(input.deliveryOwnerAgentId) as Record<string, unknown> | undefined;
    if (!owner || owner.project_id !== input.projectId || owner.task_id !== input.taskId || owner.role !== "DELIVERY_OWNER") throw new Error("ONLY_DELIVERY_OWNER_CAN_DECIDE");
    const evidence = input.evidenceIds.length ? this.database.prepare(`SELECT id FROM aw_evidence WHERE project_id=? AND task_id=? AND id IN (${input.evidenceIds.map(() => "?").join(",")})`).all(input.projectId, input.taskId, ...input.evidenceIds) : [];
    if (input.decision === "PASS" && evidence.length !== input.evidenceIds.length) throw new Error("DELIVERY_PASS_REQUIRES_OWNED_EVIDENCE");
    if (input.decision === "PASS" && evidence.length === 0) throw new Error("DELIVERY_PASS_REQUIRES_EVIDENCE");
    const id = input.id ?? `decision_${crypto.randomUUID()}`; this.database.prepare("INSERT INTO aw_delivery_decisions(id,project_id,task_id,delivery_owner_agent_id,decision,evidence_ids_json,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, input.projectId, input.taskId, input.deliveryOwnerAgentId, input.decision, JSON.stringify(input.evidenceIds), input.reason, new Date().toISOString()); return id;
  }
}
