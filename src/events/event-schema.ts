import type { AppEvent } from "./event-types.js";

export function validateAppEvent(event: unknown): AppEvent {
  if (typeof event !== "object" || event === null) {
    throw new Error("Invalid event: must be a non-null object");
  }

  const candidate = event as Partial<AppEvent>;

  if (candidate.event_version !== 1) {
    throw new Error(`Invalid event_version: expected 1, got ${candidate.event_version}`);
  }

  if (typeof candidate.event_type !== "string" || !candidate.event_type) {
    throw new Error("Invalid event_type: must be a non-empty string");
  }

  if (typeof candidate.correlation_id !== "string" || !candidate.correlation_id) {
    throw new Error("Invalid correlation_id: must be a non-empty string");
  }

  if (typeof candidate.timestamp !== "string" || !candidate.timestamp) {
    throw new Error("Invalid timestamp: must be an ISO timestamp string");
  }

  if (typeof candidate.payload !== "object" || candidate.payload === null) {
    throw new Error("Invalid payload: must be an object");
  }

  return candidate as AppEvent;
}
