-- Activation and delivery evidence are immutable. Only the operational lease
-- is mutable: it coordinates processes on one Mac and is not answer evidence.
CREATE TABLE notion_sync_targets (
  target TEXT PRIMARY KEY CHECK (length(target) BETWEEN 1 AND 255),
  after_attempt_rowid INTEGER NOT NULL CHECK (after_attempt_rowid >= 0),
  activated_at_ms INTEGER NOT NULL CHECK (
    activated_at_ms BETWEEN 0 AND 253402300799999
  )
) STRICT;

CREATE TABLE notion_sync_journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL REFERENCES notion_sync_targets(target),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('question', 'attempt')),
  resource_key TEXT NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 36),
  status TEXT NOT NULL CHECK (status IN ('creating', 'confirmed', 'retry', 'blocked')),
  page_id TEXT CHECK (page_id IS NULL OR length(page_id) IN (32, 36)),
  code TEXT CHECK (code IS NULL OR length(code) BETWEEN 1 AND 64),
  retry_at_ms INTEGER CHECK (
    retry_at_ms IS NULL OR retry_at_ms BETWEEN 0 AND 253402300799999
  ),
  recorded_at_ms INTEGER NOT NULL CHECK (
    recorded_at_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (status <> 'confirmed' OR page_id IS NOT NULL)
) STRICT;

CREATE INDEX notion_sync_journal_resource_sequence
  ON notion_sync_journal(target, resource_kind, resource_key, sequence DESC);

CREATE TABLE notion_sync_leases (
  target TEXT PRIMARY KEY REFERENCES notion_sync_targets(target),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN 0 AND 253402300799999
  )
) STRICT;

CREATE TRIGGER notion_sync_targets_reject_update
BEFORE UPDATE ON notion_sync_targets
BEGIN
  SELECT RAISE(ABORT, 'NOTION_SYNC_TARGETS_APPEND_ONLY');
END;

CREATE TRIGGER notion_sync_targets_reject_delete
BEFORE DELETE ON notion_sync_targets
BEGIN
  SELECT RAISE(ABORT, 'NOTION_SYNC_TARGETS_APPEND_ONLY');
END;

CREATE TRIGGER notion_sync_journal_reject_update
BEFORE UPDATE ON notion_sync_journal
BEGIN
  SELECT RAISE(ABORT, 'NOTION_SYNC_JOURNAL_APPEND_ONLY');
END;

CREATE TRIGGER notion_sync_journal_reject_delete
BEFORE DELETE ON notion_sync_journal
BEGIN
  SELECT RAISE(ABORT, 'NOTION_SYNC_JOURNAL_APPEND_ONLY');
END;
