export type ProjectStatus = "ACTIVE" | "ARCHIVED";
export type ConversationStatus = "ACTIVE" | "COMPLETED" | "FAILED";
export type TurnStatus =
  | "PENDING"
  | "SUBMITTING"
  | "WAITING_RESPONSE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED";
export type AttemptStatus = "STARTED" | "COMPLETED" | "FAILED" | "INTERRUPTED";
export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  providers?: string[];
}

export interface Conversation {
  id: string;
  projectId: string;
  providerId: string;
  externalRef: string | null;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Turn {
  id: string;
  conversationId: string;
  ordinal: number;
  status: TurnStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Attempt {
  id: string;
  turnId: string;
  ordinal: number;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
}

export interface Message {
  id: string;
  turnId: string;
  attemptId: string | null;
  role: MessageRole;
  content: string;
  contentHash: string;
  createdAt: string;
}

export interface ConversationEntry {
  id: string;
  projectId: string;
  runId: string | null;
  role: MessageRole;
  providerId: string | null;
  round: number | null;
  content: string;
  createdAt: string;
}

export interface DomainEvent {
  sequence: number;
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt: string;
}
