import { describe, expect, it } from "vitest";
import { isStableChatGptConversationUrl, preserveChatGptConversationRef } from "../src/adapters/chatgpt-conversation-ref.js";

describe("ChatGPT conversation reference persistence across downloads", () => {
  const saved = "https://chatgpt.com/c/conversation-fixture";
  it("accepts only stable provider conversation URLs", () => {
    expect(isStableChatGptConversationUrl(saved)).toBe(true);
    expect(isStableChatGptConversationUrl("https://chatgpt.com/")).toBe(false);
    expect(isStableChatGptConversationUrl("https://files.oaiusercontent.com/download/file.txt")).toBe(false);
    expect(isStableChatGptConversationUrl("blob:https://chatgpt.com/id")).toBe(false);
  });
  it("preserves the saved conversation across popup, file navigation and malformed candidates", () => {
    expect(preserveChatGptConversationRef(saved, "https://files.oaiusercontent.com/download/file.txt")).toBe(saved);
    expect(preserveChatGptConversationRef(saved, "blob:https://chatgpt.com/id")).toBe(saved);
    expect(preserveChatGptConversationRef(saved, "not a url")).toBe(saved);
  });
  it("stores a clean replacement conversation URL without query or fragment", () => {
    expect(preserveChatGptConversationRef(saved, "https://chatgpt.com/c/new-conversation?temporary=1#download"))
      .toBe("https://chatgpt.com/c/new-conversation");
  });
});
