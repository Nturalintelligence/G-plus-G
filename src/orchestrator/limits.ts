export interface OrchestrationLimits {
  maxTurns: number;
  maxTurnMs: number;
  maxSessionMs: number;
  maxRetries: number;
  confirmationEvery: number;
}

export const defaultLimits: OrchestrationLimits = {
  maxTurns: 6,
  maxTurnMs: 180_000,
  maxSessionMs: 900_000,
  maxRetries: 1,
  confirmationEvery: 2,
};

export function validateLimits(limits: OrchestrationLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid limit ${name}: ${value}`);
  }
  if (limits.maxTurns > 50) throw new Error("maxTurns cannot exceed 50");
}
