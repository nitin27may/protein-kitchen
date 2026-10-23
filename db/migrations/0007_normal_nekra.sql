CREATE TABLE `plan_part_state` (
	`plan_id` integer NOT NULL,
	`component_slug` text NOT NULL,
	`mode` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`plan_id`, `component_slug`),
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plan_part_state_mode_ck" CHECK("plan_part_state"."mode" in ('make', 'buy', 'have'))
);
