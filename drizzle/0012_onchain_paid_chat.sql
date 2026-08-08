ALTER TABLE `chats` ADD `onchain_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `onchain_masterpub` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `watchonly_wallet_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `onchain_fingerprint` text;--> statement-breakpoint
CREATE TABLE `onchain_chat_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`satspay_charge_id` text NOT NULL,
	`address` text NOT NULL,
	`amount_sats` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`watch_until` integer NOT NULL,
	`paid_at` integer,
	`txid` text,
	`telegram_chat_id` integer,
	`telegram_message_id` integer,
	`subscription_payment_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_payment_id`) REFERENCES `subscription_payments`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `onchain_chat_payments_status_check` CHECK (`status` in ('pending', 'grace', 'paid', 'expired', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onchain_chat_payments_satspay_charge_id_unique` ON `onchain_chat_payments` (`satspay_charge_id`);--> statement-breakpoint
CREATE INDEX `onchain_chat_payments_open_idx` ON `onchain_chat_payments` (`status`, `watch_until`);--> statement-breakpoint
CREATE INDEX `onchain_chat_payments_user_chat_idx` ON `onchain_chat_payments` (`user_id`, `chat_id`);
