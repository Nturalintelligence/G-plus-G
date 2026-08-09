export interface QualityMetricSummary {
  name: string;
  count: number;
  average: number;
  minimum: number;
  maximum: number;
}

export interface QualityDashboardData {
  totalSamples: number;
  overall: QualityMetricSummary[];
  providers: Record<string, QualityMetricSummary[]>;
}

function metric(metrics: QualityMetricSummary[], name: string): QualityMetricSummary | undefined {
  return metrics.find((candidate) => candidate.name === name);
}

export function buildQualityViewModel(dashboard: QualityDashboardData) {
  const runSuccess = metric(dashboard.overall, "orchestration.run.success");
  const runDuration = metric(dashboard.overall, "orchestration.run.elapsed_ms");
  return {
    totalSamples: dashboard.totalSamples,
    totalRuns: runSuccess?.count ?? runDuration?.count ?? 0,
    successfulRuns: runSuccess ? Math.round(runSuccess.average * runSuccess.count) : 0,
    avgRunDurationMs: runDuration?.average,
    providers: Object.fromEntries(
      Object.entries(dashboard.providers).map(([providerId, metrics]) => {
        const success = metric(metrics, "provider.turn.success");
        const duration = metric(metrics, "provider.turn.elapsed_ms");
        const retries = metric(metrics, "provider.turn.retry_count");
        return [providerId, {
          successRate: success?.average,
          totalTurns: success?.count ?? duration?.count ?? 0,
          avgDurationMs: duration?.average,
          retryCount: retries ? Math.round(retries.average * retries.count) : 0,
          sampleCount: metrics.reduce((total, item) => total + item.count, 0),
          minMs: duration?.minimum,
          maxMs: duration?.maximum,
        }];
      }),
    ),
  };
}
