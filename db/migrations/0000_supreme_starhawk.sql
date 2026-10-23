CREATE TABLE `grocery_manual` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`text` text NOT NULL,
	`checked` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `grocery_state` (
	`plan_id` integer NOT NULL,
	`ingredient_id` integer NOT NULL,
	`checked` integer NOT NULL,
	PRIMARY KEY(`plan_id`, `ingredient_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `habit_log` (
	`date` text NOT NULL,
	`person_id` integer NOT NULL,
	`habit_id` integer NOT NULL,
	`done` integer NOT NULL,
	PRIMARY KEY(`date`, `person_id`, `habit_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `habits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`evidence_grade` text NOT NULL,
	`evidence_note` text NOT NULL,
	`source_url` text,
	`caution` text,
	`default_on` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `habits_slug_unique` ON `habits` (`slug`);--> statement-breakpoint
CREATE TABLE `ingredient_micros` (
	`ingredient_id` integer PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`per100g` text NOT NULL,
	`not_reported` text NOT NULL,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`aliases` text NOT NULL,
	`state` text NOT NULL,
	`cooked_yield` real,
	`kcal` real NOT NULL,
	`protein_g` real NOT NULL,
	`carbs_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`fibre_g` real NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`aisle` text NOT NULL,
	`pack_size_g` real,
	`where_to_buy` text NOT NULL,
	`is_pantry_staple` integer NOT NULL,
	`contains_onion_garlic` integer NOT NULL,
	`is_dairy` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingredients_slug_uq` ON `ingredients` (`slug`);--> statement-breakpoint
CREATE INDEX `ingredients_aisle_idx` ON `ingredients` (`aisle`);--> statement-breakpoint
CREATE TABLE `pantry` (
	`ingredient_id` integer PRIMARY KEY NOT NULL,
	`have` integer NOT NULL,
	`always_stock` integer NOT NULL,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sex` text NOT NULL,
	`birth_date` text NOT NULL,
	`height_cm` real NOT NULL,
	`weight_kg` real NOT NULL,
	`activity_level` text NOT NULL,
	`protein_target_g` real,
	`protein_g_per_kg` real,
	`kcal_target` real,
	`reminder_time` text,
	`diet_flags` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_setups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`person_ids` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`meal_types` text NOT NULL,
	`cuisine_balance` real NOT NULL,
	`max_active_min` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_slot_portions` (
	`plan_slot_id` integer NOT NULL,
	`person_id` integer NOT NULL,
	`servings` real NOT NULL,
	PRIMARY KEY(`plan_slot_id`, `person_id`),
	FOREIGN KEY (`plan_slot_id`) REFERENCES `plan_slots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plan_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`recipe_id` integer NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`is_leftover` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plan_slots_plan_idx` ON `plan_slots` (`plan_id`,`date`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`setup_id` integer NOT NULL,
	`seed` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`setup_id`) REFERENCES `plan_setups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`person_id` integer NOT NULL,
	`ingredient_id` integer,
	`recipe_id` integer,
	`kind` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `preferences_person_idx` ON `preferences` (`person_id`);--> statement-breakpoint
CREATE TABLE `prep_task_state` (
	`date` text NOT NULL,
	`task_key` text NOT NULL,
	`done` integer NOT NULL,
	PRIMARY KEY(`date`, `task_key`)
);
--> statement-breakpoint
CREATE TABLE `recipe_advance_prep` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`kind` text NOT NULL,
	`ingredient_id` integer,
	`grams` real,
	`lead_hours` real NOT NULL,
	`instruction` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recipe_anchors` (
	`recipe_id` integer NOT NULL,
	`ingredient_id` integer NOT NULL,
	`protein_g` real NOT NULL,
	PRIMARY KEY(`recipe_id`, `ingredient_id`),
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipe_anchors_ingredient_idx` ON `recipe_anchors` (`ingredient_id`);--> statement-breakpoint
CREATE TABLE `recipe_feedback` (
	`recipe_id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`rating` integer,
	`favourite` integer DEFAULT false NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`notes` text,
	`tested_at` text,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recipe_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`position` integer NOT NULL,
	`ingredient_id` integer,
	`component_id` integer,
	`grams` real NOT NULL,
	`display_qty` real,
	`display_unit` text,
	`optional` integer NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`component_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipe_items_recipe_idx` ON `recipe_items` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `recipe_items_ingredient_idx` ON `recipe_items` (`ingredient_id`);--> statement-breakpoint
CREATE TABLE `recipe_macros` (
	`recipe_id` integer PRIMARY KEY NOT NULL,
	`kcal` real NOT NULL,
	`protein_g` real NOT NULL,
	`carbs_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`fibre_g` real NOT NULL,
	`auto_tags` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recipe_steps` (
	`recipe_id` integer NOT NULL,
	`step_no` integer NOT NULL,
	`text` text NOT NULL,
	`technique_id` integer,
	`timer_sec` integer,
	PRIMARY KEY(`recipe_id`, `step_no`),
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`technique_id`) REFERENCES `techniques`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`family` text NOT NULL,
	`meal_slots` text NOT NULL,
	`cuisine` text NOT NULL,
	`is_indian` integer NOT NULL,
	`servings` real NOT NULL,
	`prep_min` integer NOT NULL,
	`active_min` integer NOT NULL,
	`total_min` integer NOT NULL,
	`equipment` text NOT NULL,
	`tags` text NOT NULL,
	`fridge_days` integer NOT NULL,
	`image` text,
	`image_credit` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipes_slug_uq` ON `recipes` (`slug`);--> statement-breakpoint
CREATE INDEX `recipes_family_idx` ON `recipes` (`family`);--> statement-breakpoint
CREATE TABLE `techniques` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`tags` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `techniques_slug_uq` ON `techniques` (`slug`);