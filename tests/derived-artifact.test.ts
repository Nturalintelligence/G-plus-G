import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import {
  DerivedArtifactAuthorization,
  DerivedArtifactService,
  PROVIDER_ARTIFACT_CAPABILITIES,
} from "../src/attachments/derived-artifact.js";
import { loadPersistedProviderArtifactRows } from "../src/attachments/persisted-artifact-hydration.js";
import { AppDatabase } from "../src/storage/database.js";

describe("derived provider artifacts", () => {
  let database: AppDatabase;
  let root: string;
  let service: DerivedArtifactService;
  let seq = 0;

  beforeEach(() => {
    database = new AppDatabase(":memory:");
    database.migrate();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-derived-"));
    service = new DerivedArtifactService(database.raw, new LocalArtifactStore(root));
  });
  afterEach(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });

  function fixture(options: { provider?: "gemini" | "chatgpt"; request?: string; response?: string; fileName?: string } = {}) {
    seq += 1;
    const provider = options.provider ?? "gemini";
    const projectId = `project-${seq}`;
    const userId = `task-${seq}`;
    const assistantId = `assistant-${seq}`;
    const failedId = `failed-${seq}`;
    const now = new Date(Date.now() + seq * 10).toISOString();
    const request = options.request ?? "Создай файл gplusg-inbound-final.txt, содержащий ровно строку G_PLUS_G_INBOUND_FINAL_2026";
    const response = options.response ?? "```text\nG_PLUS_G_INBOUND_FINAL_2026\n```";
    database.raw.prepare("INSERT INTO projects(id,name,status,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?)").run(projectId, projectId, now, now);
    database.raw.prepare("INSERT INTO conversation_entries(id,project_id,role,provider_id,round,content,created_at) VALUES (?,?, 'USER',?,1,?,?)").run(userId, projectId, provider, request, now);
    database.raw.prepare("INSERT INTO conversation_entries(id,project_id,role,provider_id,round,content,created_at) VALUES (?,?, 'ASSISTANT',?,1,?,?)").run(assistantId, projectId, provider, response, new Date(Date.parse(now) + 1).toISOString());
    database.raw.prepare(`INSERT INTO downloaded_artifacts
      (id,message_id,project_id,provider_id,original_url,sha256,local_relative_path,status,downloaded_at,file_name,mime_type,size_bytes)
      VALUES (?,?,?,?, '', '', '', 'FAILED',?, '', 'application/octet-stream',0)`).run(failedId, assistantId, projectId, provider, now);
    return { projectId, userId, assistantId, failedId };
  }

  it("models Gemini native capability honestly", () => {
    expect(PROVIDER_ARTIFACT_CAPABILITIES.gemini).toMatchObject({ nativeFileResponse: "NOT_PROVEN", providerUiDownload: "AVAILABLE_CONDITIONALLY", codeBlockDownload: "AVAILABLE_CONDITIONALLY", derivedArtifact: "SUPPORTED" });
  });

  it("creates a confirmed ASK artifact with strict provenance, MIME and SHA-256", () => {
    const ids = fixture();
    const prepared = service.prepare(ids.failedId);
    expect(prepared.status).toBe("READY");
    if (prepared.status !== "READY") throw new Error(prepared.reason);
    expect(() => service.create(prepared.proposal, "ASK", false)).toThrow("confirmation");
    const row = service.create(prepared.proposal, "ASK", true);
    expect(row).toMatchObject({ provider_id: "gemini", message_id: ids.assistantId, task_id: ids.userId, assistant_turn_id: ids.assistantId, source_message_id: ids.assistantId, provenance: "GPLUSG_DERIVED_FROM_PROVIDER_RESPONSE", status: "READY", file_name: "gplusg-inbound-final.txt", mime_type: "text/plain", size_bytes: 27, sha256: "8e2f74f110636e05fb49232d1435d280aae71b94b63156b2ea536676e007a21d" });
    expect(new LocalArtifactStore(root).readBuffer(String(row.local_relative_path)).toString("utf8")).toBe("G_PLUS_G_INBOUND_FINAL_2026");
    expect(loadPersistedProviderArtifactRows(database.raw, ids.projectId).map((item) => item.id)).toEqual([row.id]);
  });

  it("Cancel creates nothing through main-process authorization", async () => {
    const ids = fixture(); const prepared = service.prepare(ids.failedId);
    if (prepared.status !== "READY") throw new Error("fixture failed");
    const auth = new DerivedArtifactAuthorization();
    const result = await auth.runConfirmed(prepared.proposal, async () => false, async () => service.create(prepared.proposal, "ASK", true));
    expect(result.confirmed).toBe(false);
    expect(database.raw.prepare("SELECT COUNT(1) count FROM downloaded_artifacts WHERE status='READY'").get()).toMatchObject({ count: 0 });
  });

  it("AUTO is restricted to explicit file requests and DENY always blocks", () => {
    const ids = fixture(); const prepared = service.prepare(ids.failedId);
    if (prepared.status !== "READY") throw new Error("fixture failed");
    expect(() => service.create({ ...prepared.proposal, explicitlyRequested: false }, "AUTO", true)).toThrow("explicit");
    expect(() => service.create(prepared.proposal, "DENY", true)).toThrow("disabled");
    expect(service.create(prepared.proposal, "AUTO", false).status).toBe("READY");
  });

  it("deduplicates the same source turn and keeps providers isolated", () => {
    const gemini = fixture(); const chatgpt = fixture({ provider: "chatgpt" });
    const g = service.prepare(gemini.failedId); const c = service.prepare(chatgpt.failedId);
    if (g.status !== "READY" || c.status !== "READY") throw new Error("fixture failed");
    const first = service.create(g.proposal, "ASK", true); const duplicate = service.create(g.proposal, "ASK", true); const other = service.create(c.proposal, "ASK", true);
    expect(duplicate.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(other.provider_id).toBe("chatgpt");
  });

  it("requires selection for multiple code blocks and rejects empty or unsafe input", () => {
    expect(service.prepare(fixture({ response: "```txt\none\n```\n```txt\ntwo\n```" }).failedId)).toMatchObject({ status: "NEEDS_SELECTION", candidateCount: 2 });
    expect(service.prepare(fixture({ response: "Файл якобы готов, но payload отсутствует" }).failedId)).toMatchObject({ status: "UNAVAILABLE" });
    expect(service.prepare(fixture({ request: "Создай файл ../bad.txt, содержащий строку SAFE_TEXT", response: "SAFE_TEXT" }).failedId)).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("rejects an oversized textual response before managed storage", () => {
    const ids = fixture({ request: "Создай файл large.txt", response: "```txt\n012345678901234567890\n```" });
    const limited = new DerivedArtifactService(database.raw, new LocalArtifactStore(root), 20);
    expect(limited.prepare(ids.failedId)).toMatchObject({ status: "UNAVAILABLE", reason: expect.stringContaining("oversized") });
  });

  it("stores JavaScript only as inert text and never executes it", () => {
    (globalThis as any).__derivedExecuted = false;
    const ids = fixture({ request: "Создай файл safe.js, содержащий ровно строку globalThis.__derivedExecuted=true", response: "```js\nglobalThis.__derivedExecuted=true\n```" });
    const prepared = service.prepare(ids.failedId);
    if (prepared.status !== "READY") throw new Error("fixture failed");
    const row = service.create(prepared.proposal, "ASK", true);
    expect(row.mime_type).toBe("text/plain");
    expect((globalThis as any).__derivedExecuted).toBe(false);
  });
});
