export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_domain",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        provider_id TEXT NOT NULL,
        external_ref TEXT,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'FAILED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        status TEXT NOT NULL CHECK (
          status IN ('PENDING', 'SUBMITTING', 'WAITING_RESPONSE', 'COMPLETED',
                     'FAILED', 'CANCELLED', 'INTERRUPTED')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (conversation_id, ordinal)
      );

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id),
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'INTERRUPTED')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (turn_id, ordinal)
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id),
        attempt_id TEXT REFERENCES attempts(id),
        role TEXT NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'SYSTEM')),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX conversations_project_idx ON conversations(project_id);
      CREATE INDEX turns_conversation_idx ON turns(conversation_id);
      CREATE INDEX attempts_turn_idx ON attempts(turn_id);
      CREATE INDEX messages_turn_idx ON messages(turn_id);
      CREATE INDEX events_aggregate_idx ON events(aggregate_type, aggregate_id, sequence);

      CREATE TRIGGER events_no_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;

      CREATE TRIGGER events_no_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `,
  },
  {
    version: 2,
    name: "orchestration_and_project_state",
    sql: `
      CREATE TABLE orchestration_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        mode TEXT NOT NULL CHECK (mode IN ('MANUAL', 'SEQUENTIAL', 'PARALLEL', 'DEBATE')),
        status TEXT NOT NULL CHECK (
          status IN ('CREATED', 'RUNNING', 'PAUSED', 'AWAITING_CONFIRMATION',
                     'COMPLETED', 'STOPPED', 'FAILED')
        ),
        limits_json TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_state_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'APPROVED')),
        state_json TEXT NOT NULL,
        source_turn_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        UNIQUE(project_id, version)
      );

      CREATE TABLE exports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        state_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'APPROVED')),
        directory TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX orchestration_runs_project_idx ON orchestration_runs(project_id);
      CREATE INDEX project_state_project_idx ON project_state_versions(project_id, version);
      CREATE INDEX exports_project_idx ON exports(project_id, created_at);
    `,
  },
];
