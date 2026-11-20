CREATE TABLE attempts (
  event_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  record_type TEXT NOT NULL CHECK (record_type = 'attempt_event'),
  question_key TEXT NOT NULL,
  question_group_id TEXT,
  answered_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('correct', 'incorrect', 'unknown')),
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_record_id TEXT,
  recorded_at TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (acquisition_method = 'direct_capture'),
  temporal_precision TEXT NOT NULL CHECK (temporal_precision = 'exact'),
  state_precision TEXT NOT NULL CHECK (state_precision = 'exact'),
  payload_checksum TEXT NOT NULL CHECK (length(payload_checksum) = 64)
) STRICT;

CREATE UNIQUE INDEX attempts_source_record_unique
  ON attempts (source_system, source_record_id)
  WHERE source_record_id IS NOT NULL;

CREATE INDEX attempts_question_answered_at
  ON attempts (question_key, answered_at);

CREATE TABLE attempt_selected_options (
  event_id TEXT NOT NULL REFERENCES attempts(event_id),
  option_index INTEGER NOT NULL CHECK (
    option_index BETWEEN 1 AND 9007199254740991
  ),
  PRIMARY KEY (event_id, option_index)
) STRICT;

CREATE TABLE history_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  record_type TEXT NOT NULL CHECK (record_type = 'history_snapshot'),
  snapshot_run_id TEXT NOT NULL,
  question_key TEXT NOT NULL,
  question_group_id TEXT,
  observed_at TEXT NOT NULL,
  final_state TEXT NOT NULL CHECK (
    final_state IN ('correct', 'incorrect', 'unknown', 'unattempted')
  ),
  attempt_count INTEGER CHECK (
    attempt_count IS NULL OR attempt_count BETWEEN 0 AND 9007199254740991
  ),
  last_attempted_at TEXT,
  last_attempted_on TEXT,
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_record_id TEXT,
  recorded_at TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN ('direct_capture', 'imported_baseline', 'derived', 'manual')
  ),
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('exact', 'date_only', 'not_applicable')
  ),
  state_precision TEXT NOT NULL CHECK (
    state_precision IN ('exact', 'final_state_only', 'not_applicable')
  ),
  payload_checksum TEXT NOT NULL CHECK (length(payload_checksum) = 64),
  CHECK (
    (temporal_precision = 'exact' AND last_attempted_at IS NOT NULL AND last_attempted_on IS NULL)
    OR
    (temporal_precision = 'date_only' AND last_attempted_at IS NULL AND last_attempted_on IS NOT NULL)
    OR
    (temporal_precision = 'not_applicable' AND last_attempted_at IS NULL AND last_attempted_on IS NULL)
  ),
  UNIQUE (snapshot_run_id, question_key)
) STRICT;

CREATE UNIQUE INDEX history_snapshots_source_record_unique
  ON history_snapshots (source_system, source_record_id)
  WHERE source_record_id IS NOT NULL;

CREATE INDEX history_snapshots_run_question
  ON history_snapshots (snapshot_run_id, question_key);

CREATE TABLE question_states (
  state_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  record_type TEXT NOT NULL CHECK (record_type = 'question_state'),
  question_key TEXT NOT NULL UNIQUE,
  question_group_id TEXT,
  computed_at TEXT NOT NULL,
  algorithm_id TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  evidence_watermark TEXT,
  evidence_sufficiency TEXT NOT NULL CHECK (
    evidence_sufficiency IN ('insufficient', 'partial', 'sufficient')
  ),
  next_review_on TEXT,
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_record_id TEXT,
  recorded_at TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN ('direct_capture', 'imported_baseline', 'derived', 'manual')
  ),
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('exact', 'date_only', 'not_applicable')
  ),
  state_precision TEXT NOT NULL CHECK (
    state_precision IN ('exact', 'final_state_only', 'not_applicable')
  ),
  payload_checksum TEXT NOT NULL CHECK (length(payload_checksum) = 64)
) STRICT;

CREATE TABLE review_plans (
  review_plan_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  record_type TEXT NOT NULL CHECK (record_type = 'review_plan'),
  target_date TEXT NOT NULL,
  timezone TEXT NOT NULL CHECK (timezone = 'Asia/Tokyo'),
  generated_at TEXT NOT NULL,
  algorithm_id TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 9007199254740991),
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_record_id TEXT,
  recorded_at TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN ('direct_capture', 'imported_baseline', 'derived', 'manual')
  ),
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('exact', 'date_only', 'not_applicable')
  ),
  state_precision TEXT NOT NULL CHECK (
    state_precision IN ('exact', 'final_state_only', 'not_applicable')
  ),
  payload_checksum TEXT NOT NULL CHECK (length(payload_checksum) = 64)
) STRICT;

CREATE TABLE review_plan_items (
  review_plan_item_id TEXT PRIMARY KEY,
  review_plan_id TEXT NOT NULL REFERENCES review_plans(review_plan_id),
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  record_type TEXT NOT NULL CHECK (record_type = 'review_plan_item'),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 9007199254740991),
  question_key TEXT NOT NULL,
  question_group_id TEXT,
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_record_id TEXT,
  recorded_at TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN ('direct_capture', 'imported_baseline', 'derived', 'manual')
  ),
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('exact', 'date_only', 'not_applicable')
  ),
  state_precision TEXT NOT NULL CHECK (
    state_precision IN ('exact', 'final_state_only', 'not_applicable')
  ),
  payload_checksum TEXT NOT NULL CHECK (length(payload_checksum) = 64),
  UNIQUE (review_plan_id, position),
  UNIQUE (review_plan_id, question_key)
) STRICT;

CREATE TABLE review_plan_item_reasons (
  review_plan_item_id TEXT NOT NULL REFERENCES review_plan_items(review_plan_item_id),
  reason TEXT NOT NULL,
  PRIMARY KEY (review_plan_item_id, reason)
) STRICT;

CREATE TABLE set_creation_runs (
  run_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  record_type TEXT NOT NULL CHECK (record_type = 'set_creation_run'),
  request_id TEXT NOT NULL,
  result_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'succeeded', 'partial', 'blocked', 'failed')
  ),
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  requested_count INTEGER NOT NULL CHECK (
    requested_count BETWEEN 0 AND 9007199254740991
  ),
  created_count INTEGER NOT NULL CHECK (
    created_count BETWEEN 0 AND 9007199254740991
  ),
  safe_error_code TEXT,
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_record_id TEXT,
  recorded_at TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN ('direct_capture', 'imported_baseline', 'derived', 'manual')
  ),
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('exact', 'date_only', 'not_applicable')
  ),
  state_precision TEXT NOT NULL CHECK (
    state_precision IN ('exact', 'final_state_only', 'not_applicable')
  )
) STRICT;

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  record_type TEXT NOT NULL CHECK (record_type = 'sync_run'),
  direction TEXT NOT NULL CHECK (direction = 'sqlite_to_google_sheets'),
  status TEXT NOT NULL CHECK (
    status IN ('succeeded', 'partial', 'blocked', 'failed')
  ),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  read_count INTEGER NOT NULL CHECK (read_count BETWEEN 0 AND 9007199254740991),
  written_count INTEGER NOT NULL CHECK (
    written_count BETWEEN 0 AND 9007199254740991
  ),
  skipped_count INTEGER NOT NULL CHECK (
    skipped_count BETWEEN 0 AND 9007199254740991
  ),
  safe_error_code TEXT,
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_record_id TEXT,
  recorded_at TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (
    acquisition_method IN ('direct_capture', 'imported_baseline', 'derived', 'manual')
  ),
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('exact', 'date_only', 'not_applicable')
  ),
  state_precision TEXT NOT NULL CHECK (
    state_precision IN ('exact', 'final_state_only', 'not_applicable')
  )
) STRICT;

CREATE TABLE system_logs (
  log_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
  component TEXT NOT NULL,
  event_code TEXT NOT NULL,
  run_id TEXT,
  correlation_id TEXT,
  record_id TEXT,
  question_key TEXT
) STRICT;

CREATE INDEX system_logs_occurred_at
  ON system_logs (occurred_at);

CREATE TABLE system_log_counters (
  log_id TEXT NOT NULL REFERENCES system_logs(log_id),
  counter_name TEXT NOT NULL,
  counter_value REAL NOT NULL,
  PRIMARY KEY (log_id, counter_name)
) STRICT;
