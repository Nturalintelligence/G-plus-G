import { describe, expect, it } from "vitest";

function inferSession(body: string, composerCount: number): "LOGIN_REQUIRED" | "AUTHENTICATED" | "UNKNOWN" {
  if (/log in|sign in|sign up|войти|регистрац/i.test(body)) return "LOGIN_REQUIRED";
  if (composerCount === 1) return "AUTHENTICATED";
  return "UNKNOWN";
}

describe("session detection precedence", () => {
  it("does not mistake the anonymous composer for an authenticated session", () => {
    expect(inferSession("Log in  Sign up", 1)).toBe("LOGIN_REQUIRED");
  });

  it("does not mistake Gemini's anonymous editor for an authenticated session", () => {
    expect(inferSession("Try Gemini  Sign in", 1)).toBe("LOGIN_REQUIRED");
  });

  it("accepts a composer when login actions are absent", () => {
    expect(inferSession("New chat", 1)).toBe("AUTHENTICATED");
  });
});
