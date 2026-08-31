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
  {
    version: 3,
    name: "persistent_project_transcript",
    sql: `
      CREATE TABLE conversation_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id TEXT REFERENCES orchestration_runs(id),
        role TEXT NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'SYSTEM')),
        provider_id TEXT,
        round INTEGER,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX conversation_entries_project_idx
        ON conversation_entries(project_id, created_at);
    `,
  },
  {
    version: 4,
    name: "quality_metrics",
    sql: `
      CREATE TABLE quality_metrics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        tags_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX quality_metrics_name_time_idx
        ON quality_metrics(name, occurred_at);
    `,
  },
  {
    version: 5,
    name: "project_providers",
    sql: `
      CREATE TABLE project_providers (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        PRIMARY KEY (project_id, provider_id)
      );
    `,
  },
  {
    version: 6,
    name: "web_ai_board_and_cli_executors",
    sql: `
      CREATE TABLE cli_tasks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id TEXT NOT NULL,
        parent_turn_id TEXT NOT NULL,
        executor TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        context TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('PROPOSED', 'VALIDATED', 'AWAITING_APPROVAL', 'QUEUED', 'RUNNING',
                     'VERIFYING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED',
                     'NEEDS_FIX', 'BLOCKED', 'INTERRUPTED')
        ),
        task_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, task_id)
      );

      CREATE TABLE cli_task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (task_id, attempt_number)
      );

      CREATE TABLE cli_task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        attempt_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE execution_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_id TEXT,
        artifact_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL CHECK (
          kind IN ('REQUIREMENT', 'CONSTRAINT', 'DECISION_ACCEPTED', 'OPTION_REJECTED',
                  'OPEN_QUESTION', 'ARTIFACT', 'KNOWN_RISK', 'ACCEPTANCE_CRITERION')
        ),
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RESOLVED', 'SUPERSEDED')),
        supersedes_id TEXT,
        source_message_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE rolling_briefs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        version INTEGER NOT NULL CHECK (version > 0),
        objective TEXT NOT NULL,
        current_state TEXT NOT NULL,
        active_requirements_json TEXT NOT NULL,
        active_constraints_json TEXT NOT NULL,
        accepted_decisions_json TEXT NOT NULL,
        rejected_options_json TEXT NOT NULL,
        completed_work_json TEXT NOT NULL,
        open_tasks_json TEXT NOT NULL,
        known_failures_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        next_action TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, version)
      );

      CREATE TABLE context_checkpoints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        checkpoint_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        continuation_pack_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE conversation_rollovers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        provider_id TEXT NOT NULL,
        old_conversation_id TEXT NOT NULL,
        new_conversation_id TEXT,
        checkpoint_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE prompt_versions (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        template_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'EVALUATING', 'APPROVED', 'ACTIVE', 'RETIRED')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE prompt_change_proposals (
        id TEXT PRIMARY KEY,
        base_version TEXT NOT NULL,
        observed_problem TEXT NOT NULL,
        evidence_message_ids_json TEXT NOT NULL,
        proposed_diff TEXT NOT NULL,
        expected_effect TEXT NOT NULL,
        regression_risks_json TEXT NOT NULL,
        evaluation_cases_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE run_evaluations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        prompt_version TEXT NOT NULL,
        total_turns INTEGER NOT NULL,
        low_value_turns INTEGER NOT NULL,
        cli_tasks_count INTEGER NOT NULL,
        rejected_tasks_count INTEGER NOT NULL,
        retries_count INTEGER NOT NULL,
        user_interventions_count INTEGER NOT NULL,
        cancelled_decisions_count INTEGER NOT NULL,
        acceptance_passed INTEGER NOT NULL CHECK (acceptance_passed IN (0, 1)),
        rollover_count INTEGER NOT NULL,
        errors_count INTEGER NOT NULL,
        user_rating INTEGER,
        evaluated_at TEXT NOT NULL
      );

      CREATE INDEX cli_tasks_project_idx ON cli_tasks(project_id, status);
      CREATE INDEX cli_tasks_run_idx ON cli_tasks(run_id);
      CREATE INDEX memory_items_project_idx ON memory_items(project_id, kind, status);
      CREATE INDEX rolling_briefs_project_idx ON rolling_briefs(project_id, version);
      CREATE INDEX context_checkpoints_project_idx ON context_checkpoints(project_id);
      CREATE INDEX run_evaluations_project_idx ON run_evaluations(project_id, prompt_version);
    `,
  },
  {
    version: 7,
    name: "message_attachments_and_artifact_deliveries",
    sql: `
      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        local_relative_path TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        quarantine_reason TEXT,
        provider_metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE attachment_deliveries (
        id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL REFERENCES message_attachments(id),
        provider_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'UPLOADING', 'DELIVERED', 'UNSUPPORTED', 'FAILED')),
        provider_file_id TEXT,
        delivered_at TEXT
      );

      CREATE TABLE provider_submissions (
        submission_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PREPARING', 'FILES_UPLOADED', 'SUBMITTED', 'CONFIRMED', 'UNKNOWN')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE downloaded_artifacts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        provider_id TEXT NOT NULL,
        original_url TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        local_relative_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('READY', 'DOWNLOAD_EXPIRED', 'FAILED', 'QUARANTINED')),
        downloaded_at TEXT NOT NULL
      );

      CREATE INDEX message_attachments_project_idx ON message_attachments(project_id, message_id);
      CREATE INDEX attachment_deliveries_conv_idx ON attachment_deliveries(attachment_id, provider_id, conversation_id);
      CREATE INDEX provider_submissions_msg_idx ON provider_submissions(message_id, provider_id);
    `,
  },
  {
    version: 8,
    name: "project_description",
    sql: `
      ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 9,
    name: "attachment_draft_lifecycle",
    sql: `
      ALTER TABLE message_attachments ADD COLUMN draft_expires_at TEXT;
      ALTER TABLE message_attachments ADD COLUMN last_error TEXT;
      ALTER TABLE message_attachments ADD COLUMN updated_at TEXT;
      CREATE INDEX message_attachments_draft_idx
        ON message_attachments(project_id, message_id, draft_expires_at);
    `,
  },
  {
    version: 10,
    name: "crash_safe_composer_drafts",
    sql: `
      CREATE TABLE composer_drafts (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        message_id TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('MANUAL', 'SEQUENTIAL', 'PARALLEL', 'DEBATE')),
        continuation_policy TEXT NOT NULL CHECK (continuation_policy IN ('autonomous', 'approval')),
        starter TEXT NOT NULL,
        providers_json TEXT NOT NULL,
        view_mode TEXT NOT NULL CHECK (view_mode IN ('SYNTHESIZED', 'LIVE')),
        finalizer_mode TEXT NOT NULL CHECK (finalizer_mode IN ('MANUAL', 'LEAD_SELECTS', 'PEER_AGREEMENT')),
        final_responder TEXT NOT NULL,
        composer_expanded INTEGER NOT NULL CHECK (composer_expanded IN (0, 1)),
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 11,
    name: "provider_protocol_initialization_state",
    sql: `
      CREATE TABLE provider_protocol_states (
        provider_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        protocol_version TEXT NOT NULL,
        protocol_hash TEXT NOT NULL,
        protocol_text TEXT NOT NULL,
        initialized_at TEXT NOT NULL,
        project_checkpoint_revision TEXT,
        PRIMARY KEY (provider_id, conversation_id)
      );
    `,
  },
  {
    version: 12,
    name: "downloaded_artifact_metadata",
    sql: `
      ALTER TABLE downloaded_artifacts ADD COLUMN file_name TEXT NOT NULL DEFAULT 'downloaded_artifact';
      ALTER TABLE downloaded_artifacts ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';
      ALTER TABLE downloaded_artifacts ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX downloaded_artifacts_message_idx ON downloaded_artifacts(message_id, downloaded_at);
    `,
  },
  {
    version: 13,
    name: "downloaded_artifact_failure_diagnostics",
    sql: `
      ALTER TABLE downloaded_artifacts ADD COLUMN failure_reason TEXT;
      ALTER TABLE downloaded_artifacts ADD COLUMN failure_detail TEXT;
    `,
  },
  {
    version: 14,
    name: "artifact_reacquisition_audit",
    sql: `
      ALTER TABLE downloaded_artifacts ADD COLUMN acquisition_id TEXT;
      ALTER TABLE downloaded_artifacts ADD COLUMN retry_of_acquisition_id TEXT;
      ALTER TABLE downloaded_artifacts ADD COLUMN physical_click_count INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX downloaded_artifacts_acquisition_idx
        ON downloaded_artifacts(acquisition_id) WHERE acquisition_id IS NOT NULL;
      CREATE INDEX downloaded_artifacts_retry_idx
        ON downloaded_artifacts(retry_of_acquisition_id);
    `,
  },
  {
    version: 15,
    name: "derived_provider_artifacts",
    sql: `
      ALTER TABLE projects ADD COLUMN derived_artifact_policy TEXT NOT NULL DEFAULT 'ASK'
        CHECK (derived_artifact_policy IN ('ASK', 'AUTO', 'DENY'));
      ALTER TABLE downloaded_artifacts ADD COLUMN provenance TEXT NOT NULL DEFAULT 'PROVIDER_NATIVE_FILE';
      ALTER TABLE downloaded_artifacts ADD COLUMN task_id TEXT;
      ALTER TABLE downloaded_artifacts ADD COLUMN assistant_turn_id TEXT;
      ALTER TABLE downloaded_artifacts ADD COLUMN source_message_id TEXT;
      CREATE INDEX downloaded_artifacts_source_idx
        ON downloaded_artifacts(project_id, provider_id, source_message_id, provenance);
    `,
  },
  {
    version: 16,
    name: "agent_workspace_foundation",
    sql: `
      CREATE TABLE aw_plugins (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('BUILTIN','EXTERNAL')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        registered_at TEXT NOT NULL
      );
      CREATE TABLE aw_capability_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        immutable_hash TEXT NOT NULL UNIQUE,
        sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1))
      );
      CREATE TABLE aw_capabilities (
        snapshot_id TEXT NOT NULL REFERENCES aw_capability_snapshots(id) ON DELETE CASCADE,
        capability_id TEXT NOT NULL,
        state TEXT NOT NULL,
        source_plugin TEXT NOT NULL,
        scope TEXT NOT NULL,
        approval_policy TEXT NOT NULL,
        health_evidence_json TEXT NOT NULL,
        detected_version TEXT,
        failure_reason TEXT,
        detected_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, capability_id)
      );
      CREATE TABLE aw_agent_instances (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        role TEXT NOT NULL,
        task_id TEXT NOT NULL,
        conversation_id TEXT,
        experience TEXT,
        requested_effort TEXT NOT NULL,
        effective_effort TEXT,
        capability_snapshot_id TEXT NOT NULL REFERENCES aw_capability_snapshots(id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, provider_id, role, task_id)
      );
      CREATE TABLE aw_role_assignments (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL REFERENCES aw_agent_instances(id) ON DELETE CASCADE,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY(project_id, role, agent_instance_id)
      );
      CREATE TABLE aw_automation_policies (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        code_changes TEXT NOT NULL,
        debugging TEXT NOT NULL,
        commit_mode TEXT NOT NULL,
        push_mode TEXT NOT NULL,
        derived_artifacts TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE aw_evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL REFERENCES aw_agent_instances(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE aw_delivery_decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        delivery_owner_agent_id TEXT NOT NULL REFERENCES aw_agent_instances(id),
        decision TEXT NOT NULL CHECK(decision IN ('PASS','FAIL','NEEDS_WORK')),
        evidence_ids_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX aw_agents_project_idx ON aw_agent_instances(project_id, created_at);
      CREATE INDEX aw_evidence_task_idx ON aw_evidence(project_id, task_id, created_at);
      CREATE TRIGGER aw_capability_snapshot_immutable
        BEFORE UPDATE ON aw_capability_snapshots WHEN OLD.sealed=1
        BEGIN SELECT RAISE(ABORT, 'capability snapshot is immutable'); END;
      CREATE TRIGGER aw_capability_item_immutable
        BEFORE UPDATE ON aw_capabilities
        BEGIN SELECT RAISE(ABORT, 'capability snapshot item is immutable'); END;
      CREATE TRIGGER aw_capability_item_insert_sealed
        BEFORE INSERT ON aw_capabilities
        WHEN (SELECT sealed FROM aw_capability_snapshots WHERE id=NEW.snapshot_id)=1
        BEGIN SELECT RAISE(ABORT, 'capability snapshot is sealed'); END;
    `,
  },
];
