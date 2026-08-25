export type ProviderResultState =
  | "SUBMITTED"
  | "GENERATING"
  | "AWAITING_USER_SELECTION"
  | "RESULT_RENDERED"
  | "DOWNLOAD_AVAILABLE"
  | "DOWNLOADING"
  | "STORED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELED";

export interface ProviderResultSignals {
  generationActive: boolean;
  selectionCount: number;
  responsePresent: boolean;
  downloadControlCount: number;
  failureVisible: boolean;
}

export function classifyProviderResult(signals: ProviderResultSignals): ProviderResultState {
  if (signals.failureVisible) return "FAILED";
  if (signals.selectionCount > 1) return "AWAITING_USER_SELECTION";
  if (signals.generationActive) return "GENERATING";
  if (signals.downloadControlCount > 0) return "DOWNLOAD_AVAILABLE";
  if (signals.responsePresent) return "RESULT_RENDERED";
  return "SUBMITTED";
}

export class ProviderResultProgress {
  private state: ProviderResultState = "SUBMITTED";
  private lastMaterialProgressAt: number;

  constructor(private readonly startedAt: number, private readonly absoluteTimeoutMs: number) {
    this.lastMaterialProgressAt = startedAt;
  }

  update(next: ProviderResultState, now: number): boolean {
    if (next === this.state) return false;
    this.state = next;
    this.lastMaterialProgressAt = now;
    return true;
  }

  current(): ProviderResultState {
    return this.state;
  }

  timedOut(now: number, idleTimeoutMs: number): boolean {
    return now - this.startedAt >= this.absoluteTimeoutMs || now - this.lastMaterialProgressAt >= idleTimeoutMs;
  }
}
