ALTER TABLE "household_members" DROP CONSTRAINT "household_members_pkey";--> statement-breakpoint
CREATE INDEX "household_members_user_idx" ON "household_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_user_uq" UNIQUE NULLS NOT DISTINCT("household_id","user_id");