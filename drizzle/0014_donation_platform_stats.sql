CREATE INDEX `donations_created_at_idx` ON `donations` (`created_at`);--> statement-breakpoint
CREATE TABLE `donation_platform_stats` (
	`id` integer PRIMARY KEY NOT NULL,
	`total_sats` integer DEFAULT 0 NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `donation_platform_stats_singleton` CHECK (`id` = 1)
);
--> statement-breakpoint
INSERT INTO `donation_platform_stats` (`id`, `total_sats`, `total_count`)
SELECT 1,
  coalesce((SELECT sum(`amount_sats`) FROM `donations`), 0),
  coalesce((SELECT count(*) FROM `donations`), 0);
