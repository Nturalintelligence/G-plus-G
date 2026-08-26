export function isStableChatGptConversationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && /^\/c\/[^/]+$/.test(url.pathname);
  } catch { return false; }
}

export function preserveChatGptConversationRef(saved: string | null, candidate: string): string | null {
  if (!isStableChatGptConversationUrl(candidate)) return saved && isStableChatGptConversationUrl(saved) ? saved : null;
  const url = new URL(candidate);
  url.search = "";
  url.hash = "";
  return url.toString();
}
