import type { TurnEvent } from "./adapter-contract.js";

export class TurnChannel {
  private readonly events: TurnEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  publish(event: TurnEvent): void {
    if (this.closed) return;
    this.events.push(event);
    this.waiters.splice(0).forEach((wake) => wake());
  }

  finish(): void {
    this.closed = true;
    this.waiters.splice(0).forEach((wake) => wake());
  }

  async *observe(): AsyncIterable<TurnEvent> {
    let cursor = 0;
    while (!this.closed || cursor < this.events.length) {
      while (cursor < this.events.length) yield this.events[cursor++]!;
      if (!this.closed) await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
