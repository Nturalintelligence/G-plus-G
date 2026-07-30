import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { QualityMetrics } from "../src/observability/metrics.js";

describe("quality metrics", () => {
  it("stores only numeric measurements and produces summaries", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    const metrics = new QualityMetrics(database);
    metrics.record("provider.turn.elapsed_ms", 100, { providerId: "chatgpt" });
    metrics.record("provider.turn.elapsed_ms", 300, { providerId: "chatgpt" });
    expect(metrics.summaries()).toContainEqual({
      name: "provider.turn.elapsed_ms",
      count: 2,
      average: 200,
      minimum: 100,
      maximum: 300,
    });
    database.close();
  });
});
