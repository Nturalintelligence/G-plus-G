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
    metrics.record("provider.turn.success", 1, { providerId: "chatgpt" });
    metrics.record("provider.turn.success", 0, { providerId: "gemini" });
    const dashboard = metrics.dashboard();
    expect(dashboard.totalSamples).toBe(4);
    expect(dashboard.providers.chatgpt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "provider.turn.success", average: 1 }),
      ]),
    );
    expect(dashboard.providers.gemini).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "provider.turn.success", average: 0 }),
      ]),
    );
    database.close();
  });

  it("rejects unsafe reporting windows", () => {
    const database = new AppDatabase(":memory:");
    database.migrate();
    expect(() => new QualityMetrics(database).dashboard(0)).toThrow();
    database.close();
  });
});
