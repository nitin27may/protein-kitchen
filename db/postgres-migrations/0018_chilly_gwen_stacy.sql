ALTER TABLE "auth_sessions" ADD COLUMN "active_household_id" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "household_selection_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_active_household_id_households_id_fk" FOREIGN KEY ("active_household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_selection_version_check" CHECK ("auth_sessions"."household_selection_version" >= 0);