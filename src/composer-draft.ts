import type { DatabaseSync } from "node:sqlite";

export type ComposerMode = "MANUAL" | "SEQUENTIAL" | "PARALLEL" | "DEBATE";
export type ComposerFinalizerMode = "MANUAL" | "LEAD_SELECTS" | "PEER_AGREEMENT";

export interface ComposerDraft {
  projectId: string;
  text: string;
  messageId: string;
  attachmentIds: string[];
  mode: ComposerMode;
  continuationPolicy: "autonomous" | "approval";
  starter: string;
  providers: string[];
  viewMode: "SYNTHESIZED" | "LIVE";
  finalizerMode: ComposerFinalizerMode;
  finalResponder: string;
  composerExpanded: boolean;
  updatedAt: string;
}

export type ComposerDraftInput = Omit<ComposerDraft, "updatedAt">;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function parseArray(value: unknown): string[] {
  try {
    return stringArray(JSON.parse(String(value)));
  } catch {
    return [];
  }
}

export class ComposerDraftRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(projectId: string): ComposerDraft | null {
    const row = this.database.prepare("SELECT * FROM composer_drafts WHERE project_id = ?").get(projectId);
    if (!row) return null;
    return {
      projectId: String(row.project_id),
      text: String(row.text),
      messageId: String(row.message_id),
      attachmentIds: parseArray(row.attachment_ids_json),
      mode: String(row.mode) as ComposerMode,
      continuationPolicy: String(row.continuation_policy) as ComposerDraft["continuationPolicy"],
      starter: String(row.starter),
      providers: parseArray(row.providers_json),
      viewMode: String(row.view_mode) as ComposerDraft["viewMode"],
      finalizerMode: String(row.finalizer_mode) as ComposerFinalizerMode,
      finalResponder: String(row.final_responder),
      composerExpanded: Number(row.composer_expanded) === 1,
      updatedAt: String(row.updated_at),
    };
  }

  save(input: ComposerDraftInput): ComposerDraft {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO composer_drafts
        (project_id, text, message_id, attachment_ids_json, mode, continuation_policy,
         starter, providers_json, view_mode, finalizer_mode, final_responder,
         composer_expanded, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        text=excluded.text,
        message_id=excluded.message_id,
        attachment_ids_json=excluded.attachment_ids_json,
        mode=excluded.mode,
        continuation_policy=excluded.continuation_policy,
        starter=excluded.starter,
        providers_json=excluded.providers_json,
        view_mode=excluded.view_mode,
        finalizer_mode=excluded.finalizer_mode,
        final_responder=excluded.final_responder,
        composer_expanded=excluded.composer_expanded,
        updated_at=excluded.updated_at
    `).run(
      input.projectId,
      input.text,
      input.messageId,
      JSON.stringify(stringArray(input.attachmentIds)),
      input.mode,
      input.continuationPolicy,
      input.starter,
      JSON.stringify(stringArray(input.providers)),
      input.viewMode,
      input.finalizerMode,
      input.finalResponder,
      input.composerExpanded ? 1 : 0,
      updatedAt,
    );
    return { ...input, attachmentIds: stringArray(input.attachmentIds), providers: stringArray(input.providers), updatedAt };
  }

  clear(projectId: string): void {
    this.database.prepare("DELETE FROM composer_drafts WHERE project_id = ?").run(projectId);
  }
}
