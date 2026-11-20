CREATE TABLE attempt_study_context (
  event_id TEXT PRIMARY KEY REFERENCES attempts(event_id),
  study_mode TEXT NOT NULL CHECK (study_mode IN ('normal', 'review', 'unclassified')),
  review_plan_id TEXT,
  payload_checksum TEXT NOT NULL CHECK (length(payload_checksum) = 64),
  CHECK (review_plan_id IS NULL OR study_mode = 'review')
) STRICT;

CREATE TRIGGER attempt_study_context_no_update BEFORE UPDATE ON attempt_study_context
BEGIN SELECT RAISE(ABORT, 'attempt_study_context is append-only'); END;
CREATE TRIGGER attempt_study_context_no_delete BEFORE DELETE ON attempt_study_context
BEGIN SELECT RAISE(ABORT, 'attempt_study_context is append-only'); END;
