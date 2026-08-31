import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ProviderId } from "../settings/settings.js";
import { DEFAULT_MAX_ARTIFACT_BYTES, isUnsafeFileName, LocalArtifactStore, sniffMimeType } from "./artifact-store.js";

export type ArtifactCapabilityState = "SUPPORTED" | "UNSUPPORTED" | "AVAILABLE_CONDITIONALLY" | "NOT_PROVEN" | "TEMPORARILY_UNAVAILABLE";
export interface ProviderArtifactCapabilities {
  nativeFileResponse: ArtifactCapabilityState;
  providerUiDownload: ArtifactCapabilityState;
  codeBlockDownload: ArtifactCapabilityState;
  canvasExport: ArtifactCapabilityState;
  derivedArtifact: ArtifactCapabilityState;
}
export type ArtifactProvenance =
  | "PROVIDER_NATIVE_FILE"
  | "PROVIDER_FILE_CARD_DOWNLOAD"
  | "PROVIDER_CODE_BLOCK_DOWNLOAD"
  | "PROVIDER_NETWORK_FILE_RESPONSE"
  | "GPLUSG_DERIVED_FROM_PROVIDER_RESPONSE";
export type DerivedArtifactPolicy = "ASK" | "AUTO" | "DENY";

export const PROVIDER_ARTIFACT_CAPABILITIES: Partial<Record<ProviderId, ProviderArtifactCapabilities>> = {
  gemini: {
    nativeFileResponse: "NOT_PROVEN",
    providerUiDownload: "AVAILABLE_CONDITIONALLY",
    codeBlockDownload: "AVAILABLE_CONDITIONALLY",
    canvasExport: "AVAILABLE_CONDITIONALLY",
    derivedArtifact: "SUPPORTED",
  },
};

const ALLOWED_TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".py", ".ts", ".js", ".css"]);

export interface DerivedArtifactProposal {
  failedArtifactId: string;
  projectId: string;
  taskId: string;
  providerId: ProviderId;
  assistantTurnId: string;
  sourceMessageId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  provenance: "GPLUSG_DERIVED_FROM_PROVIDER_RESPONSE";
  payload: string;
  candidateCount: number;
  explicitlyRequested: boolean;
}

export type DerivedArtifactPreparation =
  | { status: "READY"; proposal: DerivedArtifactProposal }
  | { status: "NEEDS_SELECTION"; candidateCount: number; reason: string }
  | { status: "UNAVAILABLE"; reason: string };

const codeBlocks = (text: string): string[] => [...text.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)]
  .map((match) => match[1]?.replace(/\r?\n$/, "") ?? "")
  .filter((value) => value.trim().length > 0);

function requestedFileName(text: string): string | null {
  const match = text.match(/(?:^|\s)([\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,99}\.(?:txt|md|csv|json|py|ts|js|css))(?:\s|,|;|\.|$)/iu);
  return match?.[1] ?? null;
}

function requestedExactPayload(text: string): string | null {
  const fenced = codeBlocks(text);
  if (fenced.length === 1) return fenced[0]!;
  const match = text.match(/(?:содержащ(?:ий|его|ая)?|содержит)\s+(?:ровно\s+)?(?:строк[ау]\s+)?["“`']?([A-Z][A-Z0-9_+-]{2,})["”`']?/u);
  return match?.[1] ?? null;
}

function resolvePayload(userText: string, assistantText: string): { payload?: string; candidateCount: number } {
  const blocks = codeBlocks(assistantText);
  if (blocks.length > 1) return { candidateCount: blocks.length };
  if (blocks.length === 1) return { payload: blocks[0]!, candidateCount: 1 };
  const expected = requestedExactPayload(userText);
  if (expected && assistantText.includes(expected)) return { payload: expected, candidateCount: 1 };
  const trimmed = assistantText.trim();
  if (!expected && trimmed.length > 0 && !/[.!?]\s+\p{Lu}/u.test(trimmed)) return { payload: trimmed, candidateCount: 1 };
  return { candidateCount: 0 };
}

export class DerivedArtifactAuthorization {
  private active = new Set<string>();
  async runConfirmed<T>(proposal: DerivedArtifactProposal, confirm: () => Promise<boolean>, action: () => Promise<T>): Promise<{ confirmed: boolean; result?: T }> {
    const key = `${proposal.projectId}:${proposal.providerId}:${proposal.assistantTurnId}`;
    if (this.active.has(key)) throw new Error("Derived artifact authorization is already active");
    this.active.add(key);
    try {
      if (!await confirm()) return { confirmed: false };
      return { confirmed: true, result: await action() };
    } finally { this.active.delete(key); }
  }
}

export class DerivedArtifactService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly store = new LocalArtifactStore(),
    private readonly maxDerivedBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  ) {}

  prepare(failedArtifactId: string): DerivedArtifactPreparation {
    const row = this.database.prepare(`
      SELECT da.id, da.project_id, da.provider_id, da.message_id, da.status,
             ce.content assistant_content, ce.created_at assistant_created_at
      FROM downloaded_artifacts da
      INNER JOIN conversation_entries ce ON ce.id=da.message_id AND ce.project_id=da.project_id
        AND ce.provider_id=da.provider_id AND ce.role='ASSISTANT'
      WHERE da.id=?
    `).get(failedArtifactId) as Record<string, unknown> | undefined;
    if (!row || row.status !== "FAILED") return { status: "UNAVAILABLE", reason: "Only a failed provider artifact can be converted" };
    const user = this.database.prepare(`
      SELECT id, content FROM conversation_entries
      WHERE project_id=? AND provider_id=? AND role='USER' AND created_at<=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(String(row.project_id), String(row.provider_id), String(row.assistant_created_at)) as Record<string, unknown> | undefined;
    if (!user) return { status: "UNAVAILABLE", reason: "Source provider task is unavailable" };
    const userText = String(user.content);
    const fileName = requestedFileName(userText);
    if (!fileName) return { status: "UNAVAILABLE", reason: "The provider task did not explicitly request a supported text file" };
    if (isUnsafeFileName(fileName) || !ALLOWED_TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
      return { status: "UNAVAILABLE", reason: "Unsafe or unsupported derived artifact filename" };
    }
    const resolved = resolvePayload(userText, String(row.assistant_content));
    if (resolved.candidateCount > 1) return { status: "NEEDS_SELECTION", candidateCount: resolved.candidateCount, reason: "Several code blocks require an explicit user selection" };
    if (!resolved.payload) return { status: "UNAVAILABLE", reason: "The saved provider response does not contain an unambiguous requested payload" };
    const bytes = Buffer.from(resolved.payload, "utf8");
    if (bytes.length === 0 || bytes.length > this.maxDerivedBytes) return { status: "UNAVAILABLE", reason: "Derived artifact payload is empty or oversized" };
    const mimeType = sniffMimeType(bytes, fileName);
    if (!mimeType.startsWith("text/") && mimeType !== "application/json") return { status: "UNAVAILABLE", reason: "Only textual derived artifacts are supported" };
    return { status: "READY", proposal: {
      failedArtifactId, projectId: String(row.project_id), taskId: String(user.id), providerId: String(row.provider_id) as ProviderId,
      assistantTurnId: String(row.message_id), sourceMessageId: String(row.message_id), fileName, mimeType,
      sizeBytes: bytes.length, provenance: "GPLUSG_DERIVED_FROM_PROVIDER_RESPONSE", payload: resolved.payload,
      candidateCount: 1, explicitlyRequested: true,
    } };
  }

  create(proposal: DerivedArtifactProposal, policy: DerivedArtifactPolicy, authorized: boolean): Record<string, unknown> {
    if (policy === "DENY") throw new Error("Derived artifacts are disabled for this project");
    if (policy === "ASK" && !authorized) throw new Error("Derived artifact creation requires user confirmation");
    if (policy === "AUTO" && !proposal.explicitlyRequested) throw new Error("AUTO policy requires an explicit text-file request");
    const bytes = Buffer.from(proposal.payload, "utf8");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const existing = this.database.prepare(`SELECT * FROM downloaded_artifacts
      WHERE project_id=? AND provider_id=? AND source_message_id=? AND provenance=? AND sha256=? AND status='READY'`)
      .get(proposal.projectId, proposal.providerId, proposal.sourceMessageId, proposal.provenance, sha256) as Record<string, unknown> | undefined;
    if (existing) return existing;
    if (proposal.providerId !== "chatgpt" && proposal.providerId !== "gemini") throw new Error("Derived artifacts are not enabled for this provider");
    const stored = this.store.storeBuffer(bytes, { projectId: proposal.projectId, messageId: proposal.sourceMessageId, source: proposal.providerId, originalFileName: proposal.fileName, customMaxSizeBytes: this.maxDerivedBytes });
    if (stored.status !== "STAGED") throw new Error(`Derived artifact was quarantined: ${stored.quarantineReason}`);
    const id = `dl_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO downloaded_artifacts
      (id,message_id,project_id,provider_id,original_url,sha256,local_relative_path,status,downloaded_at,file_name,mime_type,size_bytes,
       provenance,task_id,assistant_turn_id,source_message_id,physical_click_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
      .run(id, proposal.assistantTurnId, proposal.projectId, proposal.providerId, "", stored.sha256, stored.localRelativePath, "READY", now,
        stored.fileName, stored.mimeType, stored.sizeBytes, proposal.provenance, proposal.taskId, proposal.assistantTurnId, proposal.sourceMessageId);
    return this.database.prepare("SELECT * FROM downloaded_artifacts WHERE id=?").get(id) as Record<string, unknown>;
  }
}
