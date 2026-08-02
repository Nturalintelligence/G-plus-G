export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export const defaultRetryConfig: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffFactor: 2,
};

export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig = defaultRetryConfig,
): number {
  if (attempt <= 0) return 0;
  const rawDelay = config.initialDelayMs * Math.pow(config.backoffFactor, attempt - 1);
  return Math.min(rawDelay, config.maxDelayMs);
}

export function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Non-retryable errors: profile locked, browser context closed manually, session expired, invalid arguments
  const nonRetryablePattern =
    /target (page|context|browser).*closed|profile is already in use|session expired|login required|invalid arguments/i;
  return !nonRetryablePattern.test(message);
}
