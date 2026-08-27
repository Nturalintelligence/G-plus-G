import type { DatabaseSync } from "node:sqlite";

/** Loads only artifacts owned by an assistant turn in the same project/provider. */
export function loadPersistedProviderArtifactRows(
  database: DatabaseSync,
  projectId: string,
): Array<Record<string, unknown>> {
  return database.prepare(`
    SELECT da.* FROM downloaded_artifacts da
    INNER JOIN conversation_entries ce
      ON ce.id = da.message_id
      AND ce.project_id = da.project_id
      AND ce.role = 'ASSISTANT'
      AND ce.provider_id = da.provider_id
    WHERE da.project_id = ?
      AND (da.status <> 'FAILED' OR NOT EXISTS (
        SELECT 1 FROM downloaded_artifacts ready
        WHERE ready.project_id = da.project_id
          AND ready.provider_id = da.provider_id
          AND ready.message_id = da.message_id
          AND ready.status = 'READY'
      ))
    ORDER BY da.downloaded_at, da.rowid
  `).all(projectId) as Array<Record<string, unknown>>;
}
