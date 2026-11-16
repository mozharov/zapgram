CREATE TABLE `pending_donation_payments` (
	`payment_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount_sats` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pending_donation_payments_kind_check" CHECK("pending_donation_payments"."kind" in ('one_shot', 'percent', 'feature_request'))
);
--> statement-breakpoint
CREATE INDEX `pending_donation_payments_user_kind_idx` ON `pending_donation_payments` (`user_id`,`kind`);--> statement-breakpoint
ALTER TABLE `users` ADD `monthly_donation_expires_at` integer;
