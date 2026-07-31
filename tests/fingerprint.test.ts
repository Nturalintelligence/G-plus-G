import { describe, expect, it } from "vitest";
import { fingerprint, selectNewResponse } from "../src/fingerprint.js";
import type { ResponseSnapshot } from "../src/types.js";

function response(ordinal: number, text: string, domId: string | null = null): ResponseSnapshot {
  return { ordinal, text, domId, fingerprint: fingerprint(text) };
}

describe("selectNewResponse", () => {
  it("binds a genuinely new response after the baseline", () => {
    const before = [response(0, "old", "a")];
    const after = [...before, response(1, "new", "b")];
    expect(selectNewResponse(before, after)?.text).toBe("new");
  });

  it("does not identify an edited old last block as the new response", () => {
    const before = [response(0, "old", "a")];
    const after = [response(0, "old but edited", "a")];
    expect(selectNewResponse(before, after)).toBeNull();
  });

  it("returns the newest candidate when multiple new response candidates are present", () => {
    const before = [response(0, "old", "a")];
    const after = [...before, response(1, "one", "b"), response(2, "two", "c")];
    expect(selectNewResponse(before, after)?.text).toBe("two");
  });

  it("binds a new stable id when a virtualized list reuses the last ordinal", () => {
    const before = [
      response(0, "old one", "a"),
      response(1, "old two", "b"),
      response(2, "old three", "c"),
    ];
    const after = [
      response(0, "old two", "b"),
      response(1, "old three", "c"),
      response(2, "new streamed response", "d"),
    ];
    expect(selectNewResponse(before, after)?.text).toBe("new streamed response");
  });

  it("can bind an id-less response by baseline ordinal", () => {
    const before = [response(0, "old")];
    const after = [...before, response(1, "new")];
    expect(selectNewResponse(before, after)?.text).toBe("new");
  });
});
