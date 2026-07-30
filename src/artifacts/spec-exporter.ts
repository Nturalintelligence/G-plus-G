import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { newId } from "../ids.js";
import type { ProjectStateVersion, TracedItem, DecisionItem } from "../project-state.js";
import type { AppDatabase } from "../storage/database.js";

export class SpecExporter {
  constructor(private readonly database: AppDatabase) {}

  async export(
    projectId: string,
    stateVersion: ProjectStateVersion,
    root = "user-data/exports",
    verification: {
      providerId: string;
      status: "PASSED" | "DISCREPANCIES" | "PENDING";
      discrepancies: string[];
    } = { providerId: "not-run", status: "PENDING", discrepancies: [] },
  ): Promise<{ directory: string; manifestHash: string }> {
    const directory = resolve(root, projectId, `v${stateVersion.version}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const spec = renderSpec(stateVersion);
    const decisions = JSON.stringify(
      {
        status: stateVersion.status,
        decisions: stateVersion.state.decisions,
        rejectedOptions: stateVersion.state.rejectedOptions,
        openQuestions: stateVersion.state.openQuestions,
      },
      null,
      2,
    );
    const conversation = this.renderConversation(projectId);
    const verificationJson = `${JSON.stringify(verification, null, 2)}\n`;
    await writeFile(resolve(directory, "TASK_SPEC.md"), spec, "utf8");
    await writeFile(resolve(directory, "decisions.json"), `${decisions}\n`, "utf8");
    await writeFile(resolve(directory, "conversation.md"), conversation, "utf8");
    await writeFile(resolve(directory, "verification.json"), verificationJson, "utf8");
    const files = {
      "TASK_SPEC.md": sha256(spec),
      "decisions.json": sha256(`${decisions}\n`),
      "conversation.md": sha256(conversation),
      "verification.json": sha256(verificationJson),
    };
    const manifest = JSON.stringify(
      {
        projectId,
        stateVersion: stateVersion.version,
        status: stateVersion.status,
        createdAt: new Date().toISOString(),
        files,
      },
      null,
      2,
    );
    await writeFile(resolve(directory, "manifest.json"), `${manifest}\n`, "utf8");
    const manifestHash = sha256(`${manifest}\n`);
    this.database.raw
      .prepare(
        `INSERT INTO exports
         (id, project_id, state_version, status, directory, manifest_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("exp"),
        projectId,
        stateVersion.version,
        stateVersion.status,
        directory,
        manifestHash,
        new Date().toISOString(),
      );
    return { directory, manifestHash };
  }

  private renderConversation(projectId: string): string {
    const rows = this.database.raw
      .prepare(
        `SELECT m.role, m.content, m.content_hash, m.created_at, t.id AS turn_id
         FROM messages m
         JOIN turns t ON t.id = m.turn_id
         JOIN conversations c ON c.id = t.conversation_id
         WHERE c.project_id = ?
         ORDER BY m.created_at, m.id`,
      )
      .all(projectId);
    if (rows.length === 0) return "# Conversation\n\nNo recorded messages.\n";
    return `# Conversation\n\n${rows
      .map(
        (row) =>
          `## ${String(row.role)} · ${String(row.created_at)}\n\n${String(row.content)}\n\n_Turn: ${String(row.turn_id)} · SHA-256: ${String(row.content_hash)}_`,
      )
      .join("\n\n")}\n`;
  }
}

function renderSpec(version: ProjectStateVersion): string {
  const state = version.state;
  return `# Task specification

Status: **${version.status}**
Version: **${version.version}**

## Requirements
${renderItems(state.requirements)}

## Constraints
${renderItems(state.constraints)}

## Decisions
${renderDecisions(state.decisions)}

## Rejected options
${renderDecisions(state.rejectedOptions)}

## Open questions
${renderItems(state.openQuestions)}

## Acceptance criteria
${renderItems(state.acceptanceCriteria)}
`;
}

function renderItems(items: TracedItem[]): string {
  return items.length
    ? items.map((item) => `- ${item.text} _(sources: ${item.sourceTurnIds.join(", ") || "manual"})_`).join("\n")
    : "- None";
}

function renderDecisions(items: DecisionItem[]): string {
  return items.length
    ? items
        .map(
          (item) =>
            `- ${item.text}\n  - Rationale: ${item.rationale}\n  - Sources: ${item.sourceTurnIds.join(", ") || "manual"}`,
        )
        .join("\n")
    : "- None";
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
