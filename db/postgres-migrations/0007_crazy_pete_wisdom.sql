CREATE TABLE "state_sync_jobs" (
	"target_key" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"checkpoint_commit" text,
	"acknowledged" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending" jsonb,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "state_sync_job_status_valid" CHECK ("state_sync_jobs"."status" in ('idle', 'running', 'success', 'error', 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "state_sync_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"target_key" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "state_sync_request_status_valid" CHECK ("state_sync_requests"."status" in ('running', 'success', 'error', 'conflict'))
);
--> statement-breakpoint
ALTER TABLE "state_sync_requests" ADD CONSTRAINT "state_sync_requests_target_key_state_sync_jobs_target_key_fk" FOREIGN KEY ("target_key") REFERENCES "public"."state_sync_jobs"("target_key") ON DELETE cascade ON UPDATE no action;