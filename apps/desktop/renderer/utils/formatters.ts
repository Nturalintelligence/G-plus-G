export function formatDuration(ms: number): string {
  if (ms == null || isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} с`;
  return `${(ms / 60000).toFixed(1)} мин`;
}
