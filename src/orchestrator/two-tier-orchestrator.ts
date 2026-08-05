import { CliExecutorBridge, CliTaskExecutionResult, CliToolType } from "../cli-executors/cli-executor-bridge.js";

export interface TwoTierCycleRequest {
  task: string;
  preferredCliTool?: CliToolType;
  maxIterations?: number;
}

export interface CliTaskSpec {
  tool: CliToolType;
  task: string;
}

export interface TwoTierCycleResult {
  status: "COMPLETED" | "NEEDS_USER_ACTION" | "FAILED";
  iterationsCompleted: number;
  strategicPlanText: string;
  cliExecutionResults: CliTaskExecutionResult[];
  finalBoardReport: string;
}

export function parseCliTasksFromBoardResponse(boardResponseText: string, defaultTool: CliToolType = "gemini"): CliTaskSpec[] {
  const tasks: CliTaskSpec[] = [];
  const regex = /\[\[G_PLUS_G_CLI_TASK:(.*?)\]\]/gs;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(boardResponseText)) !== null) {
    const rawContent = match[1]?.trim() ?? "";
    try {
      if (rawContent.startsWith("{")) {
        const parsed = JSON.parse(rawContent);
        tasks.push({
          tool: (parsed.tool as CliToolType) || defaultTool,
          task: parsed.task || rawContent,
        });
      } else {
        tasks.push({
          tool: defaultTool,
          task: rawContent,
        });
      }
    } catch {
      tasks.push({
        tool: defaultTool,
        task: rawContent,
      });
    }
  }

  // Fallback: If no explicit tag was found, extract standard code or action blocks
  if (tasks.length === 0 && boardResponseText.length > 0) {
    tasks.push({
      tool: defaultTool,
      task: `Execute commercial implementation for: ${boardResponseText.slice(0, 1000)}`,
    });
  }

  return tasks;
}

export class TwoTierOrchestrator {
  private cliBridge: CliExecutorBridge;

  constructor(cliBridge?: CliExecutorBridge) {
    this.cliBridge = cliBridge || new CliExecutorBridge();
  }

  /**
   * Constructs the prompt instructing the Strategic Board (Web AI) to act as Product Architect
   * and output executable CLI tasks for the tactical CLI agents.
   */
  public buildBoardStrategyPrompt(userTask: string): string {
    return `G+G TWO-TIER COMMERCIAL APPLICATION ARCHITECT DIRECTIVE

You are acting as the Chief Product Architect and Lead Designer.
Target UI/UX Standard: PREMIUM COMMERCIAL GRADE (Telegram / Instagram level UI aesthetics).
- Dynamic, curated color palettes, dark/light themes.
- Glassmorphism, smooth CSS transitions, modern typography (Inter/Roboto/Outfit).
- Clear responsive grid, micro-interactions, zero generic basic MVP placeholders.

YOUR TASK:
1. Propose the complete architectural plan, UX flow, and module breakdown for:
${userTask}

2. Output explicit tasks for tactical CLI executors (Gemini CLI / Codex CLI) using this exact syntax:
[[G_PLUS_G_CLI_TASK:{"tool":"gemini","task":"Create index.css with Telegram-grade theme tokens and glassmorphism utilities"}]]
[[G_PLUS_G_CLI_TASK:{"tool":"codex","task":"Create main component structure and run npm test to verify"}]]

STRICT RULE: Respond in the exact language of the user task (if Russian, write in Russian).`;
  }

  /**
   * Constructs the feedback report sent from CLI Execution Tier back to Strategic Board Tier.
   */
  public buildCliReportForBoard(results: CliTaskExecutionResult[]): string {
    const reportLines = results.map((res, index) => {
      const statusStr = res.success ? "SUCCESS (Exit code 0)" : `FAILED (Exit code ${res.exitCode})`;
      return `### Task #${index + 1} [${res.tool.toUpperCase()}] - ${statusStr}\n**Command**: \`${res.commandExecuted}\`\n**Stdout**:\n\`\`\`\n${res.stdout.slice(0, 1500)}\n\`\`\`\n**Stderr**:\n\`\`\`\n${res.stderr.slice(0, 1500)}\n\`\`\``;
    });

    return `TACTICAL CLI EXECUTION & QA REPORT:\n\n${reportLines.join("\n\n---\n\n")}\n\nInspect the test and build results. If all criteria are met, approve the implementation. If failures occurred, issue revised [[G_PLUS_G_CLI_TASK:...]] tags to fix the code.`;
  }

  /**
   * Runs the complete execution cycle between Web Board plan and CLI Executor actions.
   */
  public async executeCycleStep(
    userTask: string,
    simulatedBoardResponse?: string,
  ): Promise<TwoTierCycleResult> {
    const boardResponse = simulatedBoardResponse || this.buildBoardStrategyPrompt(userTask);
    const cliTasks = parseCliTasksFromBoardResponse(boardResponse, "gemini");

    const cliResults: CliTaskExecutionResult[] = [];
    for (const taskSpec of cliTasks) {
      const res = await this.cliBridge.executeCliTask({
        tool: taskSpec.tool,
        prompt: taskSpec.task,
      });
      cliResults.push(res);
    }

    const report = this.buildCliReportForBoard(cliResults);
    const allPassed = cliResults.every((r) => r.success);

    return {
      status: allPassed ? "COMPLETED" : "NEEDS_USER_ACTION",
      iterationsCompleted: 1,
      strategicPlanText: boardResponse,
      cliExecutionResults: cliResults,
      finalBoardReport: report,
    };
  }
}
