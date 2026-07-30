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

  it("fails closed when multiple new response candidates are present", () => {
    const before = [response(0, "old", "a")];
    const after = [...before, response(1, "one", "b"), response(2, "two", "c")];
    expect(selectNewResponse(before, after)).toBeNull();
  });

  it("can bind an id-less response by baseline ordinal", () => {
    const before = [response(0, "old")];
    const after = [...before, response(1, "new")];
    expect(selectNewResponse(before, after)?.text).toBe("new");
  });
});
