import type { DiagnosticReport, SessionState, TurnResult } from "../types.js";

export interface ConversationRef {
  id: string;
  url: string;
}

export interface MessageInput {
  content: string;
}

export interface TurnRef {
  id: string;
}

export type TurnEventType =
  | "MESSAGE_SUBMITTED"
  | "RESPONSE_STARTED"
  | "RESPONSE_UPDATED"
  | "RESPONSE_COMPLETED"
  | "CONFIRMATION_REQUIRED"
  | "CHALLENGE_DETECTED"
  | "RATE_LIMIT_DETECTED"
  | "TIMEOUT"
  | "CANCELLED"
  | "FAILED";

export interface TurnEvent {
  type: TurnEventType;
  at: string;
  text?: string;
}

export interface RecoveryResult {
  recovered: boolean;
  conversation?: ConversationRef;
}

export interface ModelAdapter {
  readonly providerId: string;
  launch(): Promise<void>;
  close(): Promise<void>;
  checkSession(): Promise<SessionState>;
  openLoginMode(): Promise<void>;
  createConversation(): Promise<ConversationRef>;
  openConversation(ref: ConversationRef): Promise<void>;
  sendMessage(input: MessageInput): Promise<TurnRef>;
  observeTurn(turn: TurnRef): AsyncIterable<TurnEvent>;
  getFinalResponse(turn: TurnRef): Promise<TurnResult>;
  cancel(turn: TurnRef): Promise<void>;
  completeManually(turn: TurnRef, response: string): Promise<void>;
  recover(): Promise<RecoveryResult>;
  collectDiagnostics(): Promise<DiagnosticReport>;
}
