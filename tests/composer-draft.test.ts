import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ComposerDraftRepository, type ComposerDraftInput } from "../src/composer-draft.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

function input(projectId: string, overrides: Partial<ComposerDraftInput> = {}): ComposerDraftInput {
  return {
    projectId,
    text: "Черновик после crash",
    messageId: "msg_draft",
    attachmentIds: ["att_second", "att_first"],
    mode: "DEBATE",
    continuationPolicy: "approval",
    starter: "gemini",
    providers: ["gemini", "chatgpt"],
    viewMode: "LIVE",
    finalizerMode: "PEER_AGREEMENT",
    finalResponder: "chatgpt",
    composerExpanded: true,
    ...overrides,
  };
}

describe("crash-safe composer drafts", () => {
  it("restores all composer state and attachment order after reopening SQLite", () => {
    const path = join(mkdtempSync(join(tmpdir(), "composer-draft-")), "test.sqlite");
    const first = new AppDatabase(path); first.migrate();
    const project = new ProjectRepository(first).createProject("Draft project");
    new ComposerDraftRepository(first.raw).save(input(project.id));
    first.close();

    const second = new AppDatabase(path); second.migrate();
    expect(new ComposerDraftRepository(second.raw).get(project.id)).toMatchObject(input(project.id));
    second.close();
  });

  it("keeps drafts isolated per project and clears only the submitted project", () => {
    const database = new AppDatabase(":memory:"); database.migrate();
    const projects = new ProjectRepository(database);
    const first = projects.createProject("First");
    const second = projects.createProject("Second");
    const drafts = new ComposerDraftRepository(database.raw);
    drafts.save(input(first.id, { text: "first" }));
    drafts.save(input(second.id, { text: "second", attachmentIds: ["other"] }));
    drafts.clear(first.id);
    expect(drafts.get(first.id)).toBeNull();
    expect(drafts.get(second.id)).toMatchObject({ text: "second", attachmentIds: ["other"] });
    database.close();
  });

  it("deduplicates persisted ids without changing their order", () => {
    const database = new AppDatabase(":memory:"); database.migrate();
    const project = new ProjectRepository(database).createProject("Ordering");
    const drafts = new ComposerDraftRepository(database.raw);
    drafts.save(input(project.id, { attachmentIds: ["b", "a", "b"], providers: ["gemini", "chatgpt", "gemini"] }));
    expect(drafts.get(project.id)).toMatchObject({ attachmentIds: ["b", "a"], providers: ["gemini", "chatgpt"] });
    database.close();
  });
});
