import type { SessionState } from "../types.js";

export type InteractiveProvider = "chatgpt" | "gemini";

function isProviderHost(provider: InteractiveProvider, hostname: string): boolean {
  const providerHost = provider === "chatgpt" ? "chatgpt.com" : "gemini.google.com";
  return hostname === providerHost || hostname.endsWith(`.${providerHost}`);
}

export function hasPendingExternalLoginPage(
  provider: InteractiveProvider,
  pageUrls: readonly string[],
): boolean {
  return pageUrls.some((url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      return !isProviderHost(provider, parsed.hostname.toLowerCase());
    } catch {
      return false;
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
