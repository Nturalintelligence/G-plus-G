import path from "node:path";

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
  "npm", "npx", "node", "git", "vitest", "tsc", "cargo", "python", "pytest"
]);

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

  // Reject UNC paths or Windows device paths
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//") || /^[a-zA-Z]:[\\/]\.[\\]/.test(trimmed)) {
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

  const contextVal = typeof obj.context === "string" ? obj.context : "";
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

  const allowedPathsRes = validatePaths(obj.allowedPaths ?? [], "allowedPaths");
  if ("success" in allowedPathsRes) return allowedPathsRes;

  const forbiddenPathsRes = validatePaths(obj.forbiddenPaths ?? [], "forbiddenPaths");
  if ("success" in forbiddenPathsRes) return forbiddenPathsRes;

  // Validate verification steps
  if (!Array.isArray(obj.verification)) {
    return {
      success: false,
      reasonCode: "INVALID_VERIFICATION",
      errorDetails: "Field 'verification' must be an array",
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
      const timeoutMs = typeof step.timeoutMs === "number" && step.timeoutMs > 0 ? step.timeoutMs : 60_000;
      validVerificationSteps.push({
        type: "command",
        executable,
        args: step.args as string[],
        timeoutMs,
      });
    } else if (step.type === "file_exists") {
      const p = String(step.path || "").trim();
      if (!p || !isPathSafeRelativeToWorkspace(p, options?.workspaceRoot)) {
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
      for (const p of paths) {
        if (!isPathSafeRelativeToWorkspace(p, options?.workspaceRoot)) {
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

  const dependsOn = Array.isArray(obj.dependsOn)
    ? obj.dependsOn.filter((d): d is string => typeof d === "string")
    : [];

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
    requiresApproval: obj.requiresApproval !== false,
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

  const maxTasks = options?.maxTasksPerTurn ?? 5;
  const results: ParseTaskResult[] = [];

  let startIndex = 0;
  while (startIndex < responseText.length && results.length < maxTasks) {
    const blockStartPos = responseText.indexOf(BLOCK_START, startIndex);
    if (blockStartPos === -1) {
      break;
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
