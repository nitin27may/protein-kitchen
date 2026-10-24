CREATE TABLE "reminder_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"date" date NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_deliveries" (
	"batch_id" text NOT NULL,
	"subscription_id" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempt_token" text,
	"attempted_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reminder_deliveries_batch_id_subscription_id_pk" PRIMARY KEY("batch_id","subscription_id"),
	CONSTRAINT "reminder_delivery_status_valid" CHECK ("reminder_deliveries"."status" in ('pending', 'sending', 'accepted', 'gone', 'cancelled', 'retry', 'ambiguous')),
	CONSTRAINT "reminder_delivery_attempts_valid" CHECK ("reminder_deliveries"."attempts" >= 0 and "reminder_deliveries"."attempts" <= 3)
);
--> statement-breakpoint
ALTER TABLE "reminder_batches" ADD CONSTRAINT "reminder_batches_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_batch_id_reminder_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."reminder_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_batch_day_uq" ON "reminder_batches" USING btree ("person_id","date");