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
    const trash = new ProjectTrashService(database);
    const result = trash.move([project.id, project.id]);
    expect(result).toHaveLength(1);
    expect(result[0]?.localFileCount).toBe(0);
    expect(trash.summaries()).toHaveLength(1);
  });
});
