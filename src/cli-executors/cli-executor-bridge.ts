import { executeTerminalCommand, TerminalExecutionResult } from "../terminal/terminal-engine.js";

export type CliToolType = "gemini" | "codex" | "custom";

export interface CliTaskExecutionOptions {
  tool: CliToolType;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  customCommand?: string;
}

export interface CliTaskExecutionResult {
  tool: CliToolType;
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  commandExecuted: string;
}

export class CliExecutorBridge {
  private defaultCwd: string;

  constructor(defaultCwd?: string) {
    this.defaultCwd = defaultCwd || process.cwd();
  }

  /**
   * Builds the shell command string for non-interactive execution based on the requested tool.
   */
  public sanitizeShellArg(text: string): string {
    return text
      .replace(/\r?\n/g, " ")
      .replace(/[\^&|<>%"`;$]/g, "")
      .replace(/"/g, "'")
      .trim();
  }

  public buildCliCommand(tool: CliToolType, prompt: string, customCommand?: string): string {
    const sanitizedPrompt = this.sanitizeShellArg(prompt);

    if (tool === "custom") {
      return customCommand || `echo "${sanitizedPrompt}"`;
    }

    if (tool === "gemini") {
      return `gemini -y -p "${sanitizedPrompt}"`;
    }

    if (tool === "codex") {
      return `codex exec -a never "${sanitizedPrompt}"`;
    }

    throw new Error(`Unsupported CLI tool: ${tool}`);
  }

  /**
   * Executes a CLI task non-interactively and captures output.
   */
  public async executeCliTask(options: CliTaskExecutionOptions): Promise<CliTaskExecutionResult> {
    const cwd = options.cwd || this.defaultCwd;
    const commandExecuted = this.buildCliCommand(options.tool, options.prompt, options.customCommand);

    try {
      const result: TerminalExecutionResult = await executeTerminalCommand({
        command: commandExecuted,
        cwd,
        timeoutMs: options.timeoutMs || 30_000,
      });

      return {
        tool: options.tool,
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        elapsedMs: result.elapsedMs,
        commandExecuted,
      };
    } catch (err: any) {
      return {
        tool: options.tool,
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: err?.message || String(err),
        elapsedMs: 0,
        commandExecuted,
      };
    }
  }
}
