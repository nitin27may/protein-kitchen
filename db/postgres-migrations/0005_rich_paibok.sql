ALTER TABLE "household_bootstrap" DROP CONSTRAINT "household_bootstrap_owner_user_id_auth_users_id_fk";
--> statement-breakpoint
ALTER TABLE "household_bootstrap" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "household_bootstrap" ADD CONSTRAINT "household_bootstrap_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;