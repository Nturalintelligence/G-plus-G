import type { SessionState } from "../types.js";
import type { ProviderId } from "../settings/settings.js";

export interface SessionProbeEvidence {
  hasComposer: boolean;
  loginControlCount: number;
  hasUserMenu?: boolean;
  hasChallenge?: boolean;
  isRateLimited?: boolean;
  url?: string;
}

export function inferSessionState(
  providerId: ProviderId,
  body: string,
  composerCount: number,
  loginControlCount?: number,
  evidence: Partial<SessionProbeEvidence> = {},
): SessionState {
  if (evidence.hasChallenge) return "CHALLENGE_REQUIRED";
  if (
    evidence.isRateLimited ||
    /too many requests|rate limit|слишком много запросов|temporarily unavailable/i.test(body)
  ) {
    return "RATE_LIMITED";
  }

  if (loginControlCount !== undefined) {
    if (loginControlCount > 0) return "LOGIN_REQUIRED";
    if (evidence.hasUserMenu || composerCount >= 1) return "AUTHENTICATED";
    return "UNKNOWN";
  }

  const loginPattern =
    providerId === "chatgpt"
      ? /log in|sign up|войти|регистрац/i
      : providerId === "gemini"
      ? /sign in|войти/i
      : /log in|sign in|войти|регистрац/i;

  if (loginPattern.test(body) && !evidence.hasUserMenu) return "LOGIN_REQUIRED";
  if (evidence.hasUserMenu || composerCount >= 1) return "AUTHENTICATED";
  return "UNKNOWN";
}
