import { describe, expect, it } from "vitest";
import { createAdapter, parseProvider } from "../src/adapters/adapter-registry.js";

describe("adapter registry", () => {
  it("provides both providers through one contract", () => {
    expect(createAdapter("chatgpt").providerId).toBe("chatgpt");
    expect(createAdapter("gemini").providerId).toBe("gemini");
  });

  it("rejects unknown providers", () => {
    expect(() => parseProvider("other")).toThrow(/Неизвестный провайдер/);
  });
});
