export interface ContextBudgetConfig {
  maxCharacters: number;
  warnCharactersThreshold: number;
}

export const defaultContextBudget: ContextBudgetConfig = {
  maxCharacters: 120_000,
  warnCharactersThreshold: 90_000,
};

export class ContextBudgeter {
  constructor(private readonly config: ContextBudgetConfig = defaultContextBudget) {}

  calculateTotalLength(entries: Array<{ content: string }>): number {
    return entries.reduce((acc, entry) => acc + (entry.content?.length || 0), 0);
  }

  isOverflow(entries: Array<{ content: string }>): boolean {
    return this.calculateTotalLength(entries) >= this.config.maxCharacters;
  }

  isWarning(entries: Array<{ content: string }>): boolean {
    return this.calculateTotalLength(entries) >= this.config.warnCharactersThreshold;
  }
}
