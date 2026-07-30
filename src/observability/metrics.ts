import { newId } from "../ids.js";
import type { AppDatabase } from "../storage/database.js";

export interface MetricSummary {
  name: string;
  count: number;
  average: number;
  minimum: number;
  maximum: number;
}

export interface QualityDashboard {
  generatedAt: string;
  windowDays: number;
  totalSamples: number;
  overall: MetricSummary[];
  providers: Record<string, MetricSummary[]>;
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

  dashboard(windowDays = 30): QualityDashboard {
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
      throw new Error("Metric window must be between 1 and 365 days");
    }
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const rows = this.database.raw
      .prepare(
        `SELECT name, value, tags_json
         FROM quality_metrics
         WHERE occurred_at >= ?
         ORDER BY occurred_at`,
      )
      .all(cutoff);
    const overall = summarizeRows(rows);
    const byProvider = new Map<string, typeof rows>();
    for (const row of rows) {
      let providerId: string | undefined;
      try {
        const tags = JSON.parse(String(row.tags_json)) as Record<string, unknown>;
        if (typeof tags.providerId === "string") providerId = tags.providerId;
      } catch {
        // Malformed historical tags remain part of the overall summary only.
      }
      if (!providerId) continue;
      const providerRows = byProvider.get(providerId) ?? [];
      providerRows.push(row);
      byProvider.set(providerId, providerRows);
    }
    return {
      generatedAt: new Date().toISOString(),
      windowDays,
      totalSamples: rows.length,
      overall,
      providers: Object.fromEntries(
        [...byProvider.entries()].map(([providerId, providerRows]) => [
          providerId,
          summarizeRows(providerRows),
        ]),
      ),
    };
  }
}

function summarizeRows(
  rows: Array<Record<string, unknown>>,
): MetricSummary[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const name = String(row.name);
    const values = groups.get(name) ?? [];
    values.push(Number(row.value));
    groups.set(name, values);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, values]) => ({
      name,
      count: values.length,
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      minimum: Math.min(...values),
      maximum: Math.max(...values),
    }));
}
