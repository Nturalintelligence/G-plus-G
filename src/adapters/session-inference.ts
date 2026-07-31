import type { SessionState } from "../types.js";
import type { ProviderId } from "../settings/settings.js";

export function inferSessionState(
  providerId: ProviderId,
  body: string,
  composerCount: number,
  loginControlCount?: number,
): SessionState {
  const loginPattern =
    providerId === "chatgpt"
      ? /log in|sign up|войти|регистрац/i
      : providerId === "gemini"
      ? /sign in|войти/i
      : /log in|sign in|войти|регистрац/i;
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
