CREATE TABLE `recipe_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`recipe_id` integer NOT NULL,
	`part_slug` text,
	`step_no` integer,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`source` text,
	`start_sec` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by_person_id` integer,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recipe_links_kind_ck" CHECK("recipe_links"."kind" in ('recipe', 'video', 'article'))
);
--> statement-breakpoint
CREATE INDEX `recipe_links_recipe_idx` ON `recipe_links` (`recipe_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_links_uid_uq` ON `recipe_links` (`uid`);