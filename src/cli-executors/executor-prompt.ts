import type { CliTaskEnvelopeV1 } from "./cli-task-schema.js";

export function buildConstrainedExecutorPrompt(task: CliTaskEnvelopeV1): string {
  const list = (values: readonly string[]) => values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : "- none";

  return `G+G APPROVED CLI TASK
Task: ${task.title}
Objective: ${task.objective}
Risk: ${task.risk}

Security boundary:
- The current working directory is the only authorized workspace.
- Do not read, write, create, delete, or execute anything outside it.
- Do not create or follow symlinks, junctions, hard links, UNC paths, device paths, or alternate data streams.
- Do not touch protected roots such as .git, node_modules, dist, dist-electron, release, profiles, appdata, or credentials.

Allowed paths:
${list(task.allowedPaths)}

Forbidden paths:
${list(task.forbiddenPaths)}

Instructions:
${list(task.instructions)}

Acceptance criteria:
${list(task.acceptanceCriteria)}

Context:
${task.context || "none"}`;
}
