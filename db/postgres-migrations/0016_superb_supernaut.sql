ALTER TABLE "prep_task_state" DROP CONSTRAINT "prep_task_state_date_task_key_pk";--> statement-breakpoint
ALTER TABLE "pantry" DROP CONSTRAINT "pantry_pkey";--> statement-breakpoint
ALTER TABLE "pantry" ADD CONSTRAINT "pantry_household_ingredient_uq" UNIQUE NULLS NOT DISTINCT("household_id","ingredient_id");--> statement-breakpoint
ALTER TABLE "prep_task_state" ADD CONSTRAINT "prep_task_state_household_task_uq" UNIQUE NULLS NOT DISTINCT("household_id","date","task_key");
