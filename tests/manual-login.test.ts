import { describe, expect, it } from "vitest";
import {
  canFinalizeManualLogin,
  hasPendingExternalLoginPage,
} from "../src/adapters/manual-login.js";

describe("manual login completion", () => {
  it("does not finalize while an external OAuth page is open", () => {
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

  it("finalizes only explicit authenticated provider UI", () => {
    expect(hasPendingExternalLoginPage("gemini", ["https://gemini.google.com/app"])).toBe(false);
    expect(hasPendingExternalLoginPage("gemini", ["https://gemini.google.example/app"])).toBe(true);
    expect(canFinalizeManualLogin({
      session: "AUTHENTICATED",
      hasExplicitAccountControl: true,
      hasPendingExternalPage: false,
    })).toBe(true);
  });
});
