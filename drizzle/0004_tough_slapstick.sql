CREATE TABLE `chats` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`price` integer DEFAULT 1000 NOT NULL,
	`status` text DEFAULT 'inactive' NOT NULL,
	`payment_type` text DEFAULT 'one_time' NOT NULL,
	`owner_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `subscription_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`payment_request` text NOT NULL,
	`payment_hash` text NOT NULL,
	`price` integer NOT NULL,
	`subscription_type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`price` integer NOT NULL,
	`ends_at` integer,
	`auto_renew` integer DEFAULT true NOT NULL,
	`notification_sent` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
