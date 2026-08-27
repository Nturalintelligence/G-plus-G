import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReacquisitionAuthorization, validateReacquisitionTarget, type ReacquisitionBinding } from "../src/attachments/reacquisition-authorization.js";

const binding: ReacquisitionBinding = {
  failedArtifactId: "opaque-failed-id", providerId: "gemini", projectId: "project-a", messageId: "assistant-turn-a",
};

describe("explicit artifact reacquisition authorization", () => {
  it("rejects unknown, READY, cross-provider, cross-project, mismatched-turn and exhausted targets", () => {
    const valid = { id: "f", status: "FAILED", providerId: "gemini", projectId: "p", messageId: "m" };
    const check = (row: typeof valid | undefined, overrides = {}) => () => validateReacquisitionTarget({ row, activeProjectId: "p", assistantTurnMatches: true, priorAttemptCount: 0, ...overrides });
    expect(check(undefined)).toThrow(/не найдена/);
    expect(check({ ...valid, status: "READY" })).toThrow(/только для неудачной/);
    expect(check({ ...valid, providerId: "chatgpt" })).toThrow(/только для файла Gemini/);
    expect(check(valid, { activeProjectId: "other" })).toThrow(/открытому проекту/);
    expect(check(valid, { assistantTurnMatches: false })).toThrow(/ответ Gemini не найден/);
    expect(check(valid, { priorAttemptCount: 1 })).toThrow(/лимит/i);
    expect(check(valid)()).toEqual({ failedArtifactId: "f", providerId: "gemini", projectId: "p", messageId: "m" });
  });
  it("issues a main-memory capability that is bound and one-time", () => {
    const auth = new ReacquisitionAuthorization(30_000, () => 1_000, () => Buffer.alloc(32, 7));
    expect(auth.reserve(binding)).toBe(true);
    expect(auth.reserve(binding)).toBe(false);
    const capability = auth.issueAfterConfirmation(binding);
    expect(capability).toHaveLength(64);
    auth.consume(capability, binding);
    expect(() => auth.consume(capability, binding)).toThrow(/expired/i);
  });

  it("Cancel performs zero actions; Confirm performs exactly one; concurrent IPC is rejected", async () => {
    const auth = new ReacquisitionAuthorization();
    let actions = 0;
    expect(await auth.runConfirmed(binding, async () => false, async () => ++actions)).toEqual({ confirmed: false });
    expect(actions).toBe(0);
    expect(await auth.runConfirmed(binding, async () => true, async () => ++actions)).toEqual({ confirmed: true, result: 1 });
    let unblock!: () => void;
    const held = auth.runConfirmed(binding, async () => new Promise<boolean>((resolve) => { unblock = () => resolve(false); }), async () => ++actions);
    await Promise.resolve();
    await expect(auth.runConfirmed(binding, async () => true, async () => ++actions)).rejects.toThrow(/already active/);
    unblock();
    await held;
    expect(actions).toBe(1);
  });

  it("rejects mismatched, expired and restart-lost capabilities before a click can start", () => {
    let now = 10;
    const auth = new ReacquisitionAuthorization(5, () => now);
    auth.reserve(binding);
    const mismatched = auth.issueAfterConfirmation(binding);
    expect(() => auth.consume(mismatched, { ...binding, projectId: "project-b" })).toThrow(/does not match/i);
    auth.release(binding.failedArtifactId);
    auth.reserve(binding);
    const expired = auth.issueAfterConfirmation(binding);
    now = 16;
    expect(() => auth.consume(expired, binding)).toThrow(/expired/i);
    const restarted = new ReacquisitionAuthorization();
    expect(() => restarted.consume(expired, binding)).toThrow(/expired/i);
  });

  it("keeps approval out of renderer, preload, adapter payload and persisted schema", () => {
    const root = process.cwd();
    const renderer = fs.readFileSync(path.join(root, "apps/desktop/renderer/main.tsx"), "utf8");
    const preload = fs.readFileSync(path.join(root, "apps/desktop/preload.cjs"), "utf8");
    const contract = fs.readFileSync(path.join(root, "src/adapters/adapter-contract.ts"), "utf8");
    const migration = fs.readFileSync(path.join(root, "src/storage/migrations.ts"), "utf8");
    expect(renderer).toContain("retryArtifact(id)");
    expect(renderer).not.toMatch(/retryArtifact\([^)]*,/);
    expect(preload).toContain('ipcRenderer.invoke("attachments:retryArtifact", attachmentId)');
    expect(contract).not.toMatch(/nonce|capability|approved/i);
    expect(migration).not.toMatch(/ADD COLUMN (nonce|capability|approval)/i);
  });

  it("wires only explicit adapter reacquisition and never provider messaging", () => {
    const main = fs.readFileSync(path.join(process.cwd(), "apps/desktop/main.ts"), "utf8");
    const handler = main.slice(main.indexOf('handle("attachments:retryArtifact"'), main.indexOf('handle("window:setTheme"'));
    expect(handler).toContain("dialog.showMessageBox");
    expect(handler).toContain("reacquisitionAuthorization.runConfirmed");
    const authorization = fs.readFileSync(path.join(process.cwd(), "src/attachments/reacquisition-authorization.ts"), "utf8");
    expect(authorization).toContain("this.consume(capability, binding)");
    expect(handler).toContain("adapter.reacquireResponseArtifact");
    expect(handler).not.toContain("rescanResponseArtifacts");
    expect(handler).not.toContain("sendMessage");
    expect(handler).not.toContain("approved");
  });
});
