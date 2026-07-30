interface Window {
  orchestrator: {
    system: {
      preflight(): Promise<Array<{
        name: string;
        status: "pass" | "warn" | "fail";
        detail: string;
      }>>;
    };
    projects: {
      list(): Promise<ProjectView[]>;
      create(name: string): Promise<ProjectView>;
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
  profile: { displayName: string };
  defaults: {
    mode: "MANUAL" | "SEQUENTIAL" | "PARALLEL" | "DEBATE";
    providers: Array<"chatgpt" | "gemini">;
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

interface ProjectView {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
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
  state: unknown;
}

interface RunView {
  runId: string;
  status: string;
  responses: Array<{ providerId: string; text: string; round: number }>;
}
