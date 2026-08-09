ALTER TABLE `users` ADD `donation_percent` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `donation_scope` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `monthly_donation_sats` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `monthly_donation_next_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `monthly_donation_last_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `monthly_donation_last_fail_notify_at` integer;--> statement-breakpoint
CREATE TABLE `donations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`amount_sats` integer NOT NULL,
	`kind` text NOT NULL,
	`payment_hash` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `donations_user_id_idx` ON `donations` (`user_id`);--> statement-breakpoint
CREATE INDEX `users_monthly_donation_due_idx` ON `users` (`monthly_donation_next_at`) WHERE `monthly_donation_sats` > 0 AND `monthly_donation_next_at` IS NOT NULL;
