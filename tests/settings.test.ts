import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  parseSettings,
  SettingsStore,
} from "../src/settings/settings.js";

describe("settings", () => {
  it("supplies safe defaults for a missing file", () => {
    const store = new SettingsStore(join(mkdtempSync(join(tmpdir(), "gpg-settings-")), "settings.json"));
    expect(store.load()).toEqual(defaultSettings);
  });

  it("validates, normalizes and persists settings", () => {
    const file = join(mkdtempSync(join(tmpdir(), "gpg-settings-")), "settings.json");
    const store = new SettingsStore(file);
    const saved = store.save({
      profile: { displayName: "  Ada  " },
      defaults: {
        mode: "PARALLEL",
        providers: ["gemini", "gemini"],
        limits: { maxTurns: 8, maxTurnMs: 90000, maxSessionMs: 600000, maxRetries: 2, confirmationEvery: 3, requireConfirmation: true },
      },
      appearance: { theme: "light", density: "compact", fontScale: 110, discussionView: "FULLSCREEN" },
      secret: "must-not-survive",
    });
    expect(saved.profile.displayName).toBe("Ada");
    expect(saved.defaults.providers).toEqual(["gemini"]);
    expect(saved.defaults.limits.requireConfirmation).toBe(true);
    expect(saved.appearance.discussionView).toBe("FULLSCREEN");
    expect(readFileSync(file, "utf8")).not.toContain("must-not-survive");
    expect(store.load()).toEqual(saved);
  });

  it("defaults unknown discussion presentation to the right drawer", () => {
    expect(parseSettings({ ...defaultSettings, appearance: { ...defaultSettings.appearance, discussionView: "WINDOW" } }).appearance.discussionView)
      .toBe("RIGHT_DRAWER");
  });

  it("rejects unsafe values", () => {
    expect(() => parseSettings({
      ...defaultSettings,
      defaults: {
        ...defaultSettings.defaults,
        limits: { ...defaultSettings.defaults.limits, maxTurns: 500 },
      },
    })).toThrow("maxTurns");
    expect(() => parseSettings({
      ...defaultSettings,
      appearance: { ...defaultSettings.appearance, fontScale: 200 },
    })).toThrow("Font scale");
  });
});
