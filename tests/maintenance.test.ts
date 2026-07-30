import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backupDatabase,
  resetProviderSession,
  restoreDatabase,
} from "../src/maintenance.js";

describe("maintenance", () => {
  it("backs up and restores a database byte-for-byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "backup-"));
    const database = join(root, "database", "orchestrator.sqlite");
    const backup = join(root, "backup", "snapshot.sqlite");
    mkdirSync(join(root, "database"));
    writeFileSync(database, "version-one", { encoding: "utf8", flag: "wx" });
    await backupDatabase(backup, database);
    writeFileSync(database, "version-two", "utf8");
    await restoreDatabase(backup, database);
    expect(readFileSync(database, "utf8")).toBe("version-one");
  });

  it("resets only the selected provider profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-"));
    const chatgpt = join(root, "chatgpt");
    const gemini = join(root, "gemini");
    writeFileSync(chatgpt, "chatgpt");
    writeFileSync(gemini, "gemini");
    await resetProviderSession("chatgpt", root);
    expect(readFileSync(gemini, "utf8")).toBe("gemini");
  });
});
