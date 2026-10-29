CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,                       -- "j" + 6 chars [a-z0-9] (Crockford-safe, no 0/o/1/l), e.g. j7f3k2q
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,                        -- tombstone while runs are active
  generation INTEGER NOT NULL DEFAULT 1,     -- +1 on ANY definition/enablement mutation (monotonic)
  schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('at','every','cron')),
  schedule_json TEXT NOT NULL, tz TEXT NOT NULL, stagger_ms INTEGER NOT NULL, -- normalized width; creation must supply it
  payload_kind TEXT NOT NULL CHECK(payload_kind IN ('agentTurn','reminder')),
  payload_json TEXT NOT NULL,                -- {message, model?, effort?, timeoutSeconds?} | {text}
  exec_mode TEXT NOT NULL CHECK(exec_mode IN ('session','isolated')),
  target_session TEXT NOT NULL, target_channel_id TEXT NOT NULL, target_channel_type INTEGER NOT NULL,
  delivery_mode TEXT NOT NULL DEFAULT 'announce' CHECK(delivery_mode IN ('announce','none')),
  delete_after_run INTEGER NOT NULL,         -- default 1 for 'at' unless --keep, else 0
  creator_uid TEXT NOT NULL,
  schedule_activated_at INTEGER NOT NULL,    -- fences pre-edit catch-up
  last_slot_watermark INTEGER,               -- max effective slot committed by terminal base-consume projection in current generation
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  next_run_at INTEGER, last_run_at INTEGER, last_status TEXT, last_completion TEXT,
  last_error TEXT, last_error_reason TEXT, last_duration_ms INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0, consecutive_skipped INTEGER NOT NULL DEFAULT 0,
  consecutive_target_failures INTEGER NOT NULL DEFAULT 0, schedule_error_count INTEGER NOT NULL DEFAULT 0,
  auto_disabled_reason TEXT, auto_disabled_at INTEGER,
  alert_incident_key TEXT, alert_occurrence INTEGER NOT NULL DEFAULT 0, last_alert_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON cron_jobs(enabled, next_run_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS cron_runs (
  run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','catchup','retry','manual')),
  manual_mode TEXT CHECK(manual_mode IN ('if-enabled','due','force')),
  schedule_ownership TEXT NOT NULL CHECK(schedule_ownership IN ('consume','borrow','none')),
  authored_occurrence_id TEXT, authored_slot INTEGER,
  admitted_enabled INTEGER NOT NULL CHECK(admitted_enabled IN (0,1)),
  admitted_next_run_at INTEGER,
  scheduled_for INTEGER,                     -- effective authored slot for consume; NULL for borrow/manual recurring
  attempt INTEGER NOT NULL DEFAULT 0,        -- 0 base; 1..3 retries
  occurrence_id TEXT NOT NULL,               -- consume: canonical authored ID; borrow: unique manual ID; stable across retries
  ready_at INTEGER NOT NULL,                 -- retry/admission eligibility; not the schedule slot
  status TEXT NOT NULL CHECK(status IN ('queued','running','ok','error','skipped','interrupted')),
  phase TEXT CHECK(phase IN ('admission','executing','delivering')),
  completion TEXT CHECK(completion IN ('succeeded','failed','unknown')),
  delivery_state TEXT NOT NULL DEFAULT 'not-started' CHECK(delivery_state IN
    ('not-started','started','delivered','not-delivered','unknown','suppressed','not-requested')),
  segments_sent INTEGER NOT NULL DEFAULT 0,
  history_state TEXT,                        -- §3.2.4
  reason TEXT, error TEXT,                   -- classified reason (§3.4.3) + redacted error
  admitted_generation INTEGER NOT NULL, definition_snapshot_json TEXT NOT NULL,  -- execution/delivery uses ONLY this
  reset_generation INTEGER NOT NULL, owner_incarnation TEXT NOT NULL,
  exec_mode TEXT NOT NULL, thread_id TEXT, turn_id TEXT, model TEXT, usage_json TEXT, summary TEXT,
  lane_wait_ms INTEGER, queued_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_single_flight ON cron_runs(job_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_slot_attempt ON cron_runs(job_id, admitted_generation, scheduled_for, attempt)
  WHERE trigger IN ('scheduled','catchup','retry');
CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_occurrence_attempt ON cron_runs(occurrence_id, attempt);
CREATE INDEX IF NOT EXISTS idx_cron_runs_ready ON cron_runs(status, ready_at);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_time ON cron_runs(job_id, queued_at DESC);

