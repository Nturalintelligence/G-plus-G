import { CliTaskEnvelopeV1, ExecutorId, CliTaskRisk } from "./cli-task-schema.js";

export interface ExecutorCapabilities {
  supportsStreaming: boolean;
  supportedRisks: CliTaskRisk[];
  maxTimeoutMs: number;
}

export interface ExecutorHealth {
  healthy: boolean;
  executorId: ExecutorId;
  version?: string;
  reason?: string;
}

export interface ExecutorInput {
  task: CliTaskEnvelopeV1;
  attemptId: string;
  workspaceRoot: string;
}

export type ExecutorEvent =
  | { type: "STARTED"; at: string; attemptId: string }
  | { type: "STDOUT"; at: string; chunk: string }
  | { type: "STDERR"; at: string; chunk: string }
  | { type: "FILE_CHANGED"; at: string; path: string }
  | { type: "PROCESS_EXITED"; at: string; exitCode: number | null }
  | { type: "CANCELLED"; at: string }
  | { type: "FAILED"; at: string; code: string };

export interface CliExecutor {
  id: ExecutorId;
  capabilities(): ExecutorCapabilities;
  healthCheck(): Promise<ExecutorHealth>;
  execute(input: ExecutorInput, signal?: AbortSignal): AsyncIterable<ExecutorEvent>;
}
