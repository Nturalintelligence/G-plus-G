import { normalizeText } from "../fingerprint.js";

export type SubmissionEvidenceLevel =
  | "STRONG_CONFIRMED"
  | "PROBABLE_SUBMITTED"
  | "UNKNOWN"
  | "FAILED_BEFORE_SUBMIT";

export interface UserTurnEvidence {
  key: string;
  text: string;
}

export interface ChatGptSubmissionEvidence {
  expectedMessage: string;
  expectedFileNames: readonly string[];
  baselineTurnKeys: ReadonlySet<string>;
  currentTurns: readonly UserTurnEvidence[];
  composerCleared: boolean;
  generationStarted: boolean;
  assistantCountIncreased: boolean;
  conversationChanged: boolean;
  uploadCompleted: boolean;
  submitControlFailed?: boolean;
}

export interface SubmissionEvidenceDecision {
  level: SubmissionEvidenceLevel;
  signals: string[];
  matchingTurnKey?: string;
}

function containsExpectedMessage(turnText: string, expectedMessage: string): boolean {
  const actual = normalizeText(turnText);
  const expected = normalizeText(expectedMessage);
  return Boolean(expected) && (actual === expected || actual.includes(expected));
}

export function classifyChatGptSubmissionEvidence(input: ChatGptSubmissionEvidence): SubmissionEvidenceDecision {
  if (input.submitControlFailed) return { level: "FAILED_BEFORE_SUBMIT", signals: ["SUBMIT_CONTROL_FAILED"] };
  const newTurns = input.currentTurns.filter((turn) => !input.baselineTurnKeys.has(turn.key));
  const matchingTurn = newTurns.find((turn) => containsExpectedMessage(turn.text, input.expectedMessage));
  const filesVisible = Boolean(matchingTurn) && input.expectedFileNames.every((name) => normalizeText(matchingTurn!.text).includes(normalizeText(name)));
  const signals: string[] = [];
  if (matchingTurn) signals.push("NEW_MATCHING_USER_TURN");
  if (filesVisible && input.expectedFileNames.length > 0) signals.push("EXPECTED_FILES_VISIBLE");
  if (input.composerCleared) signals.push("COMPOSER_CLEARED");
  if (input.generationStarted) signals.push("GENERATION_STARTED");
  if (input.assistantCountIncreased) signals.push("ASSISTANT_STARTED");
  if (input.conversationChanged) signals.push("CONVERSATION_CHANGED");
  if (input.uploadCompleted) signals.push("UPLOAD_COMPLETED");

  const attachmentsSatisfied = input.expectedFileNames.length === 0 || filesVisible || input.uploadCompleted;
  const strongMatchingTurn = Boolean(matchingTurn) && attachmentsSatisfied && (input.composerCleared || filesVisible || input.generationStarted || input.assistantCountIncreased);
  const strongChangedUi = input.composerCleared && input.uploadCompleted && (
    (input.generationStarted && input.conversationChanged) ||
    (input.assistantCountIncreased && input.conversationChanged)
  );
  if (strongMatchingTurn || strongChangedUi) {
    return { level: "STRONG_CONFIRMED", signals, ...(matchingTurn ? { matchingTurnKey: matchingTurn.key } : {}) };
  }
  const independentSignals = [Boolean(matchingTurn), input.composerCleared, input.generationStarted || input.assistantCountIncreased, input.conversationChanged].filter(Boolean).length;
  if (attachmentsSatisfied && independentSignals >= 2) {
    return { level: "PROBABLE_SUBMITTED", signals, ...(matchingTurn ? { matchingTurnKey: matchingTurn.key } : {}) };
  }
  return { level: "UNKNOWN", signals, ...(matchingTurn ? { matchingTurnKey: matchingTurn.key } : {}) };
}
