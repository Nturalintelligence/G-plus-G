import { describe, expect, it } from "vitest";
import { TypedEventBus } from "../src/events/event-bus.js";
import type { PhaseChangedEvent } from "../src/events/event-types.js";

describe("TypedEventBus", () => {
  it("emits and validates typed events with auto-filled metadata", () => {
    const bus = new TypedEventBus();
    let received: PhaseChangedEvent | undefined;

    const unsubscribe = bus.on<PhaseChangedEvent>("phase:changed", (event) => {
      received = event;
    });

    const emitted = bus.emit<PhaseChangedEvent>({
      event_type: "phase:changed",
      payload: {
        target: "provider",
        phase: "SUBMITTING",
        details: "Submitting prompt to ChatGPT",
      },
    });

    expect(emitted.event_version).toBe(1);
    expect(emitted.correlation_id).toBeTruthy();
    expect(emitted.timestamp).toBeTruthy();
    expect(received).toEqual(emitted);

    unsubscribe();
  });

  it("throws when event validation fails", () => {
    const bus = new TypedEventBus();
    expect(() =>
      bus.emit({
        event_type: "phase:changed",
        payload: null,
      } as any),
    ).toThrow();
  });
});
