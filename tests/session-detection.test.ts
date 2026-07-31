import { describe, expect, it } from "vitest";
import { inferSessionState } from "../src/adapters/session-inference.js";
import { inferChallengePage } from "../src/adapters/challenge-inference.js";

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

describe("challenge page inference", () => {
  it("does not treat model discussion of CAPTCHA or Cloudflare as a challenge", () => {
    expect(inferChallengePage({
      url: "https://chatgpt.com/c/example",
      title: "ChatGPT",
      structuralSignals: 0,
    })).toBe(false);
  });

  it("detects structural and dedicated challenge pages", () => {
    expect(inferChallengePage({
      url: "https://chatgpt.com/cdn-cgi/challenge-platform/test",
      title: "Just a moment",
      structuralSignals: 0,
    })).toBe(true);
    expect(inferChallengePage({
      url: "https://chatgpt.com/",
      title: "ChatGPT",
      structuralSignals: 1,
    })).toBe(true);
  });
});
