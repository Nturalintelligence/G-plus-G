import type { AppDatabase } from "./storage/database.js";

export interface ProjectTrashSummary {
  projectId: string;
  trashedAt: string;
  localFileCount: number;
}

export class ProjectTrashService {
  constructor(private readonly database: AppDatabase) {}

  move(projectIds: string[]): ProjectTrashSummary[] {
    const ids = [...new Set(projectIds)];
    const trashedAt = new Date().toISOString();
    return this.database.transaction(() => ids.map((projectId) => {
      const project = this.database.raw.prepare("SELECT status FROM projects WHERE id = ?").get(projectId) as { status?: string } | undefined;
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.status !== "ARCHIVED") {
        this.database.raw.prepare("UPDATE projects SET status = 'ARCHIVED', updated_at = ? WHERE id = ?").run(trashedAt, projectId);
      }
      return this.summary(projectId, trashedAt);
    }));
  }

  restore(projectIds: string[]): void {
    const ids = [...new Set(projectIds)];
    const restoredAt = new Date().toISOString();
    this.database.transaction(() => {
      for (const projectId of ids) {
        const result = this.database.raw.prepare("UPDATE projects SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status = 'ARCHIVED'").run(restoredAt, projectId);
        if (result.changes !== 1) throw new Error(`Project is not in trash: ${projectId}`);
      }
    });
  }

  summaries(): ProjectTrashSummary[] {
    const rows = this.database.raw.prepare("SELECT id, updated_at FROM projects WHERE status = 'ARCHIVED' ORDER BY updated_at DESC").all() as Array<{ id: string; updated_at: string }>;
    return rows.map((row) => this.summary(row.id, row.updated_at));
  }

  private summary(projectId: string, trashedAt: string): ProjectTrashSummary {
    const localFileCount = Number((this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT local_relative_path FROM message_attachments WHERE project_id = ?
        UNION
        SELECT local_relative_path FROM downloaded_artifacts WHERE project_id = ?
      )
    `).get(projectId, projectId) as { count?: number } | undefined)?.count ?? 0);
    return { projectId, trashedAt, localFileCount };
  }
}
