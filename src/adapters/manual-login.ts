import type { SessionState } from "../types.js";

type InteractiveProvider = "chatgpt" | "gemini";

export function hasPendingExternalLoginPage(
  provider: InteractiveProvider,
  pageUrls: string[],
): boolean {
  const providerHost = provider === "chatgpt" ? "chatgpt.com" : "gemini.google.com";
  return pageUrls.some((url) => {
    try {
      const hostname = new URL(url).hostname;
      return hostname !== providerHost && !hostname.endsWith(`.${providerHost}`);
    } catch {
      return true;
    }
  });
}

export function canFinalizeManualLogin(input: {
  session: SessionState;
  hasExplicitAccountControl: boolean;
  hasPendingExternalPage: boolean;
}): boolean {
  return (
    input.session === "AUTHENTICATED" &&
    input.hasExplicitAccountControl &&
    !input.hasPendingExternalPage
  );
}
