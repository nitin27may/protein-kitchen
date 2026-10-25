DROP INDEX "household_invitations_pending_email_uq";--> statement-breakpoint
DROP INDEX "household_invitations_pending_person_uq";--> statement-breakpoint
ALTER TABLE "household_invitations" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD COLUMN "relationship" text;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "household_invitations_pending_email_uq" ON "household_invitations" USING btree ("household_id","email") WHERE "household_invitations"."household_id" is not null and "household_invitations"."accepted_at" is null and "household_invitations"."declined_at" is null and "household_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "household_invitations_pending_person_uq" ON "household_invitations" USING btree ("person_id") WHERE "household_invitations"."accepted_at" is null and "household_invitations"."declined_at" is null and "household_invitations"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_relationship_check" CHECK ("household_invitations"."relationship" is null or length(trim("household_invitations"."relationship")) between 1 and 40);