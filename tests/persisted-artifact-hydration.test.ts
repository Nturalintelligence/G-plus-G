import { beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { loadPersistedProviderArtifactRows } from "../src/attachments/persisted-artifact-hydration.js";

describe("persisted provider artifact hydration", () => {
  let appDb: AppDatabase;
  beforeEach(() => {
    appDb = new AppDatabase(":memory:");
    appDb.migrate();
    const now = new Date().toISOString();
    for (const id of ["project-a", "project-b"]) {
      appDb.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES (?,?, 'ACTIVE',?,?)").run(id, id, now, now);
    }
    for (const [id, projectId, providerId] of [
      ["turn-chatgpt", "project-a", "chatgpt"],
      ["turn-gemini", "project-a", "gemini"],
      ["turn-other", "project-b", "chatgpt"],
    ] as Array<[string, string, string]>) {
      appDb.raw.prepare("INSERT INTO conversation_entries (id,project_id,run_id,role,provider_id,round,content,created_at) VALUES (?,?,NULL,'ASSISTANT',?,1,'fixture',?)").run(id, projectId, providerId, now);
    }
  });

  const insertArtifact = (id: string, turnId: string, projectId: string, providerId: string) => {
    appDb.raw.prepare(`INSERT INTO downloaded_artifacts
      (id,message_id,project_id,provider_id,original_url,sha256,local_relative_path,file_name,mime_type,size_bytes,status,downloaded_at)
      VALUES (?,?,?,?, '', 'abc', 'opaque-relative-ref', 'fixture.txt', 'text/plain', 7, 'READY', ?)`)
      .run(id, turnId, projectId, providerId, new Date().toISOString());
  };

  it("hydrates one READY artifact idempotently regardless of query timing", () => {
    insertArtifact("artifact-a", "turn-chatgpt", "project-a", "chatgpt");
    expect(loadPersistedProviderArtifactRows(appDb.raw, "project-a").map((row) => row.id)).toEqual(["artifact-a"]);
    expect(loadPersistedProviderArtifactRows(appDb.raw, "project-a").map((row) => row.id)).toEqual(["artifact-a"]);
  });

  it("isolates projects and rejects cross-provider ownership", () => {
    insertArtifact("valid-chatgpt", "turn-chatgpt", "project-a", "chatgpt");
    insertArtifact("wrong-provider", "turn-chatgpt", "project-a", "gemini");
    insertArtifact("wrong-project", "turn-other", "project-b", "chatgpt");
    expect(loadPersistedProviderArtifactRows(appDb.raw, "project-a").map((row) => row.id)).toEqual(["valid-chatgpt"]);
    expect(loadPersistedProviderArtifactRows(appDb.raw, "project-b").map((row) => row.id)).toEqual(["wrong-project"]);
  });

  it("keeps FAILED records associated for non-downloadable diagnostics", () => {
    insertArtifact("failed", "turn-gemini", "project-a", "gemini");
    appDb.raw.prepare("UPDATE downloaded_artifacts SET status='FAILED' WHERE id='failed'").run();
    expect(loadPersistedProviderArtifactRows(appDb.raw, "project-a")).toHaveLength(1);
  });

  it("keeps failed history in SQLite but renders only the recovered READY artifact", () => {
    insertArtifact("failed", "turn-gemini", "project-a", "gemini");
    appDb.raw.prepare("UPDATE downloaded_artifacts SET status='FAILED' WHERE id='failed'").run();
    insertArtifact("recovered", "turn-gemini", "project-a", "gemini");
    expect(appDb.raw.prepare("SELECT COUNT(*) count FROM downloaded_artifacts WHERE message_id='turn-gemini'").get()).toMatchObject({ count: 2 });
    expect(loadPersistedProviderArtifactRows(appDb.raw, "project-a").map((row) => row.id)).toEqual(["recovered"]);
  });
});
