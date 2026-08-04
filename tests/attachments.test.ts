import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppDatabase } from "../src/storage/database.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import { AttachmentDeliveryManager, ProviderSubmissionManager } from "../src/attachments/attachment-delivery.js";
import { ResponseArtifactDownloader, isUrlSsrfSafe } from "../src/attachments/artifact-downloader.js";
import { parseCliTasksFromBoardResponse } from "../src/orchestrator/two-tier-orchestrator.js";

describe("Stage 10: Attachments & Task Envelope End-to-End Acceptance Tests", () => {
  let tmpDir: string;
  let store: LocalArtifactStore;
  let appDb: AppDatabase;
  let deliveryMgr: AttachmentDeliveryManager;
  let subMgr: ProviderSubmissionManager;
  let downloader: ResponseArtifactDownloader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-acc-test-"));
    store = new LocalArtifactStore(tmpDir);
    appDb = new AppDatabase(":memory:");
    appDb.migrate();

    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('p-acc', 'Acceptance Project', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();

    deliveryMgr = new AttachmentDeliveryManager(appDb.raw);
    subMgr = new ProviderSubmissionManager(appDb.raw);
    downloader = new ResponseArtifactDownloader(appDb.raw, store);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("1. Accepts arbitrary multi-line Markdown & UTF-8 user card prompts without CLI parsing errors", () => {
    const cardUserPrompt = `
### КОНТЕКСТ / ЗАДАЧА / ОГРАНИЧЕНИЯ / ПРОВЕРКА

1. Контекст:
Разработка local-first модуля передачи артефактов в G+G.

2. Задача:
Добавить кнопку прикрепления файлов, drag-and-drop и Ctrl+V вставку.

3. Ограничения:
Не исполнять произвольные shell-строки, только типизированные CliTaskEnvelopeV1.

4. Проверка:
npm run check должен быть 100% зелёным.
    `;

    // Verify parser returns 0 CLI execution tasks for plain user prompts
    const tasks = parseCliTasksFromBoardResponse(cardUserPrompt, "gemini");
    expect(tasks.length).toBe(0);
  });

  it("2. Safely handles legacy CLI tags without executing them (returns 0 executable tasks)", () => {
    const legacyPrompt = `
Plan ready:
[[G_PLUS_G_CLI_TASK:{"tool":"codex","task":"Legacy command execution"}]]
    `;

    const tasks = parseCliTasksFromBoardResponse(legacyPrompt, "gemini");
    expect(tasks.length).toBe(0);
  });

  it("3. Stages user attachment files safely and quarantines executable files", () => {
    const validBuf = Buffer.from("Clean text document content");
    const validRef = store.storeBuffer(validBuf, {
      projectId: "p-acc",
      messageId: "msg-acc-1",
      source: "user",
      originalFileName: "spec.txt",
    });

    expect(validRef.status).toBe("STAGED");
    expect(validRef.sha256).toBeDefined();

    const exeBuf = Buffer.from("MZ_executable_header");
    const exeRef = store.storeBuffer(exeBuf, {
      projectId: "p-acc",
      messageId: "msg-acc-1",
      source: "user",
      originalFileName: "payload.exe",
    });

    expect(exeRef.status).toBe("QUARANTINED");
    expect(exeRef.quarantineReason).toBe("EXECUTABLE_BLOCKED");
  });

  it("4. Tracks per-provider attachment deliveries and manages submission FSM state", () => {
    appDb.raw.prepare(`
      INSERT INTO message_attachments
      (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, created_at)
      VALUES ('att-acc-1', 'msg-acc-1', 'p-acc', 'image', 'photo.png', 'image/png', 1024, 'sha123', 'p-acc/msg-acc-1/att-acc-1/photo.png', 'user', 'STAGED', '2026-01-01')
    `).run();

    const delivery = deliveryMgr.getOrCreateDelivery("att-acc-1", "chatgpt", "conv-chat-1");
    expect(delivery.status).toBe("PENDING");

    deliveryMgr.updateDeliveryStatus(delivery.id, "DELIVERED", "prov-file-123");
    const updated = deliveryMgr.getOrCreateDelivery("att-acc-1", "chatgpt", "conv-chat-1");
    expect(updated.status).toBe("DELIVERED");

    const sub = subMgr.createSubmission("msg-acc-1", "chatgpt", ["att-acc-1"]);
    expect(sub.state).toBe("PREPARING");

    subMgr.updateState(sub.submissionId, "CONFIRMED");
    const confirmedSub = subMgr.getSubmission("msg-acc-1", "chatgpt");
    expect(confirmedSub?.state).toBe("CONFIRMED");
  });

  it("5. Strictly validates SSRF rules blocking loopback and private IPs for artifact downloading", () => {
    expect(isUrlSsrfSafe("https://cdn.openai.com/images/generated.png").safe).toBe(true);
    expect(isUrlSsrfSafe("http://localhost/secret").safe).toBe(false);
    expect(isUrlSsrfSafe("http://127.0.0.1/admin").safe).toBe(false);
    expect(isUrlSsrfSafe("http://192.168.0.1/internal").safe).toBe(false);
    expect(isUrlSsrfSafe("file:///etc/passwd").safe).toBe(false);
  });
});
