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
    };
    provider: {
      login(provider: string): Promise<string>;
      send(provider: string, message: string): Promise<{ response: string }>;
    };
    orchestration: {
      run(input: unknown): Promise<RunView>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      stop(): Promise<void>;
      onProgress(callback: (value: { providerId: string; text: string }) => void): () => void;
    };
    state: {
      latest(projectId: string): Promise<StateVersion | null>;
      save(projectId: string, state: unknown): Promise<StateVersion>;
      approve(id: string): Promise<StateVersion>;
    };
    exports: {
      spec(projectId: string): Promise<{ directory: string; manifestHash: string }>;
    };
    settings: {
      get(): Promise<AppSettingsView>;
      save(value: AppSettingsView): Promise<AppSettingsView>;
    };
  };
}

interface AppSettingsView {
  schemaVersion: 1;
  profile: {
    displayName: string;
    realName: string;
    greetingStyle: "display" | "real" | "generic";
  };
  defaults: {
    mode: "MANUAL" | "SEQUENTIAL" | "PARALLEL" | "DEBATE";
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
    };
  };
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
