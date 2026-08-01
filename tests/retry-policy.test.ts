import { describe, expect, it } from "vitest";
import {
  calculateRetryDelay,
  defaultRetryConfig,
  isRetryableError,
} from "../src/orchestrator/retry-policy.js";

describe("RetryPolicy", () => {
  it("calculates exponential backoff delays up to maxDelayMs", () => {
    const config = {
      maxRetries: 3,
      initialDelayMs: 500,
      maxDelayMs: 3000,
      backoffFactor: 2,
    };

    expect(calculateRetryDelay(1, config)).toBe(500);
    expect(calculateRetryDelay(2, config)).toBe(1000);
    expect(calculateRetryDelay(3, config)).toBe(2000);
    expect(calculateRetryDelay(4, config)).toBe(3000); // capped at maxDelayMs
  });

  it("identifies retryable vs non-retryable errors correctly", () => {
    expect(isRetryableError(new Error("Network timeout"))).toBe(true);
    expect(isRetryableError(new Error("Target page closed"))).toBe(false);
    expect(isRetryableError(new Error("Profile is already in use"))).toBe(false);
  });
});
