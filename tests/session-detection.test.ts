import { describe, expect, it } from "vitest";
import { inferSessionState } from "../src/adapters/session-inference.js";

describe("session detection precedence", () => {
  it("does not mistake the anonymous composer for an authenticated session", () => {
    expect(inferSessionState("chatgpt", "Log in  Sign up", 1)).toBe("LOGIN_REQUIRED");
  });

  it("does not mistake Gemini's anonymous editor for an authenticated session", () => {
    expect(inferSessionState("gemini", "Try Gemini  Sign in", 1)).toBe("LOGIN_REQUIRED");
  });

  it("accepts a composer when login actions are absent", () => {
    expect(inferSessionState("chatgpt", "New chat", 1)).toBe("AUTHENTICATED");
  });

  it("detects rate limiting before accepting the composer", () => {
    expect(
      inferSessionState("gemini", "Too many requests. Try again later.", 1),
    ).toBe("RATE_LIMITED");
  });

  it("does not treat conversation text mentioning login as an auth control", () => {
    expect(
      inferSessionState("chatgpt", "The solution says: log in to continue", 1, 0),
    ).toBe("AUTHENTICATED");
  });
});
