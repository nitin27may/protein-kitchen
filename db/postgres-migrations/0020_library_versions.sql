CREATE TABLE "library_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "library_versions" ("version") SELECT "version" FROM "library_state" ON CONFLICT DO NOTHING;
