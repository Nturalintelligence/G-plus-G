import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectTrashService } from "../src/project-trash.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

describe("safe local project trash", () => {
  let database: AppDatabase;
  let projects: ProjectRepository;

  beforeEach(() => {
    database = new AppDatabase(":memory:");
    database.migrate();
    projects = new ProjectRepository(database);
  });

  afterEach(() => database.close());

  it("moves and restores projects without deleting transcript or drafts", () => {
    const project = projects.createProject("Важный проект", ["chatgpt"]);
    projects.appendConversationEntry({ projectId: project.id, role: "USER", content: "Не потерять" });
    const trash = new ProjectTrashService(database);

    expect(trash.move([project.id])).toEqual([expect.objectContaining({ projectId: project.id })]);
    expect(projects.openProject(project.id)?.status).toBe("ARCHIVED");
    expect(projects.conversationEntries(project.id)).toHaveLength(1);

    trash.restore([project.id]);
    expect(projects.openProject(project.id)?.status).toBe("ACTIVE");
    expect(projects.conversationEntries(project.id)[0]?.content).toBe("Не потерять");
  });

  it("deduplicates an explicit batch and reports linked local files", () => {
    const project = projects.createProject("Файлы");
    database.raw.prepare(`
      INSERT INTO message_attachments
      (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, created_at)
      VALUES (?, ?, ?, 'DOCUMENT', 'shared.pdf', 'application/pdf', 10, 'hash-a', 'shared/path.pdf', 'USER', 'STAGED', ?)
    `).run("attachment-a", "message-a", project.id, new Date().toISOString());
    database.raw.prepare(`
      INSERT INTO downloaded_artifacts
      (id, message_id, project_id, provider_id, original_url, sha256, local_relative_path, status, downloaded_at)
      VALUES (?, ?, ?, 'chatgpt', 'https://example.invalid/shared.pdf', 'hash-a', 'shared/path.pdf', 'READY', ?)
    `).run("artifact-a", "message-a", project.id, new Date().toISOString());
    const trash = new ProjectTrashService(database);
    const result = trash.move([project.id, project.id]);
    expect(result).toHaveLength(1);
    expect(result[0]?.localFileCount).toBe(1);
    expect(trash.summaries()).toHaveLength(1);
  });

  it("permanently deletes a batch atomically when every project exists", () => {
    const first = projects.createProject("Первый");
    const second = projects.createProject("Второй");
    const trash = new ProjectTrashService(database);
    trash.move([first.id, second.id]);

    projects.deleteProjects([first.id, second.id]);

    expect(projects.openProject(first.id)).toBeNull();
    expect(projects.openProject(second.id)).toBeNull();
  });

  it("does not partially delete a batch when one project is missing", () => {
    const first = projects.createProject("Сохранить при ошибке");

    expect(() => projects.deleteProjects([first.id, "missing-project"])).toThrow("Project not found");
    expect(projects.openProject(first.id)?.name).toBe("Сохранить при ошибке");
  });
});
