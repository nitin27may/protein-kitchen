CREATE TABLE `saved_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list` text NOT NULL,
	`name` text NOT NULL,
	`query` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saved_views_list_idx` ON `saved_views` (`list`);