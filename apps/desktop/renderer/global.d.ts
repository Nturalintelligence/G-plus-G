interface Window {
  orchestrator: {
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
  events: Array<{
    sequence: number;
    aggregateType: string;
    eventType: string;
    occurredAt: string;
  }>;
  state: StateVersion | null;
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
