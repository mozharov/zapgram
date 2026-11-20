CREATE TABLE `donation_payment_slots` (
	`key` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `donations` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `pending_donation_payments` ADD `attempt_id` text;