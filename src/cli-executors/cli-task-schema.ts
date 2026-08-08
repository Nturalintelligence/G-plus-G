import path from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";

export type ExecutorId = "codex" | "gemini" | "antigravity";
export type CliTaskRisk = "READ_ONLY" | "WORKSPACE_WRITE" | "COMMAND_EXECUTION";

export type VerificationStep =
  | { type: "command"; executable: string; args: string[]; timeoutMs: number }
  | { type: "file_exists"; path: string }
  | { type: "git_diff"; allowedPaths: string[] };

export interface CliTaskEnvelopeV1 {
  protocol: "gplusg.cli-task";
  version: 1;
  taskId: string;
  projectId: string;
  runId: string;
  parentTurnId: string;
  executor: ExecutorId | "auto";
  title: string;
  objective: string;
  context: string;
  instructions: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  acceptanceCriteria: string[];
  verification: VerificationStep[];
  risk: CliTaskRisk;
  requiresApproval: boolean;
  dependsOn: string[];
}

export type ParseTaskResult =
  | { success: true; envelope: CliTaskEnvelopeV1; rawJson: string }
  | { success: false; reasonCode: string; errorDetails: string; rawText: string };

export const VALID_EXECUTORS: ReadonlySet<string> = new Set(["codex", "gemini", "antigravity", "auto"]);
export const VALID_RISKS: ReadonlySet<string> = new Set(["READ_ONLY", "WORKSPACE_WRITE", "COMMAND_EXECUTION"]);
export const ALLOWED_VERIFICATION_EXECUTABLES: ReadonlySet<string> = new Set([
  "git",
]);
export const PROTECTED_WORKSPACE_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-electron",
  "release",
  "profiles",
  "appdata",
  "credentials",
]);
export const MAX_VERIFICATION_STEPS = 20;
export const MAX_VERIFICATION_TIMEOUT_MS = 30_000;

export function isProtectedWorkspacePath(targetPath: string): boolean {
  return targetPath
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .some((segment) => PROTECTED_WORKSPACE_SEGMENTS.has(segment.toLowerCase()));
}

export function isAllowedVerificationCommand(executable: string, args: readonly string[]): boolean {
  if (executable !== "git") return false;
  return (
    (args.length === 2 && args[0] === "diff" && args[1] === "--check") ||
    (args.length === 2 && args[0] === "status" && args[1] === "--porcelain")
  );
}

export interface PathValidationOptions {
  workspaceRoot?: string;
}

/**
  Checks whether a relative or absolute path stays safely inside the workspace root
  and does not use UNC, device paths, or parent directory traversal.
 */
export function isPathSafeRelativeToWorkspace(targetPath: string, workspaceRoot?: string): boolean {
  if (!targetPath || typeof targetPath !== "string") {
    return false;
  }

  const trimmed = targetPath.trim();

  // The protocol only accepts workspace-relative paths. Reject absolute, UNC,
  // device, drive-relative and alternate-data-stream forms before resolution.
  if (
    path.isAbsolute(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("//") ||
    /^[/\\]{2}[?.][/\\]/.test(trimmed) ||
    /^[a-zA-Z]:/.test(trimmed) ||
    trimmed.includes(":") ||
    trimmed.includes("\0")
  ) {
    return false;
  }

  // Reject parent directory escape patterns
  if (trimmed.includes("..") || trimmed.split(/[\\/]/).includes("..")) {
    return false;
  }

  // If workspace root is provided, ensure absolute resolution remains inside workspace
  if (workspaceRoot) {
    const canonicalRoot = path.resolve(workspaceRoot);
    const resolved = path.resolve(canonicalRoot, trimmed);
    const relative = path.relative(canonicalRoot, resolved);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return false;
    }

    if (existsSync(canonicalRoot)) try {
      const realRoot = realpathSync(canonicalRoot);
      let cursor = realRoot;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        if (!existsSync(cursor)) break;
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink()) return false;
        const realCursor = realpathSync(cursor);
        const realRelative = path.relative(realRoot, realCursor);
        if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Validates raw object against CliTaskEnvelopeV1 constraints.
 */
export function validateCliTaskEnvelopeV1(
  raw: unknown,
  options?: PathValidationOptions
): ParseTaskResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      success: false,
      reasonCode: "INVALID_OBJECT",
      errorDetails: "Task payload must be a non-null JSON object",
      rawText: JSON.stringify(raw),
    };
  }

  const obj = raw as Record<string, unknown>;

  const allowedKeys = new Set<keyof CliTaskEnvelopeV1>([
    "protocol", "version", "taskId", "projectId", "runId", "parentTurnId",
    "executor", "title", "objective", "context", "instructions", "allowedPaths",
    "forbiddenPaths", "acceptanceCriteria", "verification", "risk",
    "requiresApproval", "dependsOn",
  ]);
  const unknownKeys = Object.keys(obj).filter((key) => !allowedKeys.has(key as keyof CliTaskEnvelopeV1));
  if (unknownKeys.length > 0) {
    return {
      success: false,
      reasonCode: "UNKNOWN_FIELDS",
      errorDetails: `Unknown task fields: ${unknownKeys.join(", ")}`,
      rawText: JSON.stringify(raw),
    };
  }

  if (obj.protocol !== "gplusg.cli-task" || obj.version !== 1) {
    return {
      success: false,
      reasonCode: "INVALID_PROTOCOL_VERSION",
      errorDetails: `Protocol must be 'gplusg.cli-task' and version must be 1. Got protocol='${String(obj.protocol)}', version='${String(obj.version)}'`,
      rawText: JSON.stringify(raw),
    };
  }

  // Required string fields
  const requiredStringFields: Array<{ key: keyof CliTaskEnvelopeV1; maxLen: number }> = [
    { key: "taskId", maxLen: 100 },
    { key: "projectId", maxLen: 100 },
    { key: "runId", maxLen: 100 },
    { key: "parentTurnId", maxLen: 100 },
    { key: "title", maxLen: 200 },
    { key: "objective", maxLen: 2000 },
  ];

  for (const { key, maxLen } of requiredStringFields) {
    const val = obj[key];
    if (typeof val !== "string" || val.trim().length === 0) {
      return {
        success: false,
        reasonCode: "MISSING_REQUIRED_FIELD",
        errorDetails: `Field '${key}' is required and must be a non-empty string`,
        rawText: JSON.stringify(raw),
      };
    }
    if (val.length > maxLen) {
      return {
        success: false,
        reasonCode: "FIELD_TOO_LONG",
        errorDetails: `Field '${key}' exceeds maximum allowed length of ${maxLen} characters`,
        rawText: JSON.stringify(raw),
      };
    }
  }

  if (typeof obj.context !== "string") {
    return {
      success: false,
      reasonCode: "MISSING_REQUIRED_FIELD",
      errorDetails: "Field 'context' is required and must be a string",
      rawText: JSON.stringify(raw),
    };
  }
  const contextVal = obj.context;
  if (contextVal.length > 4000) {
    return {
      success: false,
      reasonCode: "FIELD_TOO_LONG",
      errorDetails: `Field 'context' exceeds maximum allowed length of 4000 characters`,
      rawText: JSON.stringify(raw),
    };
  }

  // Validate executor
  const executor = String(obj.executor || "").toLowerCase();
  if (!VALID_EXECUTORS.has(executor)) {
    return {
      success: false,
      reasonCode: "INVALID_EXECUTOR",
      errorDetails: `Executor '${String(obj.executor)}' is not supported. Valid executors: ${Array.from(VALID_EXECUTORS).join(", ")}`,
      rawText: JSON.stringify(raw),
    };
  }

  // Validate risk
  const risk = String(obj.risk || "");
  if (!VALID_RISKS.has(risk)) {
    return {
      success: false,
      reasonCode: "INVALID_RISK_LEVEL",
      errorDetails: `Risk level '${String(obj.risk)}' is invalid. Valid risks: ${Array.from(VALID_RISKS).join(", ")}`,
      rawText: JSON.stringify(raw),
    };
  }

  // Validate instructions
  if (!Array.isArray(obj.instructions)) {
    return {
      success: false,
      reasonCode: "INVALID_INSTRUCTIONS",
      errorDetails: "Field 'instructions' must be an array of strings",
      rawText: JSON.stringify(raw),
    };
  }
  if (obj.instructions.length === 0) {
    return {
      success: false,
      reasonCode: "EMPTY_INSTRUCTIONS",
      errorDetails: "Instructions array cannot be empty",
      rawText: JSON.stringify(raw),
    };
  }
  if (obj.instructions.length > 50) {
    return {
      success: false,
      reasonCode: "TOO_MANY_INSTRUCTIONS",
      errorDetails: "Instructions array exceeds maximum limit of 50 items",
      rawText: JSON.stringify(raw),
    };
  }
  for (let i = 0; i < obj.instructions.length; i++) {
    const item = obj.instructions[i];
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        success: false,
        reasonCode: "INVALID_INSTRUCTION_ITEM",
        errorDetails: `Instruction at index ${i} must be a non-empty string`,
        rawText: JSON.stringify(raw),
      };
    }
    if (item.length > 1000) {
      return {
        success: false,
        reasonCode: "INSTRUCTION_TOO_LONG",
        errorDetails: `Instruction at index ${i} exceeds maximum length of 1000 characters`,
        rawText: JSON.stringify(raw),
      };
    }
  }

  // Validate acceptanceCriteria - MANDATORY
  if (!Array.isArray(obj.acceptanceCriteria) || obj.acceptanceCriteria.length === 0) {
    return {
      success: false,
      reasonCode: "MISSING_ACCEPTANCE_CRITERIA",
      errorDetails: "Tasks must include at least one acceptance criterion",
      rawText: JSON.stringify(raw),
    };
  }
  if (obj.acceptanceCriteria.length > 20) {
    return {
      success: false,
      reasonCode: "TOO_MANY_ACCEPTANCE_CRITERIA",
      errorDetails: "Acceptance criteria exceeds maximum limit of 20 items",
      rawText: JSON.stringify(raw),
    };
  }
  for (let i = 0; i < obj.acceptanceCriteria.length; i++) {
    const item = obj.acceptanceCriteria[i];
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        success: false,
        reasonCode: "INVALID_ACCEPTANCE_CRITERION",
        errorDetails: `Acceptance criterion at index ${i} must be a non-empty string`,
        rawText: JSON.stringify(raw),
      };
    }
  }

  // Validate allowedPaths and forbiddenPaths
  const validatePaths = (paths: unknown, fieldName: string): string[] | ParseTaskResult => {
    if (!Array.isArray(paths)) {
      return {
        success: false,
        reasonCode: `INVALID_${fieldName.toUpperCase()}`,
        errorDetails: `Field '${fieldName}' must be an array of path strings`,
        rawText: JSON.stringify(raw),
      };
    }
    const cleanPaths: string[] = [];
    for (const p of paths) {
      if (typeof p !== "string") {
        return {
          success: false,
          reasonCode: `INVALID_${fieldName.toUpperCase()}_ITEM`,
          errorDetails: `Path in '${fieldName}' must be a string`,
          rawText: JSON.stringify(raw),
        };
      }
      if (!isPathSafeRelativeToWorkspace(p, options?.workspaceRoot)) {
        return {
          success: false,
          reasonCode: "SECURITY_PATH_VIOLATION",
          errorDetails: `Path '${p}' in '${fieldName}' violates security policy (outside workspace, UNC, or directory traversal)`,
          rawText: JSON.stringify(raw),
        };
      }
      cleanPaths.push(p);
    }
    return cleanPaths;
  };

  const allowedPathsRes = validatePaths(obj.allowedPaths, "allowedPaths");
  if ("success" in allowedPathsRes) return allowedPathsRes;

  if (allowedPathsRes.length === 0) {
    return {
      success: false,
      reasonCode: "EMPTY_ALLOWED_PATHS",
      errorDetails: "Tasks must declare at least one workspace-relative allowed path",
      rawText: JSON.stringify(raw),
    };
  }
  const protectedAllowedPath = allowedPathsRes.find(isProtectedWorkspacePath);
  if (protectedAllowedPath) {
    return {
      success: false,
      reasonCode: "PROTECTED_WORKSPACE_PATH",
      errorDetails: `Allowed path '${protectedAllowedPath}' targets a protected workspace component`,
      rawText: JSON.stringify(raw),
    };
  }

  const forbiddenPathsRes = validatePaths(obj.forbiddenPaths, "forbiddenPaths");
  if ("success" in forbiddenPathsRes) return forbiddenPathsRes;

  const overlappingPath = allowedPathsRes.find((allowed) => {
    const normalizedAllowed = allowed.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return forbiddenPathsRes.some((forbidden) => {
      const normalizedForbidden = forbidden.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
      return normalizedAllowed === normalizedForbidden || normalizedAllowed.startsWith(`${normalizedForbidden}/`);
    });
  });
  if (overlappingPath) {
    return {
      success: false,
      reasonCode: "CONFLICTING_PATH_SCOPE",
      errorDetails: `Allowed path '${overlappingPath}' is also covered by forbiddenPaths`,
      rawText: JSON.stringify(raw),
    };
  }

  // Validate verification steps
  if (!Array.isArray(obj.verification) || obj.verification.length === 0) {
    return {
      success: false,
      reasonCode: "INVALID_VERIFICATION",
      errorDetails: "Field 'verification' must be a non-empty array",
      rawText: JSON.stringify(raw),
    };
  }
  if (obj.verification.length > MAX_VERIFICATION_STEPS) {
    return {
      success: false,
      reasonCode: "TOO_MANY_VERIFICATION_STEPS",
      errorDetails: `Verification exceeds the maximum of ${MAX_VERIFICATION_STEPS} steps`,
      rawText: JSON.stringify(raw),
    };
  }

  const validVerificationSteps: VerificationStep[] = [];
  for (let i = 0; i < obj.verification.length; i++) {
    const step = obj.verification[i] as Record<string, unknown>;
    if (!step || typeof step !== "object") {
      return {
        success: false,
        reasonCode: "INVALID_VERIFICATION_STEP",
        errorDetails: `Verification step at index ${i} is invalid`,
        rawText: JSON.stringify(raw),
      };
    }

    if (step.type === "command") {
      const executable = String(step.executable || "").trim();
      if (!executable || !ALLOWED_VERIFICATION_EXECUTABLES.has(executable)) {
        return {
          success: false,
          reasonCode: "DISALLOWED_VERIFICATION_EXECUTABLE",
          errorDetails: `Verification step at index ${i} uses disallowed executable '${executable}'`,
          rawText: JSON.stringify(raw),
        };
      }
      if (!Array.isArray(step.args) || step.args.some((a) => typeof a !== "string")) {
        return {
          success: false,
          reasonCode: "INVALID_VERIFICATION_ARGS",
          errorDetails: `Verification step args at index ${i} must be an array of strings`,
          rawText: JSON.stringify(raw),
        };
      }
      if (!isAllowedVerificationCommand(executable, step.args as string[])) {
        return {
          success: false,
          reasonCode: "DISALLOWED_VERIFICATION_ARGS",
          errorDetails: "Verification commands must match the trusted read-only verifier registry",
          rawText: JSON.stringify(raw),
        };
      }
      const timeoutMs = typeof step.timeoutMs === "number" && Number.isInteger(step.timeoutMs)
        ? step.timeoutMs
        : 30_000;
      if (timeoutMs <= 0 || timeoutMs > MAX_VERIFICATION_TIMEOUT_MS) {
        return {
          success: false,
          reasonCode: "INVALID_VERIFICATION_TIMEOUT",
          errorDetails: `Verification timeout must be an integer between 1 and ${MAX_VERIFICATION_TIMEOUT_MS} ms`,
          rawText: JSON.stringify(raw),
        };
      }
      validVerificationSteps.push({
        type: "command",
        executable,
        args: step.args as string[],
        timeoutMs,
      });
    } else if (step.type === "file_exists") {
      const p = String(step.path || "").trim();
      if (!p || !isPathSafeRelativeToWorkspace(p, options?.workspaceRoot) || isProtectedWorkspacePath(p)) {
        return {
          success: false,
          reasonCode: "SECURITY_PATH_VIOLATION",
          errorDetails: `Verification file path '${p}' at index ${i} violates security policy`,
          rawText: JSON.stringify(raw),
        };
      }
      validVerificationSteps.push({ type: "file_exists", path: p });
    } else if (step.type === "git_diff") {
      const paths = Array.isArray(step.allowedPaths) ? (step.allowedPaths as string[]) : [];
      if (paths.length === 0) {
        return {
          success: false,
          reasonCode: "INVALID_GIT_DIFF_SCOPE",
          errorDetails: "git_diff verification must declare at least one allowed path",
          rawText: JSON.stringify(raw),
        };
      }
      for (const p of paths) {
        if (!isPathSafeRelativeToWorkspace(p, options?.workspaceRoot) || isProtectedWorkspacePath(p)) {
          return {
            success: false,
            reasonCode: "SECURITY_PATH_VIOLATION",
            errorDetails: `Verification git_diff path '${p}' violates security policy`,
            rawText: JSON.stringify(raw),
          };
        }
      }
      validVerificationSteps.push({ type: "git_diff", allowedPaths: paths });
    } else {
      return {
        success: false,
        reasonCode: "UNKNOWN_VERIFICATION_TYPE",
        errorDetails: `Verification step at index ${i} has unknown type '${String(step.type)}'`,
        rawText: JSON.stringify(raw),
      };
    }
  }

  if (
    !Array.isArray(obj.dependsOn) ||
    obj.dependsOn.length > 20 ||
    obj.dependsOn.some((d) => typeof d !== "string" || d.trim().length === 0 || d.length > 100)
  ) {
    return {
      success: false,
      reasonCode: "INVALID_DEPENDS_ON",
      errorDetails: "Field 'dependsOn' must contain at most 20 non-empty task IDs of at most 100 characters",
      rawText: JSON.stringify(raw),
    };
  }
  if (typeof obj.requiresApproval !== "boolean") {
    return {
      success: false,
      reasonCode: "INVALID_APPROVAL_REQUIREMENT",
      errorDetails: "Field 'requiresApproval' must be a boolean",
      rawText: JSON.stringify(raw),
    };
  }
  const dependsOn = (obj.dependsOn as string[]).map((dependency) => dependency.trim());
  if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(String(obj.taskId))) {
    return {
      success: false,
      reasonCode: "INVALID_DEPENDENCY_GRAPH",
      errorDetails: "Dependencies must be unique and a task cannot depend on itself",
      rawText: JSON.stringify(raw),
    };
  }

  const envelope: CliTaskEnvelopeV1 = {
    protocol: "gplusg.cli-task",
    version: 1,
    taskId: String(obj.taskId),
    projectId: String(obj.projectId),
    runId: String(obj.runId),
    parentTurnId: String(obj.parentTurnId),
    executor: executor as ExecutorId | "auto",
    title: String(obj.title),
    objective: String(obj.objective),
    context: contextVal,
    instructions: obj.instructions as string[],
    allowedPaths: allowedPathsRes as string[],
    forbiddenPaths: forbiddenPathsRes as string[],
    acceptanceCriteria: obj.acceptanceCriteria as string[],
    verification: validVerificationSteps,
    risk: risk as CliTaskRisk,
    requiresApproval: obj.requiresApproval,
    dependsOn,
  };

  return {
    success: true,
    envelope,
    rawJson: JSON.stringify(raw),
  };
}

export const BLOCK_START = "[[G_PLUS_G_CLI_TASK_V1]]";
export const BLOCK_END = "[[/G_PLUS_G_CLI_TASK_V1]]";

/**
 * Extracts and validates zero or more CLI task blocks from response text.
 * Capped to max 5 tasks per turn.
 */
export function extractCliTasksV1(
  responseText: string,
  options?: PathValidationOptions & { maxTasksPerTurn?: number }
): ParseTaskResult[] {
  if (!responseText || typeof responseText !== "string") {
    return [];
  }

  if (Buffer.byteLength(responseText, "utf8") > 256_000) {
    return [{
      success: false,
      reasonCode: "RESPONSE_TOO_LARGE",
      errorDetails: "Model response exceeds the CLI protocol recognition limit",
      rawText: "[REDACTED: oversized response]",
    }];
  }

  const legacyMarker = /\[\[G_PLUS_G_CLI_TASK(?::|\]\])(?!_V1)/;
  if (legacyMarker.test(responseText)) {
    return [{
      success: false,
      reasonCode: "LEGACY_UNSUPPORTED",
      errorDetails: "Legacy CLI task tags are displayed as text and are never executable",
      rawText: responseText,
    }];
  }

  const unknownProtocolMarker = /\[\[G_PLUS_G_CLI_TASK_(?!V1\]\])[^\]]+\]\]/;
  if (unknownProtocolMarker.test(responseText)) {
    return [{
      success: false,
      reasonCode: "UNSUPPORTED_PROTOCOL",
      errorDetails: "Only G_PLUS_G_CLI_TASK_V1 is supported",
      rawText: responseText,
    }];
  }

  // A machine block shown inside a Markdown fence is documentation, never a task.
  const fencedRanges: Array<[number, number]> = [];
  const fencePattern = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g;
  for (const match of responseText.matchAll(fencePattern)) {
    fencedRanges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  const isFenced = (position: number) => fencedRanges.some(([start, end]) => position >= start && position < end);

  const maxTasks = options?.maxTasksPerTurn ?? 5;
  const results: ParseTaskResult[] = [];

  let startIndex = 0;
  while (startIndex < responseText.length && results.length < maxTasks) {
    const blockStartPos = responseText.indexOf(BLOCK_START, startIndex);
    if (blockStartPos === -1) {
      break;
    }
    if (isFenced(blockStartPos)) {
      startIndex = blockStartPos + BLOCK_START.length;
      continue;
    }

    const contentStartPos = blockStartPos + BLOCK_START.length;
    const blockEndPos = responseText.indexOf(BLOCK_END, contentStartPos);
    if (blockEndPos === -1) {
      results.push({
        success: false,
        reasonCode: "UNCLOSED_TASK_BLOCK",
        errorDetails: "Found block start [[G_PLUS_G_CLI_TASK_V1]] without matching [[/G_PLUS_G_CLI_TASK_V1]]",
        rawText: responseText.slice(blockStartPos),
      });
      break;
    }

    const rawJsonStr = responseText.slice(contentStartPos, blockEndPos).trim();
    startIndex = blockEndPos + BLOCK_END.length;

    try {
      const parsed = JSON.parse(rawJsonStr);
      const validation = validateCliTaskEnvelopeV1(parsed, options);
      results.push(validation);
    } catch (err: any) {
      results.push({
        success: false,
        reasonCode: "INVALID_JSON",
        errorDetails: `Failed to parse JSON inside task block: ${err?.message || String(err)}`,
        rawText: rawJsonStr,
      });
    }
  }

  return results;
}
