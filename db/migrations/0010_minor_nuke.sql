CREATE TABLE `plan_progress` (
	`plan_id` integer NOT NULL,
	`step` text NOT NULL,
	`done_at` text NOT NULL,
	PRIMARY KEY(`plan_id`, `step`),
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plan_progress_step_ck" CHECK("plan_progress"."step" in ('reviewed', 'shopping', 'prep'))
);
--> statement-breakpoint
ALTER TABLE `plan_setups` ADD `shopping_day` integer;--> statement-breakpoint
ALTER TABLE `plan_setups` ADD `prep_day` integer;