import { describe, expect, it } from "vitest";
import { buildQualityViewModel } from "../apps/desktop/renderer/quality-view-model.js";

describe("Quality Center view model", () => {
  it("maps persisted metric summaries to the fields displayed by the UI", () => {
    const view = buildQualityViewModel({
      totalSamples: 7,
      overall: [
        { name: "orchestration.run.success", count: 2, average: 0.5, minimum: 0, maximum: 1 },
        { name: "orchestration.run.elapsed_ms", count: 2, average: 1_500, minimum: 1_000, maximum: 2_000 },
      ],
      providers: {
        chatgpt: [
          { name: "provider.turn.success", count: 2, average: 0.5, minimum: 0, maximum: 1 },
          { name: "provider.turn.elapsed_ms", count: 2, average: 300, minimum: 200, maximum: 400 },
          { name: "provider.turn.retry_count", count: 2, average: 0.5, minimum: 0, maximum: 1 },
        ],
      },
    });

    expect(view).toMatchObject({
      totalRuns: 2,
      successfulRuns: 1,
      avgRunDurationMs: 1_500,
      providers: {
        chatgpt: {
          successRate: 0.5,
          totalTurns: 2,
          avgDurationMs: 300,
          retryCount: 1,
          minMs: 200,
          maxMs: 400,
        },
      },
    });
  });
});
