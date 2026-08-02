import { EventEmitter } from "node:events";
import { newId } from "../ids.js";
import { logEvent } from "../observability/logger.js";
import type { AppEvent } from "./event-types.js";
import { validateAppEvent } from "./event-schema.js";

export class TypedEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<E extends AppEvent>(
    eventData: Omit<E, "event_version" | "timestamp" | "correlation_id"> & {
      correlation_id?: string;
      timestamp?: string;
    },
  ): E {
    const fullEvent: AppEvent = {
      event_version: 1,
      timestamp: eventData.timestamp ?? new Date().toISOString(),
      correlation_id: eventData.correlation_id ?? newId("corr"),
      ...eventData,
    } as AppEvent;

    const validated = validateAppEvent(fullEvent);

    logEvent("INFO", `bus.${validated.event_type}`, {
      correlationId: validated.correlation_id,
      eventType: validated.event_type,
      target: (validated as any).payload?.target,
      phase: (validated as any).payload?.phase,
      projectId: validated.project_id,
    });

    this.emitter.emit(validated.event_type, validated);
    this.emitter.emit("*", validated);
    return validated as E;
  }

  on<E extends AppEvent>(eventType: E["event_type"] | "*", listener: (event: E) => void): () => void {
    this.emitter.on(eventType, listener as (...args: any[]) => void);
    return () => {
      this.emitter.off(eventType, listener as (...args: any[]) => void);
    };
  }
}

export const globalEventBus = new TypedEventBus();
