import crypto from "node:crypto";

export type CapabilityState = "AVAILABLE" | "UNAVAILABLE" | "AUTH_REQUIRED" | "APPROVAL_REQUIRED" | "DENIED" | "QUOTA_EXHAUSTED" | "WORKSPACE_POLICY_DENIED" | "NOT_SUPPORTED" | "UNKNOWN" | "BROKEN";
export type ApprovalPolicy = "NONE" | "PER_ACTION" | "PER_SESSION" | "USER_DECISION_REQUIRED";
export type AgentRole = "LEAD" | "ARCHITECT" | "DESIGNER" | "CODER" | "TESTER" | "REVIEWER" | "DEBUGGER" | "DELIVERY_OWNER" | "GIT_MANAGER";
export type AgentStatus = "PLANNED" | "READY" | "RUNNING" | "WAITING_FOR_USER" | "COMPLETED" | "FAILED" | "CANCELLED";
export type EffortLevel = "FAST" | "MEDIUM" | "HIGH" | "XHIGH" | "MAX" | "AUTO";
export type AutomationMode = "MANUAL" | "SEMI_AUTO" | "AUTO";
export type AutomationArea = "codeChanges" | "debugging" | "commit" | "push" | "derivedArtifacts";
export interface CapabilityRecord { id: string; state: CapabilityState; sourcePlugin: string; scope: string; approvalPolicy: ApprovalPolicy; healthEvidence: Record<string, unknown>; detectedVersion?: string; failureReason?: string; detectedAt: string; expiresAt: string; }
export interface CapabilitySnapshot { id: string; projectId: string; createdAt: string; expiresAt: string; capabilities: CapabilityRecord[]; }
export interface AgentInstance { id: string; projectId: string; providerId: string; role: AgentRole; taskId: string; conversationId?: string; experience?: string; requestedEffort: EffortLevel; effectiveEffort?: EffortLevel; capabilitySnapshotId: string; status: AgentStatus; }
export interface AutomationPolicy { codeChanges: AutomationMode; debugging: AutomationMode; commit: AutomationMode; push: AutomationMode; derivedArtifacts: AutomationMode; }
export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = { codeChanges: "MANUAL", debugging: "MANUAL", commit: "MANUAL", push: "MANUAL", derivedArtifacts: "MANUAL" };
export type PluginRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export interface PluginActionManifest { id: string; capabilityId: string; risk: PluginRiskLevel; requiresApproval: boolean; }
export interface PluginManifest { id: string; version: string; capabilities: string[]; permissions: string[]; healthProbe: { kind: "STATIC" | "BINARY_VERSION" | "SESSION_STATE"; target?: string }; actions: PluginActionManifest[]; riskLevels: PluginRiskLevel[]; }

const CAPABILITY_STATES = new Set<CapabilityState>(["AVAILABLE", "UNAVAILABLE", "AUTH_REQUIRED", "APPROVAL_REQUIRED", "DENIED", "QUOTA_EXHAUSTED", "WORKSPACE_POLICY_DENIED", "NOT_SUPPORTED", "UNKNOWN", "BROKEN"]);
const APPROVAL_POLICIES = new Set<ApprovalPolicy>(["NONE", "PER_ACTION", "PER_SESSION", "USER_DECISION_REQUIRED"]);
const ROLES = new Set<AgentRole>(["LEAD", "ARCHITECT", "DESIGNER", "CODER", "TESTER", "REVIEWER", "DEBUGGER", "DELIVERY_OWNER", "GIT_MANAGER"]);
const STATUSES = new Set<AgentStatus>(["PLANNED", "READY", "RUNNING", "WAITING_FOR_USER", "COMPLETED", "FAILED", "CANCELLED"]);
const EFFORTS = new Set<EffortLevel>(["FAST", "MEDIUM", "HIGH", "XHIGH", "MAX", "AUTO"]);
const MODES = new Set<AutomationMode>(["MANUAL", "SEMI_AUTO", "AUTO"]);
const RISKS = new Set<PluginRiskLevel>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const ID = /^[a-z0-9][a-z0-9._:-]{1,199}$/i;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const requiredString = (value: unknown, label: string, max = 200): string => { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters`); return value.trim(); };
const id = (value: unknown, label: string): string => { const parsed = requiredString(value, label); if (!ID.test(parsed)) throw new Error(`${label} has an invalid identifier format`); return parsed; };
const iso = (value: unknown, label: string): string => { const parsed = requiredString(value, label, 40); if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${label} must be an ISO timestamp`); return parsed; };

export function validateCapability(value: unknown): CapabilityRecord {
  const raw = record(value); const state = raw.state as CapabilityState; const approvalPolicy = raw.approvalPolicy as ApprovalPolicy;
  if (!CAPABILITY_STATES.has(state)) throw new Error("Invalid capability state"); if (!APPROVAL_POLICIES.has(approvalPolicy)) throw new Error("Invalid capability approval policy");
  const detectedAt = iso(raw.detectedAt, "detectedAt"); const expiresAt = iso(raw.expiresAt, "expiresAt"); if (Date.parse(expiresAt) <= Date.parse(detectedAt)) throw new Error("Capability expiry must be after detection");
  return { id: id(raw.id, "capability id"), state, sourcePlugin: id(raw.sourcePlugin, "source plugin"), scope: requiredString(raw.scope, "scope"), approvalPolicy, healthEvidence: record(raw.healthEvidence), detectedAt, expiresAt,
    ...(typeof raw.detectedVersion === "string" ? { detectedVersion: raw.detectedVersion.slice(0, 100) } : {}), ...(typeof raw.failureReason === "string" ? { failureReason: raw.failureReason.slice(0, 500) } : {}) };
}

export function validatePluginManifest(value: unknown): PluginManifest {
  const raw = record(value); const probe = record(raw.healthProbe); const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.map((item) => id(item, "plugin capability")) : [];
  if (!capabilities.length || new Set(capabilities).size !== capabilities.length) throw new Error("Plugin must declare unique capabilities");
  const permissions = Array.isArray(raw.permissions) ? raw.permissions.map((item) => id(item, "plugin permission")) : [];
  if (!["STATIC", "BINARY_VERSION", "SESSION_STATE"].includes(String(probe.kind))) throw new Error("Invalid plugin health probe");
  const actions = Array.isArray(raw.actions) ? raw.actions.map((item) => { const action = record(item); const risk = action.risk as PluginRiskLevel; if (!RISKS.has(risk)) throw new Error("Invalid plugin action risk"); const capabilityId = id(action.capabilityId, "action capability"); if (!capabilities.includes(capabilityId)) throw new Error("Plugin action references an undeclared capability"); if (typeof action.requiresApproval !== "boolean") throw new Error("Plugin action approval flag is required"); return { id: id(action.id, "action id"), capabilityId, risk, requiresApproval: action.requiresApproval }; }) : [];
  const riskLevels = Array.isArray(raw.riskLevels) ? raw.riskLevels as PluginRiskLevel[] : []; if (!riskLevels.every((risk) => RISKS.has(risk))) throw new Error("Invalid plugin risk level");
  return { id: id(raw.id, "plugin id"), version: requiredString(raw.version, "plugin version", 50), capabilities, permissions, healthProbe: { kind: probe.kind as PluginManifest["healthProbe"]["kind"], ...(typeof probe.target === "string" ? { target: probe.target.slice(0, 200) } : {}) }, actions, riskLevels: [...new Set(riskLevels)] };
}

export function validateAgentInstance(value: unknown): AgentInstance {
  const raw = record(value); const role = raw.role as AgentRole; const status = raw.status as AgentStatus; const requestedEffort = raw.requestedEffort as EffortLevel; const effectiveEffort = raw.effectiveEffort as EffortLevel | undefined;
  if (!ROLES.has(role) || !STATUSES.has(status) || !EFFORTS.has(requestedEffort) || (effectiveEffort && !EFFORTS.has(effectiveEffort))) throw new Error("Invalid agent role, status or effort");
  return { id: id(raw.id, "agent id"), projectId: id(raw.projectId, "project id"), providerId: id(raw.providerId, "provider id"), role, taskId: id(raw.taskId, "task id"), requestedEffort, capabilitySnapshotId: id(raw.capabilitySnapshotId, "capability snapshot id"), status,
    ...(typeof raw.conversationId === "string" ? { conversationId: id(raw.conversationId, "conversation id") } : {}), ...(typeof raw.experience === "string" ? { experience: raw.experience.slice(0, 500) } : {}), ...(effectiveEffort ? { effectiveEffort } : {}) };
}

export function validateAutomationPolicy(value: unknown): AutomationPolicy { const raw = record(value); const result = {} as AutomationPolicy; for (const area of ["codeChanges", "debugging", "commit", "push", "derivedArtifacts"] as AutomationArea[]) { const mode = raw[area] as AutomationMode; if (!MODES.has(mode)) throw new Error(`Invalid automation mode for ${area}`); result[area] = mode; } return result; }
export type EffortResolution = { status: "RESOLVED"; effectiveEffort: EffortLevel } | { status: "USER_DECISION_REQUIRED"; requestedEffort: EffortLevel; supportedEfforts: EffortLevel[] };
export function resolveEffort(requested: EffortLevel, supported: readonly EffortLevel[]): EffortResolution { if (!EFFORTS.has(requested) || !supported.every((item) => EFFORTS.has(item))) throw new Error("Invalid effort level"); return supported.includes(requested) ? { status: "RESOLVED", effectiveEffort: requested } : { status: "USER_DECISION_REQUIRED", requestedEffort: requested, supportedEfforts: [...supported] }; }
export function validateAgentOwnership(agent: AgentInstance, request: { projectId: string; providerId: string; taskId: string; role: AgentRole }): void { if (agent.projectId !== request.projectId || agent.providerId !== request.providerId || agent.taskId !== request.taskId || agent.role !== request.role) throw new Error("AGENT_OWNERSHIP_MISMATCH: provider/task/role result substitution is forbidden"); }
export function decideAutomation(policy: AutomationPolicy, area: AutomationArea, action: { forcePush?: boolean; protectedBranch?: boolean; protectedBranchConfirmed?: boolean; elevation?: boolean }): { allowed: boolean; reason?: string } { if (action.forcePush) return { allowed: false, reason: "FORCE_PUSH_DENIED" }; if (action.elevation) return { allowed: false, reason: "PERSISTENT_ELEVATION_DENIED" }; if (area === "push" && action.protectedBranch && !action.protectedBranchConfirmed) return { allowed: false, reason: "PROTECTED_BRANCH_CONFIRMATION_REQUIRED" }; const mode = policy[area]; return mode === "AUTO" ? { allowed: true } : { allowed: false, reason: mode === "MANUAL" ? "USER_APPROVAL_REQUIRED" : "SEMI_AUTO_CONFIRMATION_REQUIRED" }; }
export function immutableSnapshotHash(snapshot: Omit<CapabilitySnapshot, "id">): string { return crypto.createHash("sha256").update(JSON.stringify({ ...snapshot, capabilities: [...snapshot.capabilities].sort((a, b) => a.id.localeCompare(b.id)) })).digest("hex"); }
