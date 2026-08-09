import { describe, expect, it } from "vitest";
import {
  canFinalizeManualLogin,
  hasPendingExternalLoginPage,
} from "../src/adapters/manual-login.js";

describe("manual login completion", () => {
  it("does not finalize ChatGPT while an OAuth page is open", () => {
    const pending = hasPendingExternalLoginPage("chatgpt", [
      "https://chatgpt.com/",
      "https://accounts.google.com/o/oauth2/auth",
    ]);
    expect(pending).toBe(true);
    expect(canFinalizeManualLogin({
      session: "AUTHENTICATED",
      hasExplicitAccountControl: true,
      hasPendingExternalPage: pending,
    })).toBe(false);
  });

  it("does not accept an anonymous composer without an account control", () => {
    expect(canFinalizeManualLogin({
      session: "AUTHENTICATED",
      hasExplicitAccountControl: false,
      hasPendingExternalPage: false,
    })).toBe(false);
  });

  it("ignores non-web placeholders and finalizes only explicit provider UI", () => {
    expect(hasPendingExternalLoginPage("chatgpt", ["about:blank", "https://chatgpt.com/"])).toBe(false);
    expect(hasPendingExternalLoginPage("gemini", ["https://gemini.google.com/app"])).toBe(false);
    expect(hasPendingExternalLoginPage("gemini", ["https://accounts.google.com/signin"])).toBe(true);
    expect(canFinalizeManualLogin({
      session: "AUTHENTICATED",
      hasExplicitAccountControl: true,
      hasPendingExternalPage: false,
    })).toBe(true);
  });
});
