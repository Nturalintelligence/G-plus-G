export type TaskComplexity = "TRIVIAL" | "STANDARD";

const TRIVIAL_TASK = /^(?:(?:тест|test|оба тут|вы тут|ты тут|привет|hello|hi|ping)[?!.\s]*|[\d\s+\-*/().=?!]+)$/iu;

export function classifyTaskComplexity(task: string, hasAttachments: boolean): TaskComplexity {
  const normalized = task.replace(/\s+/g, " ").trim();
  if (hasAttachments || normalized.length === 0 || normalized.length > 80) return "STANDARD";
  return TRIVIAL_TASK.test(normalized) ? "TRIVIAL" : "STANDARD";
}

export function discussionTurnBudget(input: {
  requestedTurns: number;
  providerCount: number;
  complexity: TaskComplexity;
}): number {
  if (input.complexity === "TRIVIAL") {
    return Math.min(input.requestedTurns, Math.max(1, input.providerCount));
  }
  return input.requestedTurns;
}
