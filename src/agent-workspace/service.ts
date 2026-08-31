import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolveEffort, type AgentInstance, type AutomationPolicy, type CapabilityRecord, type EffortLevel } from "./models.js";
import { BuiltinPluginRegistry } from "./plugin-registry.js";
import { AgentWorkspaceRepository } from "./repository.js";

export interface AgentWorkspaceView {
  projectId: string;
  agents: AgentInstance[];
  selectedLeadId?: string;
  deliveryOwnerId?: string;
  capabilities: CapabilityRecord[];
  automationPolicy: AutomationPolicy;
  plugins: ReturnType<BuiltinPluginRegistry["list"]>;
}

export class AgentWorkspaceService {
  private readonly repository: AgentWorkspaceRepository;
  private readonly registry = new BuiltinPluginRegistry();
  constructor(private readonly database: DatabaseSync) { this.repository = new AgentWorkspaceRepository(database); }

  getOrCreate(projectId: string): AgentWorkspaceView {
    const project = this.database.prepare("SELECT id FROM projects WHERE id=?").get(projectId);
    if (!project) throw new Error("Project not found");
    const plugins = this.repository.registerBuiltinPlugins(this.registry);
    let snapshot = this.repository.latestUsableSnapshot(projectId);
    if (!snapshot) {
      const now = new Date(); const expiry = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      const capabilities: CapabilityRecord[] = plugins.flatMap((plugin) => plugin.capabilities.map((capabilityId) => ({
        id: capabilityId, state: "UNKNOWN" as const, sourcePlugin: plugin.id, scope: `project:${projectId}`,
        approvalPolicy: plugin.actions.some((action) => action.capabilityId === capabilityId && action.requiresApproval) ? "PER_ACTION" as const : "NONE" as const,
        healthEvidence: { kind: plugin.healthProbe.kind, executed: false, awPhase: "AW-1" },
        failureReason: "Health probe is declared but not executed in AW-1", detectedAt: now.toISOString(), expiresAt: expiry,
      })));
      snapshot = this.repository.createCapabilitySnapshot({ projectId, createdAt: now.toISOString(), expiresAt: expiry, capabilities });
    }
    let agents = this.repository.listAgents(projectId);
    if (agents.length === 0) {
      const providers = (this.database.prepare("SELECT provider_id FROM project_providers WHERE project_id=? ORDER BY provider_id").all(projectId) as Array<{ provider_id: string }>).map((row) => row.provider_id);
      const leadProvider = providers.includes("chatgpt") ? "chatgpt" : providers[0] ?? "chatgpt";
      const reviewerProvider = providers.find((provider) => provider !== leadProvider) ?? leadProvider;
      const create = (providerId: string, role: AgentInstance["role"], task: string) => this.repository.createAgent({
        id: `agent_${crypto.randomUUID()}`, projectId, providerId, role, taskId: `task_${task}_${crypto.randomUUID()}`,
        requestedEffort: "MEDIUM", effectiveEffort: "MEDIUM", capabilitySnapshotId: snapshot!.id, status: "PLANNED",
      });
      create(leadProvider, "LEAD", "lead"); create(reviewerProvider, "REVIEWER", "review"); create(leadProvider, "DELIVERY_OWNER", "delivery");
      agents = this.repository.listAgents(projectId);
    }
    const selectedLeadId = agents.find((item) => item.role === "LEAD")?.id;
    const deliveryOwnerId = agents.find((item) => item.role === "DELIVERY_OWNER")?.id;
    return { projectId, agents, ...(selectedLeadId ? { selectedLeadId } : {}), ...(deliveryOwnerId ? { deliveryOwnerId } : {}),
      capabilities: snapshot.capabilities, automationPolicy: this.repository.getAutomationPolicy(projectId), plugins };
  }

  saveAutomationPolicy(projectId: string, value: unknown): AutomationPolicy { this.getOrCreate(projectId); return this.repository.saveAutomationPolicy(projectId, value); }
  setEffort(projectId: string, agentId: string, requested: EffortLevel): { status: "UPDATED"; effectiveEffort: EffortLevel } | ReturnType<typeof resolveEffort> {
    const view = this.getOrCreate(projectId); const agent = view.agents.find((item) => item.id === agentId); if (!agent) throw new Error("Agent instance not found");
    const supported: EffortLevel[] = agent.providerId === "gemini" ? ["FAST", "MEDIUM", "HIGH", "AUTO"] : ["FAST", "MEDIUM", "HIGH", "XHIGH", "MAX", "AUTO"];
    const resolution = resolveEffort(requested, supported); if (resolution.status !== "RESOLVED") return resolution;
    this.repository.updateAgentEffort(agentId, requested, resolution.effectiveEffort); return { status: "UPDATED", effectiveEffort: resolution.effectiveEffort };
  }
}
