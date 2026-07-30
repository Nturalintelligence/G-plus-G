import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileLock } from "../src/browser/profile-lock.js";

describe("ProfileLock", () => {
  it("prevents two live owners from using one profile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "profile-lock-"));
    const first = new ProfileLock(join(directory, "profile"));
    const second = new ProfileLock(join(directory, "profile"));
    await first.acquire();
    await expect(second.acquire()).rejects.toThrow(/already in use/);
    await first.release();
    await expect(second.acquire()).resolves.toBeUndefined();
    await second.release();
  });
});
