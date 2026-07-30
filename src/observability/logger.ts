import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { dataPath } from "../paths.js";

type LogLevel = "INFO" | "WARN" | "ERROR";

const SENSITIVE_KEY = /cookie|token|password|authorization|secret|localstorage/i;
const SENSITIVE_VALUE =
  /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+|gh[opsu]_[a-z0-9_]+|oauth[^ ]*|[a-z0-9_-]{20,}\.[a-z0-9_-]{20,}\.[a-z0-9_-]{10,})/gi;
const SENSITIVE_QUERY = /([?&](?:token|key|code|session|auth)[^=]*=)[^&\s]+/gi;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const ROTATED_LOGS = 4;

function safeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      stack: value.stack ? redact(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((item) => safeValue(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : safeValue(item, seen),
      ]),
    );
  }
  return typeof value === "string" ? redact(value) : value;
}

function redact(value: string): string {
  return value
    .replace(SENSITIVE_VALUE, "[REDACTED]")
    .replace(SENSITIVE_QUERY, "$1[REDACTED]");
}

function rotate(path: string): void {
  if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return;
  rmSync(`${path}.${ROTATED_LOGS}`, { force: true });
  for (let index = ROTATED_LOGS - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
}

export function logEvent(
  level: LogLevel,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const path = dataPath("logs", "application.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  rotate(path);
  appendFileSync(
    path,
    `${JSON.stringify({
      occurredAt: new Date().toISOString(),
      level,
      event,
      ...(safeValue(details) as Record<string, unknown>),
    })}\n`,
    "utf8",
  );
}

export function writeDiagnostic(
  error: unknown,
  context: Record<string, unknown>,
): string {
  const path = dataPath("logs", `diagnostic-${Date.now()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      safeValue({
        occurredAt: new Date().toISOString(),
        error,
        context,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );
  logEvent("ERROR", "diagnostic.created", { path, context, error });
  return path;
}
