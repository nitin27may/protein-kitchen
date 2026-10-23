CREATE TABLE `sync_state` (
	`data_class` text PRIMARY KEY NOT NULL,
	`changed_at` text NOT NULL,
	`exported_at` text
);
--> statement-breakpoint
ALTER TABLE `recipe_feedback` ADD `uid` text;--> statement-breakpoint
ALTER TABLE `recipe_feedback` ADD `created_at` text;--> statement-breakpoint
ALTER TABLE `recipe_feedback` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `recipe_feedback` ADD `created_by_person_id` integer REFERENCES people(id);--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_feedback_uid_uq` ON `recipe_feedback` (`uid`);--> statement-breakpoint
ALTER TABLE `saved_views` ADD `uid` text;--> statement-breakpoint
ALTER TABLE `saved_views` ADD `created_at` text;--> statement-breakpoint
ALTER TABLE `saved_views` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `saved_views` ADD `created_by_person_id` integer REFERENCES people(id);--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_uid_uq` ON `saved_views` (`uid`);
--> statement-breakpoint
UPDATE `recipe_feedback` SET `uid` = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) WHERE `uid` IS NULL;--> statement-breakpoint
UPDATE `recipe_feedback` SET `created_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now'), `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE `created_at` IS NULL;
--> statement-breakpoint
UPDATE `saved_views` SET `uid` = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) WHERE `uid` IS NULL;--> statement-breakpoint
UPDATE `saved_views` SET `created_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now'), `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE `created_at` IS NULL;
