export interface OrchestrationLimits {
  maxTurns: number;
  maxTurnMs: number;
  maxSessionMs: number;
  maxRetries: number;
  confirmationEvery: number;
  requireConfirmation?: boolean;
}

export const defaultLimits: OrchestrationLimits = {
  maxTurns: 6,
  maxTurnMs: 180_000,
  maxSessionMs: 900_000,
  maxRetries: 1,
  confirmationEvery: 2,
  requireConfirmation: false,
};

export function validateLimits(limits: OrchestrationLimits): void {
  for (const [name, value] of Object.entries({
    maxTurns: limits.maxTurns,
    maxTurnMs: limits.maxTurnMs,
    maxSessionMs: limits.maxSessionMs,
    maxRetries: limits.maxRetries,
    confirmationEvery: limits.confirmationEvery,
  })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid limit ${name}: ${value}`);
  }
  if (
    limits.requireConfirmation !== undefined &&
    typeof limits.requireConfirmation !== "boolean"
  ) {
    throw new Error("requireConfirmation must be boolean");
  }
  if (limits.maxTurns > 50) throw new Error("maxTurns cannot exceed 50");
}
