export type EventVersion = 1;

export type ProviderPhase =
  | "DISCONNECTED"
  | "OPENING_PROFILE"
  | "CHECKING_SESSION"
  | "OPENING_CHAT"
  | "PREPARING_INPUT"
  | "SUBMITTING"
  | "WAITING_RESPONSE"
  | "GENERATING"
  | "READING"
  | "COMPLETED"
  | "RATE_LIMITED"
  | "HUMAN_REQUIRED"
  | "RECOVERING"
  | "FAILED";

export type OrchestratorPhase =
  | "IDLE"
  | "PREPARING"
  | "RUNNING"
  | "WAITING_CONFIRMATION"
  | "CONSENSUS_CHECK"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export type EventType =
  | "phase:changed"
  | "turn:stream_chunk"
  | "turn:completed"
  | "consensus:status"
  | "app:error"
  | "human_action:required";

export interface BaseEvent {
  event_version: EventVersion;
  event_type: EventType;
  correlation_id: string;
  timestamp: string;
  project_id?: string;
  run_id?: string;
  turn_id?: string;
  adapter_id?: string;
  attempt_id?: string;
}

export interface PhaseChangedEvent extends BaseEvent {
  event_type: "phase:changed";
  payload: {
    target: "orchestrator" | "provider";
    phase: OrchestratorPhase | ProviderPhase;
    details?: string;
  };
}

export interface TurnStreamChunkEvent extends BaseEvent {
  event_type: "turn:stream_chunk";
  payload: {
    providerId: string;
    text: string;
  };
}

export interface TurnCompletedEvent extends BaseEvent {
  event_type: "turn:completed";
  payload: {
    providerId: string;
    text: string;
    elapsedMs: number;
  };
}

export interface ConsensusStatusEvent extends BaseEvent {
  event_type: "consensus:status";
  payload: {
    consensusReached: boolean;
    agreedProviders: string[];
    round: number;
  };
}

export interface AppErrorEvent extends BaseEvent {
  event_type: "app:error";
  payload: {
    source: string;
    message: string;
    stack?: string;
  };
}

export interface HumanActionRequiredEvent extends BaseEvent {
  event_type: "human_action:required";
  payload: {
    providerId: string;
    reason: "CAPTCHA" | "LOGIN_REQUIRED" | "CUSTOM";
    message: string;
  };
}

export type AppEvent =
  | PhaseChangedEvent
  | TurnStreamChunkEvent
  | TurnCompletedEvent
  | ConsensusStatusEvent
  | AppErrorEvent
  | HumanActionRequiredEvent;
