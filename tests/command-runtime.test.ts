import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkspaceService } from "../src/agent-workspace/service.js";
import { AppDatabase } from "../src/storage/database.js";
import {
  CommandToolRuntime,
  type CommandPreset,
  type ToolRuntimeEvent,
} from "../src/tool-broker/command-runtime.js";

interface Fixture {
  database: AppDatabase;
  root: string;
  runtime: CommandToolRuntime;
  projectId: string;
  agentId: string;
  workspaceId: string;
}

const fixtures: Fixture[] = [];

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "gpg-command-runtime-"));
  const database = new AppDatabase(":memory:");
  database.migrate();
  const projectId = `project-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  database.raw
    .prepare("INSERT INTO projects(id,name,status,created_at,updated_at) VALUES(?,?,'ACTIVE',?,?)")
    .run(projectId, "Command runtime test", now, now);
  const workspace = new AgentWorkspaceService(database.raw).getOrCreate(projectId);
  const agent = workspace.agents.find((item) => item.role === "LEAD");
  if (!agent) throw new Error("LEAD agent was not created");
  const runtime = new CommandToolRuntime(database.raw);
  const workspaceId = runtime.registerWorkspace(projectId, root);
  runtime.ensureCapability(projectId, agent.id, workspaceId);
  const fixture = { database, root, runtime, projectId, agentId: agent.id, workspaceId };
  fixtures.push(fixture);
  return fixture;
}

function proposal(fixture: Fixture, preset: CommandPreset, key: string = crypto.randomUUID()) {
  return {
    projectId: fixture.projectId,
    agentInstanceId: fixture.agentId,
    workspaceId: fixture.workspaceId,
    preset,
    idempotencyKey: `test:${key}`,
  };
}

async function waitForState(
  fixture: Fixture,
  actionId: string,
  state: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = fixture.database.raw.prepare("SELECT * FROM tool_actions WHERE id=?").get(actionId);
    if (row?.state === state) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Action ${actionId} did not reach ${state}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Child process ${pid} survived Stop`);
}

afterEach(async () => {
  while (fixtures.length) {
    const fixture = fixtures.pop()!;
    fixture.runtime.stopAll();
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("CommandToolRuntime", () => {
  it("streams a successful command, verifies it and persists evidence", async () => {
    const fixture = await createFixture();
    const events: ToolRuntimeEvent[] = [];
    fixture.runtime.onEvent((event) => events.push(event));
    const created = await fixture.runtime.propose(proposal(fixture, "STREAM_SUCCESS"));

    expect(created.action.state).toBe("AWAITING_APPROVAL");
    fixture.runtime.approve(String(created.action.id));
    const completed = await waitForState(fixture, String(created.action.id), "COMPLETED");

    expect(completed.exit_code).toBe(0);
    expect(completed.evidence_id).toMatch(/^ev_/);
    expect(events.filter((event) => event.type === "STDOUT").map((event) => event.payload.text).join(""))
      .toContain("step-1");
    expect(events.filter((event) => event.type === "STDERR").map((event) => event.payload.text).join(""))
      .toContain("step-2");
    expect(fixture.runtime.events(String(created.action.id)).map((row: any) => row.event_type))
      .toEqual(expect.arrayContaining(["PROPOSED", "VALIDATED", "RUNNING", "VERIFYING", "COMPLETED"]));
  });

  it("maps nonzero exit and timeout to stable terminal failures", async () => {
    const fixture = await createFixture();
    const failed = await fixture.runtime.propose(proposal(fixture, "FAIL"));
    fixture.runtime.approve(String(failed.action.id));
    const failedRow = await waitForState(fixture, String(failed.action.id), "FAILED");
    expect(failedRow.exit_code).toBe(7);
    expect(failedRow.failure_code).toBe("COMMAND_EXIT_NONZERO");

    const timed = await fixture.runtime.propose(proposal(fixture, "TIMEOUT"));
    fixture.runtime.approve(String(timed.action.id));
    const timedRow = await waitForState(fixture, String(timed.action.id), "FAILED");
    expect(timedRow.failure_code).toBe("COMMAND_TIMEOUT");
  });

  it("stops the complete process tree and persists cancellation", async () => {
    const fixture = await createFixture();
    let childPid: number | undefined;
    fixture.runtime.onEvent((event) => {
      if (event.type !== "STDOUT") return;
      const match = String(event.payload.text ?? "").match(/child-pid:(\d+)/);
      if (match) childPid = Number(match[1]);
    });
    const created = await fixture.runtime.propose(proposal(fixture, "LONG"));
    fixture.runtime.approve(String(created.action.id));
    await waitForState(fixture, String(created.action.id), "RUNNING");
    const deadline = Date.now() + 3_000;
    while (!childPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(childPid).toBeTypeOf("number");

    expect(fixture.runtime.stop(String(created.action.id))).toBe(true);
    const cancelled = await waitForState(fixture, String(created.action.id), "CANCELLED");
    expect(cancelled.failure_code).toBe("COMMAND_CANCELLED");
    await waitForProcessExit(childPid!);
  });

  it("serializes writers by canonical repository across project workspace ids", async () => {
    const fixture = await createFixture();
    const secondProjectId = `project-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    fixture.database.raw
      .prepare("INSERT INTO projects(id,name,status,created_at,updated_at) VALUES(?,?,'ACTIVE',?,?)")
      .run(secondProjectId, "Second project, same repository", now, now);
    const secondWorkspace = new AgentWorkspaceService(fixture.database.raw).getOrCreate(secondProjectId);
    const secondAgent = secondWorkspace.agents.find((item) => item.role === "LEAD");
    if (!secondAgent) throw new Error("Second LEAD agent was not created");
    const secondWorkspaceId = fixture.runtime.registerWorkspace(secondProjectId, fixture.root);
    fixture.runtime.ensureCapability(secondProjectId, secondAgent.id, secondWorkspaceId);

    const first = await fixture.runtime.propose(proposal(fixture, "LONG", "writer-one"));
    fixture.runtime.approve(String(first.action.id));
    await waitForState(fixture, String(first.action.id), "RUNNING");

    const second = await fixture.runtime.propose({
      projectId: secondProjectId,
      agentInstanceId: secondAgent.id,
      workspaceId: secondWorkspaceId,
      preset: "STREAM_SUCCESS",
      idempotencyKey: "test:writer-two",
    });
    fixture.runtime.approve(String(second.action.id));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const blocked = fixture.database.raw.prepare("SELECT * FROM tool_actions WHERE id=?").get(second.action.id) as Record<string, unknown>;
    expect(blocked.state).toBe("FAILED");
    expect(blocked.failure_code).toBe("WORKSPACE_BUSY");
    expect(blocked.started_at).toBeNull();

    fixture.runtime.stop(String(first.action.id));
    await waitForState(fixture, String(first.action.id), "CANCELLED");
  }, 10_000);

  it("audits denial, deduplicates proposals and marks restart work interrupted", async () => {
    const fixture = await createFixture();
    const denied = await fixture.runtime.propose(proposal(fixture, "STREAM_SUCCESS", "denied"));
    fixture.runtime.deny(String(denied.action.id));
    const deniedRow = await waitForState(fixture, String(denied.action.id), "CANCELLED");
    expect(deniedRow.started_at).toBeNull();
    expect(fixture.runtime.events(String(denied.action.id)).map((row: any) => row.event_type))
      .toContain("CANCELLED");

    const first = await fixture.runtime.propose(proposal(fixture, "STREAM_SUCCESS", "duplicate"));
    const duplicate = await fixture.runtime.propose(proposal(fixture, "STREAM_SUCCESS", "duplicate"));
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.action.id).toBe(first.action.id);

    fixture.database.raw
      .prepare("UPDATE tool_actions SET state='RUNNING',started_at=? WHERE id=?")
      .run(new Date().toISOString(), first.action.id);
    new CommandToolRuntime(fixture.database.raw);
    const interrupted = await waitForState(fixture, String(first.action.id), "INTERRUPTED");
    expect(interrupted.failure_code).toBe("COMMAND_INTERRUPTED");
    expect(fixture.runtime.events(String(first.action.id)).map((row: any) => row.event_type))
      .toContain("INTERRUPTED");
  });
});
