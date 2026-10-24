ALTER TABLE "sync_state" DROP CONSTRAINT "sync_state_pkey";--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_household_class_uq" UNIQUE NULLS NOT DISTINCT("household_id","data_class");
