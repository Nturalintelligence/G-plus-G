import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpecExporter } from "../src/artifacts/spec-exporter.js";
import { emptyProjectState, ProjectStateService } from "../src/project-state.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

const open: AppDatabase[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

describe("Project State and export", () => {
  it("versions, approves, traces, and exports state", async () => {
    const root = mkdtempSync(join(tmpdir(), "state-"));
    const database = new AppDatabase(join(root, "db.sqlite"));
    open.push(database);
    database.migrate();
    const project = new ProjectRepository(database).createProject("State");
    const state = emptyProjectState();
    state.requirements.push({ id: "r1", text: "Persist locally", sourceTurnIds: ["t1"] });
    state.openQuestions.push({ id: "q1", text: "Which OS first?", sourceTurnIds: ["t2"] });
    state.acceptanceCriteria.push({
      id: "a1",
      text: "State survives restart",
      sourceTurnIds: ["t1"],
    });
    const service = new ProjectStateService(database);
    const draft = service.createVersion(project.id, state);
    expect(draft.status).toBe("DRAFT");
    const approved = service.approve(draft.id);
    expect(approved.status).toBe("APPROVED");
    expect(approved.sourceTurnIds).toEqual(["t1", "t2"]);

    const exported = await new SpecExporter(database).export(
      project.id,
      approved,
      join(root, "exports"),
    );
    const spec = readFileSync(join(exported.directory, "TASK_SPEC.md"), "utf8");
    expect(spec).toContain("Status: **APPROVED**");
    expect(spec).toContain("## Open questions");
    expect(spec).toContain("Which OS first?");
    expect(exported.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(exported.directory, "conversation.md"), "utf8")).toContain(
      "No recorded messages",
    );
    expect(readFileSync(join(exported.directory, "verification.json"), "utf8")).toContain(
      '"status": "PENDING"',
    );
  });

  it("requires acceptance criteria", () => {
    const root = mkdtempSync(join(tmpdir(), "state-invalid-"));
    const database = new AppDatabase(join(root, "db.sqlite"));
    open.push(database);
    database.migrate();
    const project = new ProjectRepository(database).createProject("Invalid");
    expect(() =>
      new ProjectStateService(database).createVersion(project.id, emptyProjectState()),
    ).toThrow(/acceptance criterion/);
  });
});
