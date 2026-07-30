import { newId } from "../ids.js";
import type { AppDatabase } from "../storage/database.js";

export interface MetricSummary {
  name: string;
  count: number;
  average: number;
  minimum: number;
  maximum: number;
}
export class QualityMetrics {
  constructor(private readonly database: AppDatabase) {}

  record(name: string, value: number, tags: Record<string, string> = {}): void {
    if (!name.trim() || !Number.isFinite(value)) {
      throw new Error("Metric name and finite value are required");
    }
    this.database.raw
      .prepare(
        `INSERT INTO quality_metrics(id, name, value, tags_json, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        newId("met"),
        name,
        value,
        JSON.stringify(tags),
        new Date().toISOString(),
      );
  }

  summaries(): MetricSummary[] {
    return this.database.raw
      .prepare(
        `SELECT name, COUNT(*) AS count, AVG(value) AS average,
                MIN(value) AS minimum, MAX(value) AS maximum
         FROM quality_metrics GROUP BY name ORDER BY name`,
      )
      .all()
      .map((row) => ({
        name: String(row.name),
        count: Number(row.count),
        average: Number(row.average),
        minimum: Number(row.minimum),
        maximum: Number(row.maximum),
      }));
  }
}
