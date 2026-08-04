declare module "*.svg" {
  const content: string;
  export default content;
}

interface Window {
  orchestrator: {
    system: {
      preflight(): Promise<Array<{
        name: string;
        status: "pass" | "warn" | "fail";
        detail: string;
      }>>;
      info(): Promise<ReleaseInfoView>;
      openDataFolder(): Promise<string>;
    };
    maintenance: {
      backup(): Promise<string>;
      resetSession(provider: "chatgpt" | "gemini"): Promise<{
        reset: boolean;
        provider: string;
        path?: string;
      }>;
    };
    quality: {
      dashboard(): Promise<QualityDashboardView>;
    };
    projects: {
      list(): Promise<ProjectView[]>;
      create(name: string, providers: string[]): Promise<ProjectView>;
      open(id: string): Promise<ProjectDetails>;
      delete(id: string, deleteRemote?: boolean): Promise<{ success: boolean }>;
    };
    provider: {
      login(provider: string): Promise<string>;
      status(provider: string): Promise<{ provider: string; session: string; ready: boolean }>;
      send(provider: string, message: string): Promise<{ response: string }>;
    };
    orchestration: {
      run(input: unknown): Promise<RunView>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      stop(): Promise<void>;
      onProgress(callback: (value: { providerId: string; text: string }) => void): () => void;
    };
    events: {
      onEvent(callback: (event: any) => void): () => void;
    };
    state: {
      latest(projectId: string): Promise<StateVersion | null>;
      save(projectId: string, state: unknown): Promise<StateVersion>;
      approve(id: string): Promise<StateVersion>;
    };
    exports: {
      spec(projectId: string): Promise<{ directory: string; manifestHash: string }>;
    };
    terminal: {
      execute(command: string, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string; elapsedMs: number }>;
    };
    twoTier: {
      executeStep(userTask: string, simulatedResponse?: string): Promise<{
        status: "COMPLETED" | "NEEDS_USER_ACTION" | "FAILED";
        iterationsCompleted: number;
        strategicPlanText: string;
        cliExecutionResults: Array<{ tool: string; success: boolean; exitCode: number; stdout: string; stderr: string; elapsedMs: number; commandExecuted: string }>;
        finalBoardReport: string;
      }>;
    };
    settings: {
      get(): Promise<AppSettingsView>;
      save(value: AppSettingsView): Promise<AppSettingsView>;
    };
    cliTasks: {
      list(projectId: string): Promise<any[]>;
      approve(taskId: string): Promise<any>;
      reject(taskId: string, reason: string): Promise<any>;
      cancel(taskId: string): Promise<any>;
      retry(taskId: string): Promise<any>;
    };
    memory: {
      getBrief(projectId: string): Promise<any>;
      createCheckpoint(projectId: string): Promise<any>;
      rollover(projectId: string, provider: string): Promise<any>;
    };
    prompts: {
      listProposals(): Promise<any[]>;
      approveProposal(id: string): Promise<any>;
    };
    attachments: {
      pickFiles(projectId: string, messageId: string): Promise<AttachmentRefView[]>;
      stageDroppedFile(projectId: string, messageId: string, filePath: string): Promise<AttachmentRefView>;
      stageClipboardImage(projectId: string, messageId: string, base64Data: string): Promise<AttachmentRefView>;
      removeDraft(attachmentId: string): Promise<{ success: boolean }>;
      open(attachmentId: string): Promise<{ success: boolean; error?: string }>;
      saveAs(attachmentId: string): Promise<{ success: boolean; targetPath?: string }>;
      getPreviewUrl(attachmentId: string): Promise<string | null>;
    };
    getPathForFile(file: File): string;
  };
}

interface AttachmentRefView {
  id: string;
  messageId: string;
  projectId: string;
  kind: "image" | "document" | "text" | "archive" | "audio" | "video" | "binary";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  localRelativePath: string;
  source: "user" | "chatgpt" | "gemini" | "cli";
  status: "STAGED" | "UPLOADING" | "READY" | "FAILED" | "QUARANTINED";
  quarantineReason?: "EXECUTABLE_BLOCKED" | "MIME_MISMATCH" | "SIZE_LIMIT" | "UNSAFE_FILENAME" | "MANUAL_REVIEW_REQUIRED";
}

interface AppSettingsView {
  schemaVersion: 1;
  profile: {
    displayName: string;
    realName: string;
    greetingStyle: "display" | "real" | "generic";
  };
  defaults: {
    mode: "MANUAL" | "SEQUENTIAL" | "PARALLEL" | "DEBATE" | "AUTONOMOUS_CYCLE";
    providers: Array<
      | "chatgpt"
      | "gemini"
      | "deepseek"
      | "claude"
      | "copilot"
      | "perplexity"
      | "huggingchat"
      | "groq"
      | "duckduckgo"
      | "mistral"
    >;
    limits: {
      maxTurns: number;
      maxTurnMs: number;
      maxSessionMs: number;
      maxRetries: number;
      confirmationEvery: number;
      requireConfirmation?: boolean;
    };
  };
  models?: Record<string, { role: string; customPrompt: string }>;
  appearance: {
    theme: "dark" | "light" | "system";
    density: "comfortable" | "compact";
    fontScale: number;
  };
}

interface ReleaseInfoView {
  appVersion: string;
  commit: string;
  nodeVersion: string;
  platform: string;
  dataPath: string;
  generatedAt: string;
}

interface MetricSummaryView {
  name: string;
  count: number;
  average: number;
  minimum: number;
  maximum: number;
}

interface QualityDashboardView {
  generatedAt: string;
  windowDays: number;
  totalSamples: number;
  overall: MetricSummaryView[];
  providers: Record<string, MetricSummaryView[]>;
}

interface ProjectView {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  providers?: string[];
}

interface ProjectDetails {
  project: ProjectView;
  recoveredTurns: number;
  recoveredRuns: number;
  conversations?: Array<{
    id: string;
    providerId: string;
    externalRef: string | null;
  }>;
  events: Array<{
    sequence: number;
    aggregateType: string;
    eventType: string;
    occurredAt: string;
  }>;
  transcript: ConversationEntryView[];
  state: StateVersion | null;
}

interface ConversationEntryView {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  providerId: string | null;
  round: number | null;
  content: string;
  createdAt: string;
}

interface StateVersion {
  id: string;
  version: number;
  status: "DRAFT" | "APPROVED";
  state: ProjectStateView;
}

interface ProjectStateItemView {
  id: string;
  text: string;
  sourceTurnIds: string[];
  rationale?: string;
}

interface ProjectStateView {
  requirements: ProjectStateItemView[];
  constraints: ProjectStateItemView[];
  decisions: ProjectStateItemView[];
  rejectedOptions: ProjectStateItemView[];
  openQuestions: ProjectStateItemView[];
  acceptanceCriteria: ProjectStateItemView[];
}

interface RunView {
  runId: string;
  status: string;
  responses: Array<{
    providerId: string;
    text: string;
    round: number;
    agreed?: boolean;
  }>;
  consensusReached?: boolean;
}
