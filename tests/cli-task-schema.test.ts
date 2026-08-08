import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  extractCliTasksV1,
  BLOCK_END,
  BLOCK_START,
  isPathSafeRelativeToWorkspace,
  validateCliTaskEnvelopeV1,
  CliTaskEnvelopeV1,
} from "../src/cli-executors/cli-task-schema.js";

describe("Phase A: CLI Task Envelope Schema V1 & Extractor", () => {
  const dummyWorkspace = path.resolve(process.cwd(), "test_workspace");

  const validEnvelopeObject = {
    protocol: "gplusg.cli-task",
    version: 1,
    taskId: "task-001",
    projectId: "proj-123",
    runId: "run-456",
    parentTurnId: "turn-789",
    executor: "codex",
    title: "Create styles module",
    objective: "Implement CSS design system",
    context: "User requested glassmorphic design",
    instructions: ["Create src/styles.css", "Add CSS variables"],
    allowedPaths: ["src/styles.css"],
    forbiddenPaths: [".git"],
    acceptanceCriteria: ["File src/styles.css exists", "npm run check passes"],
    verification: [
      { type: "file_exists", path: "src/styles.css" },
      { type: "command", executable: "git", args: ["diff", "--check"], timeoutMs: 30000 },
    ],
    risk: "WORKSPACE_WRITE",
    requiresApproval: true,
    dependsOn: [],
  };

  it("should successfully validate a well-formed envelope", () => {
    const res = validateCliTaskEnvelopeV1(validEnvelopeObject, { workspaceRoot: dummyWorkspace });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.envelope.taskId).toBe("task-001");
      expect(res.envelope.executor).toBe("codex");
      expect(res.envelope.risk).toBe("WORKSPACE_WRITE");
      expect(res.envelope.verification).toHaveLength(2);
    }
  });

  it("should extract valid task block from model response text", () => {
    const responseText = `
Here is our plan. I will now issue a CLI task:

[[G_PLUS_G_CLI_TASK_V1]]
${JSON.stringify(validEnvelopeObject, null, 2)}
[[/G_PLUS_G_CLI_TASK_V1]]

Please confirm approval.
`;

    const tasks = extractCliTasksV1(responseText, { workspaceRoot: dummyWorkspace });
    expect(tasks).toHaveLength(1);
    const t0 = tasks[0];
    expect(t0).toBeDefined();
    expect(t0?.success).toBe(true);
    if (t0 && t0.success) {
      expect(t0.envelope.title).toBe("Create styles module");
    }
  });

  it("should reject envelope missing mandatory acceptance criteria", () => {
    const invalidObj = { ...validEnvelopeObject, acceptanceCriteria: [] };
    const res = validateCliTaskEnvelopeV1(invalidObj, { workspaceRoot: dummyWorkspace });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.reasonCode).toBe("MISSING_ACCEPTANCE_CRITERIA");
    }
  });

  it("should reject malicious path traversal attempts", () => {
    expect(isPathSafeRelativeToWorkspace("../outside.ts", dummyWorkspace)).toBe(false);
    expect(isPathSafeRelativeToWorkspace("src/../../outside.ts", dummyWorkspace)).toBe(false);
    expect(isPathSafeRelativeToWorkspace("\\\\server\\share\\file.txt", dummyWorkspace)).toBe(false);
    expect(isPathSafeRelativeToWorkspace("//server/share/file.txt", dummyWorkspace)).toBe(false);
    expect(isPathSafeRelativeToWorkspace("src/valid.ts", dummyWorkspace)).toBe(true);

    const maliciousObj = {
      ...validEnvelopeObject,
      allowedPaths: ["../outside.ts"],
    };
    const res = validateCliTaskEnvelopeV1(maliciousObj, { workspaceRoot: dummyWorkspace });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.reasonCode).toBe("SECURITY_PATH_VIOLATION");
    }
  });

  it("should reject disallowed verification executables", () => {
    const dangerousVerificationObj = {
      ...validEnvelopeObject,
      verification: [
        { type: "command", executable: "rm", args: ["-rf", "/"], timeoutMs: 1000 },
      ],
    };
    const res = validateCliTaskEnvelopeV1(dangerousVerificationObj, { workspaceRoot: dummyWorkspace });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.reasonCode).toBe("DISALLOWED_VERIFICATION_EXECUTABLE");
    }
  });

  it("should handle malformed JSON inside task block gracefully", () => {
    const responseText = `
[[G_PLUS_G_CLI_TASK_V1]]
{ invalid json syntax here ...
[[/G_PLUS_G_CLI_TASK_V1]]
`;

    const tasks = extractCliTasksV1(responseText, { workspaceRoot: dummyWorkspace });
    expect(tasks).toHaveLength(1);
    const t0 = tasks[0];
    expect(t0).toBeDefined();
    expect(t0?.success).toBe(false);
    if (t0 && !t0.success) {
      expect(t0.reasonCode).toBe("INVALID_JSON");
    }
  });

  it("should handle unclosed task block gracefully", () => {
    const responseText = `
[[G_PLUS_G_CLI_TASK_V1]]
{"protocol": "gplusg.cli-task"}
`;

    const tasks = extractCliTasksV1(responseText, { workspaceRoot: dummyWorkspace });
    expect(tasks).toHaveLength(1);
    const t0 = tasks[0];
    expect(t0).toBeDefined();
    expect(t0?.success).toBe(false);
    if (t0 && !t0.success) {
      expect(t0.reasonCode).toBe("UNCLOSED_TASK_BLOCK");
    }
  });

  it("should extract multiple task blocks up to the specified limit", () => {
    const task1 = { ...validEnvelopeObject, taskId: "task-001" };
    const task2 = { ...validEnvelopeObject, taskId: "task-002" };
    const responseText = `
[[G_PLUS_G_CLI_TASK_V1]]
${JSON.stringify(task1)}
[[/G_PLUS_G_CLI_TASK_V1]]

[[G_PLUS_G_CLI_TASK_V1]]
${JSON.stringify(task2)}
[[/G_PLUS_G_CLI_TASK_V1]]
`;

    const tasks = extractCliTasksV1(responseText, { workspaceRoot: dummyWorkspace, maxTasksPerTurn: 5 });
    expect(tasks).toHaveLength(2);
    const t0 = tasks[0];
    const t1 = tasks[1];
    expect(t0?.success).toBe(true);
    expect(t1?.success).toBe(true);
    if (t0?.success) expect(t0.envelope.taskId).toBe("task-001");
    if (t1?.success) expect(t1.envelope.taskId).toBe("task-002");
  });

  it("should reject fields that exceed maximum length limits", () => {
    const oversizedObj = {
      ...validEnvelopeObject,
      title: "a".repeat(201),
    };
    const res = validateCliTaskEnvelopeV1(oversizedObj, { workspaceRoot: dummyWorkspace });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.reasonCode).toBe("FIELD_TOO_LONG");
    }
  });

  it("rejects interpreter flags and arbitrary verifier arguments", () => {
    for (const verification of [
      { type: "command", executable: "node", args: ["-e", "process.exit(0)"], timeoutMs: 1000 },
      { type: "command", executable: "git", args: ["status", "--porcelain", "&", "calc"], timeoutMs: 1000 },
    ]) {
      expect(validateCliTaskEnvelopeV1({ ...validEnvelopeObject, verification }).success).toBe(false);
    }
  });

  it("treats ordinary Markdown, code fences, and trigger words as zero executable tasks", () => {
    const fenced = `\`\`\`json\n${BLOCK_START}\n${JSON.stringify(validEnvelopeObject)}\n${BLOCK_END}\n\`\`\``;
    for (const text of [
      "ordinary text",
      "# Markdown\n\n\`npm test\`",
      fenced,
      "snake змейка разработка разраб",
    ]) {
      expect(extractCliTasksV1(text).filter((result) => result.success)).toHaveLength(0);
    }
  });

  it("reports legacy and unknown protocol markers without creating a task", () => {
    const legacy = extractCliTasksV1("[[G_PLUS_G_CLI_TASK:codex]]do something[[/G_PLUS_G_CLI_TASK]]");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ success: false, reasonCode: "LEGACY_UNSUPPORTED" });

    const unknown = extractCliTasksV1("[[G_PLUS_G_CLI_TASK_V2]]{}[[/G_PLUS_G_CLI_TASK_V2]]");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ success: false, reasonCode: "UNSUPPORTED_PROTOCOL" });
  });

  it("rejects unknown fields and absolute, device, drive-relative, and ADS paths", () => {
    expect(validateCliTaskEnvelopeV1({ ...validEnvelopeObject, surprise: true }).success).toBe(false);
    for (const unsafePath of [
      "C:\\outside.txt",
      "C:outside.txt",
      "/etc/passwd",
      "\\\\?\\C:\\outside.txt",
      "\\\\.\\PhysicalDrive0",
      "file.txt:secret",
    ]) {
      expect(isPathSafeRelativeToWorkspace(unsafePath, dummyWorkspace)).toBe(false);
    }
  });

  it("rejects a symlink or junction that escapes the workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-path-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-path-outside-"));
    const link = path.join(root, "escape");
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      expect(isPathSafeRelativeToWorkspace("escape/file.txt", root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects protected scopes, conflicting scopes, and unbounded verifier timeouts", () => {
    expect(validateCliTaskEnvelopeV1({
      ...validEnvelopeObject,
      allowedPaths: ["node_modules/generated.txt"],
    }, { workspaceRoot: dummyWorkspace })).toMatchObject({
      success: false,
      reasonCode: "PROTECTED_WORKSPACE_PATH",
    });
    expect(validateCliTaskEnvelopeV1({
      ...validEnvelopeObject,
      allowedPaths: ["src"],
      forbiddenPaths: ["src"],
    }, { workspaceRoot: dummyWorkspace })).toMatchObject({
      success: false,
      reasonCode: "CONFLICTING_PATH_SCOPE",
    });
    expect(validateCliTaskEnvelopeV1({
      ...validEnvelopeObject,
      verification: [{ type: "command", executable: "git", args: ["diff", "--check"], timeoutMs: 60_000 }],
    }, { workspaceRoot: dummyWorkspace })).toMatchObject({
      success: false,
      reasonCode: "INVALID_VERIFICATION_TIMEOUT",
    });
  });

  it("rejects duplicate and self dependencies", () => {
    for (const dependsOn of [["task-001"], ["task-000", "task-000"]]) {
      expect(validateCliTaskEnvelopeV1({
        ...validEnvelopeObject,
        dependsOn,
      }, { workspaceRoot: dummyWorkspace })).toMatchObject({
        success: false,
        reasonCode: "INVALID_DEPENDENCY_GRAPH",
      });
    }
  });
});
