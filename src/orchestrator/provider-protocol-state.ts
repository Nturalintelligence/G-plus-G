import type { DatabaseSync } from "node:sqlite";

export interface ProviderProtocolStateV1 {
  providerId: string;
  conversationId: string;
  protocolVersion: string;
  protocolHash: string;
  initializedAt: string;
  projectCheckpointRevision?: string;
}

export interface ProtocolIdentity {
  version: string;
  hash: string;
  text: string;
}

export type ProtocolPlan =
  | { kind: "BOOTSTRAP"; preamble: string }
  | { kind: "REUSE"; preamble: "" }
  | { kind: "DELTA"; preamble: string; previousVersion: string; previousHash: string };

function compactProtocolDelta(previous: string, current: string, previousVersion: string, currentVersion: string): string {
  const previousLines = new Set(previous.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const additions = current.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !previousLines.has(line));
  const body = additions.slice(0, 20).join("\n").slice(0, 4_000);
  return `G+G PROTOCOL DELTA ${previousVersion} -> ${currentVersion}\nApply these changed rules in addition to the protocol already initialized in this conversation:\n${body || "Protocol identity changed; continue using the existing rules with the current turn contract."}`;
}

export class ProviderProtocolStateRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(providerId: string, conversationId: string): (ProviderProtocolStateV1 & { protocolText: string }) | null {
    const row = this.database.prepare("SELECT * FROM provider_protocol_states WHERE provider_id = ? AND conversation_id = ?").get(providerId, conversationId);
    return row ? {
      providerId: String(row.provider_id),
      conversationId: String(row.conversation_id),
      protocolVersion: String(row.protocol_version),
      protocolHash: String(row.protocol_hash),
      initializedAt: String(row.initialized_at),
      ...(row.project_checkpoint_revision ? { projectCheckpointRevision: String(row.project_checkpoint_revision) } : {}),
      protocolText: String(row.protocol_text),
    } : null;
  }

  plan(providerId: string, conversationId: string, identity: ProtocolIdentity): ProtocolPlan {
    const state = this.get(providerId, conversationId);
    if (!state) return { kind: "BOOTSTRAP", preamble: identity.text };
    if (state.protocolVersion === identity.version && state.protocolHash === identity.hash) return { kind: "REUSE", preamble: "" };
    return {
      kind: "DELTA",
      preamble: compactProtocolDelta(state.protocolText, identity.text, state.protocolVersion, identity.version),
      previousVersion: state.protocolVersion,
      previousHash: state.protocolHash,
    };
  }

  markInitialized(providerId: string, conversationId: string, identity: ProtocolIdentity, checkpointRevision?: string): ProviderProtocolStateV1 {
    const initializedAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO provider_protocol_states
      (provider_id, conversation_id, protocol_version, protocol_hash, protocol_text, initialized_at, project_checkpoint_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, conversation_id) DO UPDATE SET
        protocol_version=excluded.protocol_version,
        protocol_hash=excluded.protocol_hash,
        protocol_text=excluded.protocol_text,
        initialized_at=excluded.initialized_at,
        project_checkpoint_revision=excluded.project_checkpoint_revision
    `).run(providerId, conversationId, identity.version, identity.hash, identity.text, initializedAt, checkpointRevision ?? null);
    return { providerId, conversationId, protocolVersion: identity.version, protocolHash: identity.hash, initializedAt, ...(checkpointRevision ? { projectCheckpointRevision: checkpointRevision } : {}) };
  }
}
