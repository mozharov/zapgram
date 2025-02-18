CREATE TABLE `conversations` (
	`key` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` integer PRIMARY KEY NOT NULL,
	`commands` text DEFAULT '["send","tip","zap"]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`nwc` integer DEFAULT false NOT NULL,
	`payment_request` text NOT NULL,
	`type` text NOT NULL,
	`preimage` text,
	`network_fees` integer DEFAULT 0 NOT NULL,
	`service_fees` integer DEFAULT 0 NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`notify` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payment_request_idx` ON `invoices` (`payment_request`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`username` text,
	`language_code` text DEFAULT 'en' NOT NULL,
	`nwc_tips` integer DEFAULT false NOT NULL,
	`nwc_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `username_idx` ON `users` (`username`);