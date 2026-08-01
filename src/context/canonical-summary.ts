import type { DecisionLedger } from "./decision-ledger.js";

export interface CanonicalSummary {
  projectId: string;
  generatedAt: string;
  summaryText: string;
  turnCount: number;
  ledgerPrompt: string;
}

export function buildCanonicalSummary(
  projectId: string,
  transcriptEntries: Array<{ role: string; content: string }>,
  ledger?: DecisionLedger,
): CanonicalSummary {
  const userPrompts = transcriptEntries
    .filter((e) => e.role === "USER")
    .map((e) => e.content)
    .slice(-5);
  const summaryText = `Сводка проекта ${projectId}: выполнено ${transcriptEntries.length} ходов. Последний запрос пользователя: "${userPrompts[userPrompts.length - 1] || "—"}"`;
  
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    summaryText,
    turnCount: transcriptEntries.length,
    ledgerPrompt: ledger ? ledger.buildLedgerSummaryPrompt() : "",
  };
}
