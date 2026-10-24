CREATE TABLE "households" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "households_name_check" CHECK (length(trim("households"."name")) between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "household_invitations" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "household_members" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "pantry" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "photo_decisions" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "plan_setups" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "prep_task_state" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "recipe_feedback" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "recipe_links" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "saved_views" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "state_sync_jobs" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry" ADD CONSTRAINT "pantry_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_decisions" ADD CONSTRAINT "photo_decisions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_setups" ADD CONSTRAINT "plan_setups_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_task_state" ADD CONSTRAINT "prep_task_state_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_feedback" ADD CONSTRAINT "recipe_feedback_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_links" ADD CONSTRAINT "recipe_links_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_sync_jobs" ADD CONSTRAINT "state_sync_jobs_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "household_invitations_household_idx" ON "household_invitations" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "household_members_household_idx" ON "household_members" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "pantry_household_idx" ON "pantry" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "people_household_idx" ON "people" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "photo_decisions_household_idx" ON "photo_decisions" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "photos_household_idx" ON "photos" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "plan_setups_household_idx" ON "plan_setups" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "plans_household_idx" ON "plans" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "prep_task_state_household_idx" ON "prep_task_state" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "recipe_feedback_household_idx" ON "recipe_feedback" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "recipe_links_household_idx" ON "recipe_links" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "saved_views_household_idx" ON "saved_views" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "state_sync_jobs_household_idx" ON "state_sync_jobs" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "sync_state_household_idx" ON "sync_state" USING btree ("household_id");
--> statement-breakpoint
INSERT INTO "households" ("id", "name")
SELECT '00000000-0000-4000-8000-000000000001', 'Existing household'
WHERE EXISTS (
  SELECT 1 FROM "household_invitations"
  UNION ALL SELECT 1 FROM "household_members"
  UNION ALL SELECT 1 FROM "pantry"
  UNION ALL SELECT 1 FROM "people"
  UNION ALL SELECT 1 FROM "photo_decisions"
  UNION ALL SELECT 1 FROM "photos"
  UNION ALL SELECT 1 FROM "plan_setups"
  UNION ALL SELECT 1 FROM "plans"
  UNION ALL SELECT 1 FROM "prep_task_state"
  UNION ALL SELECT 1 FROM "recipe_feedback"
  UNION ALL SELECT 1 FROM "recipe_links"
  UNION ALL SELECT 1 FROM "saved_views"
  UNION ALL SELECT 1 FROM "state_sync_jobs"
  UNION ALL SELECT 1 FROM "sync_state"
);
--> statement-breakpoint
UPDATE "household_invitations" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "household_members" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "pantry" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "people" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "photo_decisions" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "photos" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "plan_setups" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "plans" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "prep_task_state" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "recipe_feedback" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "recipe_links" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "saved_views" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "state_sync_jobs" SET "household_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "sync_state" SET "household_id" = '00000000-0000-4000-8000-000000000001';