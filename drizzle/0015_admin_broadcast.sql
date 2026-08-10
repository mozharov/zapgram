ALTER TABLE `users` ADD `bot_blocked` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `users_bot_blocked_idx` ON `users` (`bot_blocked`);--> statement-breakpoint
CREATE TABLE `broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` integer NOT NULL,
	`locale` text NOT NULL,
	`source_chat_id` integer NOT NULL,
	`source_message_id` integer NOT NULL,
	`status` text DEFAULT 'sending' NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`report_sent_at` integer,
	FOREIGN KEY (`admin_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `broadcasts_status_check` CHECK (`status` in ('sending', 'completed', 'cancelled', 'failed')),
	CONSTRAINT `broadcasts_locale_check` CHECK (`locale` in ('en', 'ru'))
);
--> statement-breakpoint
CREATE INDEX `broadcasts_status_idx` ON `broadcasts` (`status`);--> statement-breakpoint
CREATE INDEX `broadcasts_completed_at_idx` ON `broadcasts` (`completed_at`);--> statement-breakpoint
CREATE TABLE `broadcast_recipients` (
	`broadcast_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `broadcast_recipients_status_check` CHECK (`status` in ('pending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `broadcast_recipients_pk` ON `broadcast_recipients` (`broadcast_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `broadcast_recipients_pending_idx` ON `broadcast_recipients` (`broadcast_id`,`status`) WHERE `status` = 'pending';
