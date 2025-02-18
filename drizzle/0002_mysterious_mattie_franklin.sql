CREATE TABLE `pending_invoices` (
	`payment_request` text PRIMARY KEY NOT NULL,
	`payment_hash` text NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer DEFAULT (unixepoch() + 60 * 60 * 24 * 7) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `groups`;--> statement-breakpoint
ALTER TABLE `users` ADD `first_name` text;