import { describe, expect, it } from "vitest";
import { classifyProviderResult, ProviderResultProgress } from "../src/adapters/provider-result-state.js";

describe("provider result lifecycle", () => {
  it("distinguishes generation, selection, rendered output and downloads", () => {
    expect(classifyProviderResult({ generationActive: true, selectionCount: 0, responsePresent: false, downloadControlCount: 0, failureVisible: false })).toBe("GENERATING");
    expect(classifyProviderResult({ generationActive: false, selectionCount: 4, responsePresent: true, downloadControlCount: 0, failureVisible: false })).toBe("AWAITING_USER_SELECTION");
    expect(classifyProviderResult({ generationActive: false, selectionCount: 0, responsePresent: true, downloadControlCount: 0, failureVisible: false })).toBe("RESULT_RENDERED");
    expect(classifyProviderResult({ generationActive: false, selectionCount: 0, responsePresent: true, downloadControlCount: 1, failureVisible: false })).toBe("DOWNLOAD_EVIDENCE_ONLY");
  });

  it("extends only on state progress and always enforces the absolute deadline", () => {
    const tracker = new ProviderResultProgress(1_000, 10_000);
    expect(tracker.update("GENERATING", 2_000)).toBe(true);
    expect(tracker.update("GENERATING", 8_000)).toBe(false);
    expect(tracker.timedOut(8_001, 6_000)).toBe(true);
    expect(tracker.update("DOWNLOAD_EVIDENCE_ONLY", 8_100)).toBe(true);
    expect(tracker.timedOut(11_000, 6_000)).toBe(true);
  });
});
