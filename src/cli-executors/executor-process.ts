import { spawn } from "node:child_process";
import type { ExecutorEvent, ExecutorInput } from "./cli-executor-contract.js";
import { killProcessTreeWindows, sanitizeEnv } from "./execution-broker.js";

const MAX_QUEUED_OUTPUT_CHARS = 64 * 1024;
const MAX_OUTPUT_CHUNK_CHARS = 16 * 1024;

export async function* executeSpawnedCli(
  executable: string,
  args: string[],
  input: ExecutorInput,
  signal?: AbortSignal,
): AsyncIterable<ExecutorEvent> {
  const atNow = () => new Date().toISOString();
  yield { type: "STARTED", at: atNow(), attemptId: input.attemptId };

  if (signal?.aborted) {
    yield { type: "CANCELLED", at: atNow() };
    return;
  }

  let childProcess;
  try {
    childProcess = spawn(executable, args, {
      cwd: input.workspaceRoot,
      shell: false,
      windowsHide: true,
      env: sanitizeEnv(),
    });
  } catch (error: any) {
    yield { type: "FAILED", at: atNow(), code: `SPAWN_ERROR: ${error?.message || String(error)}` };
    return;
  }

  const eventQueue: ExecutorEvent[] = [];
  let queuedOutputChars = 0;
  let outputWasDropped = false;
  let isFinished = false;
  let finishCode: number | null = null;
  let spawnFailedError: string | null = null;

  const queueOutput = (type: "STDOUT" | "STDERR", chunk: Buffer) => {
    if (queuedOutputChars >= MAX_QUEUED_OUTPUT_CHARS) {
      outputWasDropped = true;
      return;
    }
    const text = chunk.toString("utf-8").slice(0, MAX_OUTPUT_CHUNK_CHARS);
    const remaining = MAX_QUEUED_OUTPUT_CHARS - queuedOutputChars;
    const bounded = text.slice(0, remaining);
    queuedOutputChars += bounded.length;
    if (bounded.length < text.length || chunk.length > MAX_OUTPUT_CHUNK_CHARS) outputWasDropped = true;
    if (bounded) eventQueue.push({ type, at: atNow(), chunk: bounded });
  };

  const abort = () => {
    if (childProcess.pid) killProcessTreeWindows(childProcess.pid);
  };
  signal?.addEventListener("abort", abort, { once: true });
  childProcess.stdout?.on("data", (chunk: Buffer) => queueOutput("STDOUT", chunk));
  childProcess.stderr?.on("data", (chunk: Buffer) => queueOutput("STDERR", chunk));
  childProcess.on("error", (error: Error) => {
    spawnFailedError = error.message;
    isFinished = true;
  });
  childProcess.on("close", (code: number | null) => {
    finishCode = code;
    isFinished = true;
  });

  try {
    while (!isFinished || eventQueue.length > 0) {
      if (signal?.aborted) {
        yield { type: "CANCELLED", at: atNow() };
        return;
      }
      while (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        if (event.type === "STDOUT" || event.type === "STDERR") {
          queuedOutputChars = Math.max(0, queuedOutputChars - event.chunk.length);
        }
        yield event;
      }
      if (!isFinished) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  if (outputWasDropped) {
    yield {
      type: "STDERR",
      at: atNow(),
      chunk: "[G+G truncated excessive executor output]",
    };
  }
  if (spawnFailedError) {
    yield { type: "FAILED", at: atNow(), code: spawnFailedError };
  } else {
    yield { type: "PROCESS_EXITED", at: atNow(), exitCode: finishCode };
  }
}
