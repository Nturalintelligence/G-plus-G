import crypto from "node:crypto";

export interface ParsedProtocolResponse {
  delta: string;
  decisionUpdate: string;
  risks: string;
  nextAction: string;
  publicSummary: string;
  done: boolean;
  hasCliTasks: boolean;
}

export interface ValueGateEvaluation {
  isValuable: boolean;
  consecutiveLowValueCount: number;
  shouldSendCorrectivePrompt: boolean;
  shouldStopRun: boolean;
  correctivePromptText?: string | null | undefined;
  reason: string;
}

export function parseProtocolSections(text: string): ParsedProtocolResponse {
  const getSection = (key: string): string => {
    const regex = new RegExp(`${key}\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_]{3,}\\n|$)`, "i");
    const match = regex.exec(text);
    return match && match[1] ? match[1].trim() : "NONE";
  };

  const delta = getSection("DELTA");
  const decisionUpdate = getSection("DECISION_UPDATE");
  const risks = getSection("RISKS");
  const nextAction = getSection("NEXT_ACTION").toUpperCase();
  const publicSummary = getSection("PUBLIC_SUMMARY");
  const doneText = getSection("DONE").toUpperCase();

  return {
    delta,
    decisionUpdate,
    risks,
    nextAction: nextAction || "DISCUSS",
    publicSummary,
    done: doneText.includes("YES"),
    hasCliTasks: text.includes("[[G_PLUS_G_CLI_TASK_V1]]"),
  };
}

export function computeNormalizedHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function computeTokenJaccardSimilarity(text1: string, text2: string): number {
  const tokenize = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );

  const set1 = tokenize(text1);
  const set2 = tokenize(text2);

  if (set1.size === 0 && set2.size === 0) return 1.0;
  if (set1.size === 0 || set2.size === 0) return 0.0;

  let intersection = 0;
  for (const token of set1) {
    if (set2.has(token)) intersection++;
  }

  const union = set1.size + set2.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}

export class TurnValueGate {
  private recentDeltas: string[] = [];
  private consecutiveLowValueTurns = 0;
  private maxConsecutiveLowValue = 3;

  constructor(maxConsecutiveLowValue = 3) {
    this.maxConsecutiveLowValue = maxConsecutiveLowValue;
  }

  public reset(): void {
    this.recentDeltas = [];
    this.consecutiveLowValueTurns = 0;
  }

  public evaluateTurn(responseText: string): ValueGateEvaluation {
    const parsed = parseProtocolSections(responseText);

    const hasNewDelta = parsed.delta !== "NONE" && parsed.delta.length > 10;
    const hasDecision = parsed.decisionUpdate !== "NONE";
    const hasNewRisk = parsed.risks !== "NONE";
    const hasTask = parsed.hasCliTasks;
    const isDone = parsed.done;

    // Check similarity with recent deltas
    let isDuplicateDelta = false;
    for (const priorDelta of this.recentDeltas) {
      const sim = computeTokenJaccardSimilarity(parsed.delta, priorDelta);
      if (sim > 0.85) {
        isDuplicateDelta = true;
        break;
      }
    }

    const isValuable = (hasNewDelta || hasDecision || hasNewRisk || hasTask || isDone) && !isDuplicateDelta;

    if (isValuable) {
      this.consecutiveLowValueTurns = 0;
      if (hasNewDelta) {
        this.recentDeltas.push(parsed.delta);
        if (this.recentDeltas.length > 5) this.recentDeltas.shift();
      }
      return {
        isValuable: true,
        consecutiveLowValueCount: 0,
        shouldSendCorrectivePrompt: false,
        shouldStopRun: false,
        reason: "Turn provided material value or actionable CLI task",
      };
    } else {
      this.consecutiveLowValueTurns++;

      const shouldStop = this.consecutiveLowValueTurns >= this.maxConsecutiveLowValue;
      const shouldCorrect = this.consecutiveLowValueTurns === 2;

      return {
        isValuable: false,
        consecutiveLowValueCount: this.consecutiveLowValueTurns,
        shouldSendCorrectivePrompt: shouldCorrect,
        shouldStopRun: shouldStop,
        correctivePromptText: shouldCorrect
          ? "CORRECTIVE DIRECTIVE: Добавь только новый материал либо выбери EXECUTE/ASK_USER/DONE."
          : null,
        reason: isDuplicateDelta
          ? "Turn content is highly similar to prior turn (repetition)"
          : "Turn contained no material delta, decision update, new risk, or CLI task",
      };
    }
  }
}
