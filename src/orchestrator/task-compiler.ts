import { extractCliTasksV1, BLOCK_START, BLOCK_END, CliTaskEnvelopeV1, ParseTaskResult } from "../cli-executors/cli-task-schema.js";
import { TaskFsmRepository, CliTaskRecord, CliTaskState } from "../storage/task-fsm-repository.js";
import { ExecutionResultV1 } from "../cli-executors/execution-broker.js";

export interface TaskCompilerOptions {
  workspaceRoot: string;
  autoExecuteReadOnly?: boolean;
}

export interface ProcessedModelResponse {
  cleanPublicText: string;
  extractedEnvelopes: CliTaskEnvelopeV1[];
  savedTasks: CliTaskRecord[];
  rejectedBlocks: ParseTaskResult[];
}

export class TaskCompiler {
  private repository: TaskFsmRepository;

  constructor(repository: TaskFsmRepository) {
    this.repository = repository;
  }

  /**
   * Cleans public model text by removing raw machine JSON blocks and replacing them
   * with compact user-friendly summary badges.
   */
  public cleanPublicTranscript(responseText: string): string {
    if (!responseText) return responseText;

    let cleanText = responseText;
    let startIndex = 0;

    while (startIndex < cleanText.length) {
      const startPos = cleanText.indexOf(BLOCK_START, startIndex);
      if (startPos === -1) break;

      const endPos = cleanText.indexOf(BLOCK_END, startPos + BLOCK_START.length);
      if (endPos === -1) {
        // Remove unclosed block
        cleanText = cleanText.slice(0, startPos) + "\n[CLI Task Block Malformed/Unclosed]\n";
        break;
      }

      const rawJson = cleanText.slice(startPos + BLOCK_START.length, endPos).trim();
      let badge = "[CLI Task Proposed]";

      try {
        const parsed = JSON.parse(rawJson);
        if (parsed.title) {
          badge = `[CLI Task Proposed: ${parsed.title}]`;
        }
      } catch {
        badge = "[CLI Task Block Parse Error]";
      }

      cleanText = cleanText.slice(0, startPos) + `\n${badge}\n` + cleanText.slice(endPos + BLOCK_END.length);
      startIndex = startPos + badge.length + 2;
    }

    return cleanText.trim();
  }

  /**
   * Processes raw response from web model turn:
   * 1. Extracts task envelopes.
   * 2. Cleans public transcript text.
   * 3. Determines approval state per task risk level.
   * 4. Persists tasks and initial events to database.
   */
  public processModelTurnResponse(
    responseText: string,
    options: TaskCompilerOptions
  ): ProcessedModelResponse {
    const parseResults = extractCliTasksV1(responseText, { workspaceRoot: options.workspaceRoot });
    const cleanPublicText = this.cleanPublicTranscript(responseText);

    const extractedEnvelopes: CliTaskEnvelopeV1[] = [];
    const savedTasks: CliTaskRecord[] = [];
    const rejectedBlocks: ParseTaskResult[] = [];

    for (const res of parseResults) {
      if (!res.success) {
        rejectedBlocks.push(res);
        continue;
      }

      const env = res.envelope;
      extractedEnvelopes.push(env);

      // Determine initial state based on approval policy
      let initialStatus: CliTaskState = "VALIDATED";
      if (env.risk === "READ_ONLY") {
        initialStatus = options.autoExecuteReadOnly ? "QUEUED" : "AWAITING_APPROVAL";
      } else if (env.risk === "WORKSPACE_WRITE") {
        initialStatus = env.requiresApproval ? "AWAITING_APPROVAL" : "QUEUED";
      } else if (env.risk === "COMMAND_EXECUTION") {
        initialStatus = "AWAITING_APPROVAL"; // Always requires approval
      }

      const record = this.repository.saveTaskEnvelope(env, initialStatus);
      savedTasks.push(record);
    }

    return {
      cleanPublicText,
      extractedEnvelopes,
      savedTasks,
      rejectedBlocks,
    };
  }

  /**
   * Formats execution result into a compact structured review report for the single reviewer web model.
   */
  public buildReviewerPrompt(result: ExecutionResultV1, task: CliTaskEnvelopeV1): string {
    const changedFilesText =
      result.changedFiles.length > 0
        ? result.changedFiles.map((f) => `- [${f.change.toUpperCase()}] ${f.path}`).join("\n")
        : "None";

    const verificationText =
      result.verificationResults.length > 0
        ? result.verificationResults.map((v) => `- ${v.label}: ${v.passed ? "PASSED ✅" : "FAILED ❌"} (${v.summary})`).join("\n")
        : "No verification steps executed";

    const warningsText = result.warnings.length > 0 ? result.warnings.map((w) => `⚠️ ${w}`).join("\n") : "None";

    return `CLI EXECUTION REVIEW REPORT FOR TASK: '${task.title}'
Task ID: ${result.taskId} (Attempt #${result.attemptId})
Executor: ${result.executor.toUpperCase()}
Execution Status: ${result.status}

SUMMARY:
${result.summary}

CHANGED FILES IN WORKSPACE:
${changedFilesText}

VERIFICATION RESULTS:
${verificationText}

WARNINGS:
${warningsText}

REVIEW INSTRUCTIONS:
Evaluate the execution outcome against task criteria.
Select exactly one REVIEW VERDICT:
- ACCEPT: if task criteria are satisfied.
- REQUEST_FIX: if issues occurred and specify revised instructions.
- ESCALATE_TO_USER: if user decision is required.`;
  }
}
