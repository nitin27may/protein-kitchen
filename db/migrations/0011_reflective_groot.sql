CREATE TABLE `photo_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`candidate_key` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_slug` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by_person_id` integer,
	FOREIGN KEY (`created_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "photo_decisions_kind_ck" CHECK("photo_decisions"."subject_kind" in ('recipe', 'ingredient')),
	CONSTRAINT "photo_decisions_decision_ck" CHECK("photo_decisions"."decision" in ('approved', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_decisions_uid_uq` ON `photo_decisions` (`uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `photo_decisions_candidate_uq` ON `photo_decisions` (`subject_kind`,`subject_slug`,`candidate_key`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`recipe_id` integer,
	`ingredient_slug` text,
	`origin` text NOT NULL,
	`candidate_key` text,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`is_cover` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text,
	`author` text,
	`licence` text,
	`licence_url` text,
	`source_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by_person_id` integer,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "photos_origin_ck" CHECK("photos"."origin" in ('upload', 'commons', 'openverse')),
	CONSTRAINT "photos_subject_ck" CHECK(("photos"."recipe_id" is not null) + ("photos"."ingredient_slug" is not null) = 1)
);
--> statement-breakpoint
CREATE INDEX `photos_recipe_idx` ON `photos` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `photos_ingredient_idx` ON `photos` (`ingredient_slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `photos_uid_uq` ON `photos` (`uid`);