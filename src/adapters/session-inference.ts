import type { SessionState } from "../types.js";

export function inferSessionState(
  providerId: "chatgpt" | "gemini",
  body: string,
  composerCount: number,
  loginControlCount?: number,
): SessionState {
  const loginPattern =
    providerId === "chatgpt"
      ? /log in|sign up|войти|регистрац/i
      : /sign in|войти/i;
  if (
    /too many requests|rate limit|слишком много запросов|temporarily unavailable/i.test(
      body,
    )
  ) {
    return "RATE_LIMITED";
  }
  if (loginControlCount !== undefined) {
    if (loginControlCount > 0) return "LOGIN_REQUIRED";
    if (composerCount === 1) return "AUTHENTICATED";
    return "UNKNOWN";
  }
  if (loginPattern.test(body)) return "LOGIN_REQUIRED";
  if (composerCount === 1) return "AUTHENTICATED";
  return "UNKNOWN";
}
