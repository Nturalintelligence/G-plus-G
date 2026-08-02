import { describe, expect, it } from "vitest";
import { formatProviderList, getProviderDisplayName, getProviderMetadata } from "../apps/desktop/renderer/provider-metadata.js";
import { formatDuration } from "../apps/desktop/renderer/utils/formatters.js";
import { defaultSettings, parseSettings } from "../src/settings/settings.js";
import { inferSessionState } from "../src/adapters/session-inference.js";
import { LoginCancelledError, LoginTimeoutError } from "../src/errors.js";

describe("G+G Corrective Pass Metadata & Utilities", () => {
  it("normalizes technical provider IDs to clean human-readable names", () => {
    expect(getProviderDisplayName("chatgpt")).toBe("ChatGPT");
    expect(getProviderDisplayName("gemini")).toBe("Gemini");
    expect(getProviderDisplayName("deepseek")).toBe("DeepSeek");
    expect(getProviderDisplayName("claude")).toBe("Claude");
    expect(getProviderDisplayName("copilot")).toBe("GitHub Copilot");
  });

  it("appends Web suffix when requested in context", () => {
    expect(getProviderDisplayName("chatgpt", true)).toBe("ChatGPT Web");
    expect(getProviderDisplayName("gemini", true)).toBe("Gemini Web");
  });

  it("handles unknown provider IDs gracefully without showing raw technical key", () => {
    const meta = getProviderMetadata("unknown_ai");
    expect(meta.displayName).toBe("Unknown_ai");
    expect(meta.isSupported).toBe(false);
  });

  it("formats provider list as clean human-readable comma separated string", () => {
    expect(formatProviderList(["chatgpt", "gemini"])).toBe("ChatGPT, Gemini");
    expect(formatProviderList(["deepseek"])).toBe("DeepSeek");
    expect(formatProviderList([])).toBe("Не выбраны");
  });

  it("formatDuration explicitly formats ms, seconds, and minutes without mixing units", () => {
    expect(formatDuration(450)).toBe("450 мс");
    expect(formatDuration(32000)).toBe("32.0 с");
    expect(formatDuration(144000)).toBe("2.4 мин");
    expect(formatDuration(0)).toBe("0 мс");
    expect(formatDuration(-10)).toBe("—");
  });

  it("parseSettings preserves models custom prompts and roles across save round-trip", () => {
    const input = {
      ...defaultSettings,
      models: {
        chatgpt: { role: "Архитектор / Планнер", customPrompt: "Always respond in JSON" },
        gemini: { role: "Критик / Валидатор", customPrompt: "Check for security bugs" },
      },
    };
    const parsed = parseSettings(input);
    expect(parsed.models).toBeDefined();
    expect(parsed.models?.chatgpt?.role).toBe("Архитектор / Планнер");
    expect(parsed.models?.chatgpt?.customPrompt).toBe("Always respond in JSON");
    expect(parsed.models?.gemini?.role).toBe("Критик / Валидатор");
  });

  it("inferSessionState evaluates multi-signal probe with user menu and composer count", () => {
    expect(inferSessionState("chatgpt", "", 1, 0, { hasUserMenu: true })).toBe("AUTHENTICATED");
    expect(inferSessionState("chatgpt", "", 0, 0, { hasUserMenu: true })).toBe("AUTHENTICATED");
    expect(inferSessionState("chatgpt", "", 0, 2, { hasUserMenu: false })).toBe("LOGIN_REQUIRED");
    expect(inferSessionState("chatgpt", "", 0, 0, { hasChallenge: true })).toBe("CHALLENGE_REQUIRED");
  });

  it("instantiates typed LoginCancelledError and LoginTimeoutError correctly", () => {
    const cancelErr = new LoginCancelledError();
    expect(cancelErr.name).toBe("LoginCancelledError");
    expect(cancelErr.message).toContain("закрыл окно");

    const timeoutErr = new LoginTimeoutError();
    expect(timeoutErr.name).toBe("LoginTimeoutError");
    expect(timeoutErr.message).toContain("истекло");
  });
});
