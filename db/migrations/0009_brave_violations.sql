CREATE TABLE `person_routines` (
	`person_id` integer NOT NULL,
	`habit_id` integer NOT NULL,
	`days` text NOT NULL,
	`time_of_day` text NOT NULL,
	`servings` real NOT NULL,
	`active` integer NOT NULL,
	`uid` text,
	`created_at` text,
	`updated_at` text,
	`created_by_person_id` integer,
	PRIMARY KEY(`person_id`, `habit_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_routines_uid_uq` ON `person_routines` (`uid`);--> statement-breakpoint
CREATE TABLE `plan_routines` (
	`plan_id` integer NOT NULL,
	`person_id` integer NOT NULL,
	`habit_id` integer NOT NULL,
	`days` text NOT NULL,
	`time_of_day` text NOT NULL,
	`servings` real NOT NULL,
	PRIMARY KEY(`plan_id`, `person_id`, `habit_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE no action
);
