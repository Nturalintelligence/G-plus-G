import { describe, expect, it } from "vitest";
import { selectReadyAnswerEntries } from "../apps/desktop/renderer/ready-answer.js";

describe("READY answer transcript", () => {
  it("does not expose intermediate provider responses before the explicit final", () => {
    const result = selectReadyAnswerEntries([
      { id: "user", role: "USER", providerId: null },
      { id: "chatgpt", role: "ASSISTANT", providerId: "chatgpt" },
      { id: "gemini", role: "ASSISTANT", providerId: "gemini" },
    ]);

    expect(result.finalEntry).toBeUndefined();
    expect(result.visibleEntries.map((entry) => entry.id)).toEqual(["user"]);
    expect(result.artifactEntries).toEqual([]);
  });

  it("restores provider artifact cards without exposing hidden intermediate text", () => {
    const result = selectReadyAnswerEntries([
      { id: "user", role: "USER", providerId: null },
      { id: "chatgpt-turn", role: "ASSISTANT", providerId: "chatgpt", attachments: [{ source: "chatgpt" }] },
      { id: "gemini-turn", role: "ASSISTANT", providerId: "gemini", attachments: [{ source: "gemini" }] },
    ]);

    expect(result.visibleEntries.map((entry) => entry.id)).toEqual(["user"]);
    expect(result.artifactEntries.map((entry) => entry.id)).toEqual(["chatgpt-turn", "gemini-turn"]);
  });

  it("rejects cross-provider artifact attribution", () => {
    const result = selectReadyAnswerEntries([
      { id: "chatgpt-turn", role: "ASSISTANT", providerId: "chatgpt", attachments: [{ source: "gemini" }] },
      { id: "synthetic", role: "ASSISTANT", providerId: "final", attachments: [{ source: "chatgpt" }] },
    ]);

    expect(result.artifactEntries).toEqual([]);
  });

  it("shows only the latest explicit final alongside user and system entries", () => {
    const result = selectReadyAnswerEntries([
      { id: "user", role: "USER", providerId: null },
      { id: "candidate", role: "ASSISTANT", providerId: "chatgpt" },
      { id: "old-final", role: "ASSISTANT", providerId: "final" },
      { id: "system", role: "ASSISTANT", providerId: "system" },
      { id: "new-final", role: "ASSISTANT", providerId: "final" },
    ]);

    expect(result.finalEntry?.id).toBe("new-final");
    expect(result.visibleEntries.map((entry) => entry.id)).toEqual([
      "user",
      "system",
      "new-final",
    ]);
  });
});
