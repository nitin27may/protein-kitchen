-- A database that ran the first draft of 0011 has photo_decisions_candidate_uq on candidate_key alone. The same Commons
-- file can be a candidate for two subjects, so the index is per subject. A fresh database already has this index from 0011;
-- dropping and creating it again is harmless there.
DROP INDEX IF EXISTS `photo_decisions_candidate_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `photo_decisions_candidate_uq` ON `photo_decisions` (`subject_kind`,`subject_slug`,`candidate_key`);--> statement-breakpoint
ALTER TABLE `ingredients` DROP COLUMN `image`;--> statement-breakpoint
ALTER TABLE `ingredients` DROP COLUMN `image_credit`;--> statement-breakpoint
ALTER TABLE `recipes` DROP COLUMN `image`;--> statement-breakpoint
ALTER TABLE `recipes` DROP COLUMN `image_credit`;