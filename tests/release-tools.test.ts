import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createBackupBundle,
  getReleaseInfo,
  restoreBackupBundle,
  runPreflight,
  validateBackupBundle,
} from "../src/release/release-tools.js";

function makeDatabase(path: string, value: string): void {
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE records(value TEXT NOT NULL)");
  database.prepare("INSERT INTO records(value) VALUES (?)").run(value);
  database.close();
}

function readValue(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return String(database.prepare("SELECT value FROM records").get()?.value);
  } finally {
    database.close();
  }
}

describe("release and backup tools", () => {
  it("creates a consistent, secret-free backup and restores it", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpg-data-"));
    const backups = mkdtempSync(join(tmpdir(), "gpg-backups-"));
    makeDatabase(join(root, "orchestrator.sqlite"), "before");
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ theme: "dark", apiToken: "do-not-copy", nested: { password: "secret" } }),
    );
    const bundle = await createBackupBundle({
      destinationRoot: backups,
      root,
      now: new Date("2026-07-30T12:34:56.000Z"),
    });
    expect(bundle).toContain("g-plus-g-backup-2026-07-30T12-34-56-000Z");
    const manifest = await validateBackupBundle(bundle);
    expect(manifest.database.quickCheck).toBe("ok");
    expect(manifest.excluded).toContain("profiles/**");
    const settings = readFileSync(join(bundle, "settings.redacted.json"), "utf8");
    expect(settings).toContain("[REDACTED]");
    expect(settings).not.toContain("do-not-copy");
    expect(settings).not.toContain("secret");

    const live = new DatabaseSync(join(root, "orchestrator.sqlite"));
    live.prepare("UPDATE records SET value = ?").run("after");
    live.close();
    await restoreBackupBundle(bundle, root);
    expect(readValue(join(root, "orchestrator.sqlite"))).toBe("before");
    expect(existsSync(join(root, "orchestrator.sqlite.before-restore"))).toBe(true);
  });

  it("rejects a modified database snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpg-data-"));
    const backups = mkdtempSync(join(tmpdir(), "gpg-backups-"));
    makeDatabase(join(root, "orchestrator.sqlite"), "valid");
    const bundle = await createBackupBundle({ destinationRoot: backups, root });
    writeFileSync(join(bundle, "orchestrator.sqlite"), "tampered");
    await expect(validateBackupBundle(bundle)).rejects.toThrow();
  });

  it("reports release identity without requiring git", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpg-info-"));
    const packageFile = join(root, "package.json");
    writeFileSync(packageFile, JSON.stringify({ version: "9.8.7-test" }));
    const info = await getReleaseInfo({ root, packageFile, commit: "abc123" });
    expect(info).toMatchObject({
      appVersion: "9.8.7-test",
      commit: "abc123",
      dataPath: root,
    });
  });

  it("preflight verifies a writable data path and dependencies", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "gpg-preflight-")), "new-data");
    const checks = await runPreflight(root);
    expect(checks.find((check) => check.name === "node")?.status).toBe("pass");
    expect(checks.find((check) => check.name === "data-path")?.status).toBe("pass");
    expect(checks.find((check) => check.name === "playwright")?.status).toBe("pass");
    expect(checks.some((check) => check.status === "fail")).toBe(false);
  });
});
