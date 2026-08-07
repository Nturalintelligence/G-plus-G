import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  SafeExecutionBroker,
  maskSecrets,
  getGitStatusSnapshot,
} from "../src/cli-executors/execution-broker.js";
import { CliExecutor, ExecutorCapabilities, ExecutorEvent, ExecutorHealth, ExecutorInput } from "../src/cli-executors/cli-executor-contract.js";
import { CliTaskEnvelopeV1 } from "../src/cli-executors/cli-task-schema.js";
import { AntigravityCliExecutor } from "../src/cli-executors/executors/antigravity-executor.js";

class MockCliExecutor implements CliExecutor {
  readonly id = "codex" as const;

  public capabilities(): ExecutorCapabilities {
    return {
      supportsStreaming: true,
      supportedRisks: ["READ_ONLY", "WORKSPACE_WRITE", "COMMAND_EXECUTION"],
      maxTimeoutMs: 30000,
    };
  }

  public async healthCheck(): Promise<ExecutorHealth> {
    return { healthy: true, executorId: "codex", version: "1.0.0-mock" };
  }

  public async *execute(input: ExecutorInput, signal?: AbortSignal): AsyncIterable<ExecutorEvent> {
    const atNow = () => new Date().toISOString();
    yield { type: "STARTED", at: atNow(), attemptId: input.attemptId };

    if (signal?.aborted) {
      yield { type: "CANCELLED", at: atNow() };
      return;
    }

    yield { type: "STDOUT", at: atNow(), chunk: `Executed mock task: ${input.task.title} with secret key: sk-proj-12345678901234567890` };
    yield { type: "PROCESS_EXITED", at: atNow(), exitCode: 0 };
  }
}

class OutOfScopeExecutor extends MockCliExecutor {
  public override async *execute(input: ExecutorInput): AsyncIterable<ExecutorEvent> {
    fs.writeFileSync(path.join(input.workspaceRoot, "outside.txt"), "unexpected", "utf8");
    yield { type: "STARTED", at: new Date().toISOString(), attemptId: input.attemptId };
    yield { type: "PROCESS_EXITED", at: new Date().toISOString(), exitCode: 0 };
  }
}

describe("Phase C: Safe Execution Broker & Executor Adapters", () => {
  const dummyWorkspace = path.resolve(process.cwd());

  const sampleEnvelope: CliTaskEnvelopeV1 = {
    protocol: "gplusg.cli-task",
    version: 1,
    taskId: "task-c-1",
    projectId: "proj-1",
    runId: "run-1",
    parentTurnId: "turn-1",
    executor: "codex",
    title: "Mock task execution",
    objective: "Verify SafeExecutionBroker safety",
    context: "Unit testing phase C",
    instructions: ["Step 1"],
    allowedPaths: ["src/cli-executors/execution-broker.ts"],
    forbiddenPaths: [],
    acceptanceCriteria: ["Broker runs safely"],
    verification: [{ type: "command", executable: "git", args: ["status", "--porcelain"], timeoutMs: 5000 }],
    risk: "WORKSPACE_WRITE",
    requiresApproval: false,
    dependsOn: [],
  };

  it("should mask secrets matching sensitive key patterns", () => {
    const input = "api_key: sk-123456789012345678901234567890 and AIzaSy123456789012345678901234567890123";
    const masked = maskSecrets(input);
    expect(masked).not.toContain("sk-123456789012345678901234567890");
    expect(masked).not.toContain("AIzaSy123456789012345678901234567890123");
    expect(masked).toContain("***MASKED***");
  });

  it("should reject task attempting to escape workspace root via allowedPaths", async () => {
    const broker = new SafeExecutionBroker();
    broker.registerExecutor(new MockCliExecutor());

    const dangerousEnvelope: CliTaskEnvelopeV1 = {
      ...sampleEnvelope,
      allowedPaths: ["../outside-file.txt"],
    };

    const res = await broker.executeTaskEnvelope(dangerousEnvelope, "att-1", dummyWorkspace);
    expect(res.status).toBe("FAILED");
    expect(res.summary).toContain("Security violation");
  });

  it("should reject task attempting to access protected directories like .git or credentials", async () => {
    const broker = new SafeExecutionBroker();
    broker.registerExecutor(new MockCliExecutor());

    const dangerousEnvelope: CliTaskEnvelopeV1 = {
      ...sampleEnvelope,
      allowedPaths: [".git/config"],
    };

    const res = await broker.executeTaskEnvelope(dangerousEnvelope, "att-1", dummyWorkspace);
    expect(res.status).toBe("FAILED");
    expect(res.summary).toContain("forbidden system component");
  });

  it("should execute task with registered mock executor and run verification steps", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-verifier-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
      const broker = new SafeExecutionBroker();
      broker.registerExecutor(new MockCliExecutor());

      const res = await broker.executeTaskEnvelope(sampleEnvelope, "att-1", workspace);
      expect(res.status).toBe("COMPLETED");
      const v0 = res.verificationResults[0];
      expect(v0).toBeDefined();
      expect(v0?.passed).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("should report UNSUPPORTED for Antigravity executor when binary is unavailable", async () => {
    const antigravity = new AntigravityCliExecutor();
    const health = await antigravity.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.reason).toContain("UNSUPPORTED");
  });

  it("should capture current git status snapshot", () => {
    const snapshot = getGitStatusSnapshot(dummyWorkspace);
    expect(Array.isArray(snapshot)).toBe(true);
  });

  it("does not infer completion from an unrelated pre-existing file", async () => {
    const broker = new SafeExecutionBroker();
    broker.registerExecutor(new MockCliExecutor());
    const result = await broker.executeTaskEnvelope({
      ...sampleEnvelope,
      verification: [{ type: "file_exists", path: "package.json" }],
    }, "att-preexisting", dummyWorkspace);
    expect(result.status).toBe("NEEDS_FIX");
    expect(result.verificationResults[0]?.summary).toContain("existed unchanged");
  });

  it("refuses untrusted verifier arguments even if schema validation was bypassed", async () => {
    const broker = new SafeExecutionBroker();
    broker.registerExecutor(new MockCliExecutor());
    const result = await broker.executeTaskEnvelope({
      ...sampleEnvelope,
      verification: [{
        type: "command",
        executable: "git",
        args: ["status", "--porcelain", "&", "calc"],
        timeoutMs: 5000,
      }],
    }, "att-argv", dummyWorkspace);
    expect(result.status).toBe("NEEDS_FIX");
    expect(result.verificationResults[0]?.summary).toContain("trusted read-only registry");
  });

  it("fails an attempt that changes a path outside allowedPaths", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-scope-"));
    try {
      const broker = new SafeExecutionBroker();
      broker.registerExecutor(new OutOfScopeExecutor());
      const result = await broker.executeTaskEnvelope({
        ...sampleEnvelope,
        allowedPaths: ["allowed.txt"],
      }, "att-scope", workspace);
      expect(result.status).toBe("FAILED");
      expect(result.summary).toContain("outside the approved scope");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
