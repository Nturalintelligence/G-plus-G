export interface LedgerItem {
  id: string;
  category: "requirement" | "constraint" | "decision";
  title: string;
  description: string;
  sourceTurnId?: string;
  timestamp: string;
}

export class DecisionLedger {
  private items: LedgerItem[] = [];

  addItem(item: Omit<LedgerItem, "id" | "timestamp">): LedgerItem {
    const record: LedgerItem = {
      ...item,
      id: `ledg_${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
    };
    this.items.push(record);
    return record;
  }

  getItems(): readonly LedgerItem[] {
    return this.items;
  }

  buildLedgerSummaryPrompt(): string {
    if (this.items.length === 0) return "";
    const lines = this.items.map(
      (item) => `- [${item.category.toUpperCase()}] ${item.title}: ${item.description}`,
    );
    return `### УТВЕРЖДЁННЫЕ РЕШЕНИЯ И ОГРАНИЧЕНИЯ ПРОЕКТА (DECISION LEDGER):\n${lines.join("\n")}\n*Эти решения считаются финальными и не подлежат повторному пересмотру без явного указания пользователя.*`;
  }
}
