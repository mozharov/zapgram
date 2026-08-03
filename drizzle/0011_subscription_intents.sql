CREATE TABLE `__migration_0011_duplicate_subscriptions` (`singleton` integer PRIMARY KEY);
--> statement-breakpoint
INSERT INTO `__migration_0011_duplicate_subscriptions` VALUES (1);
--> statement-breakpoint
INSERT INTO `__migration_0011_duplicate_subscriptions`
	SELECT 1 WHERE EXISTS (
		SELECT 1 FROM `subscriptions` GROUP BY `user_id`, `chat_id` HAVING count(*) > 1
	);
--> statement-breakpoint
DROP TABLE `__migration_0011_duplicate_subscriptions`;
--> statement-breakpoint
CREATE TABLE `__migration_0011_duplicate_payment_requests` (`singleton` integer PRIMARY KEY);
--> statement-breakpoint
INSERT INTO `__migration_0011_duplicate_payment_requests` VALUES (1);
--> statement-breakpoint
INSERT INTO `__migration_0011_duplicate_payment_requests`
	SELECT 1 WHERE EXISTS (
		SELECT 1 FROM `subscription_payments` GROUP BY `payment_request` HAVING count(*) > 1
	);
--> statement-breakpoint
DROP TABLE `__migration_0011_duplicate_payment_requests`;
--> statement-breakpoint
CREATE TABLE `__migration_0011_duplicate_payment_hashes` (`singleton` integer PRIMARY KEY);
--> statement-breakpoint
INSERT INTO `__migration_0011_duplicate_payment_hashes` VALUES (1);
--> statement-breakpoint
INSERT INTO `__migration_0011_duplicate_payment_hashes`
	SELECT 1 WHERE EXISTS (
		SELECT 1 FROM `subscription_payments` GROUP BY `payment_hash` HAVING count(*) > 1
	);
--> statement-breakpoint
DROP TABLE `__migration_0011_duplicate_payment_hashes`;
--> statement-breakpoint
CREATE TABLE `subscription_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`winner_attempt_id` text,
	`attempt_reservation_id` text,
	`attempt_reservation_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `subscription_intents_status_check` CHECK (`status` in ('legacy', 'open', 'won', 'completed')),
	CONSTRAINT `subscription_intents_winner_check` CHECK (
		(`status` in ('legacy', 'open') and `winner_attempt_id` is null)
		or (`status` in ('won', 'completed') and `winner_attempt_id` is not null)
	),
	CONSTRAINT `subscription_intents_reservation_check` CHECK (
		(`attempt_reservation_id` is null and `attempt_reservation_expires_at` is null)
		or (`status` = 'open' and `attempt_reservation_id` is not null
			and `attempt_reservation_expires_at` is not null)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_intents_active_user_chat_kind_unique`
	ON `subscription_intents` (`user_id`, `chat_id`, `kind`)
	WHERE `status` in ('open', 'won');
--> statement-breakpoint
INSERT INTO `subscription_intents` (
	`id`,
	`user_id`,
	`chat_id`,
	`kind`,
	`status`,
	`winner_attempt_id`,
	`created_at`,
	`updated_at`
) SELECT
	`id`,
	`user_id`,
	`chat_id`,
	`kind`,
	'legacy',
	NULL,
	`created_at`,
	`created_at`
FROM `subscription_payments`;
--> statement-breakpoint
CREATE TABLE `__new_subscription_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`payment_request` text NOT NULL,
	`payment_hash` text NOT NULL,
	`price` integer NOT NULL,
	`subscription_type` text NOT NULL,
	`kind` text DEFAULT 'join' NOT NULL,
	`expires_at` integer,
	`is_current` integer DEFAULT true NOT NULL,
	`attempt_status` text DEFAULT 'pending' NOT NULL,
	`processed_at` integer,
	`settled_at` integer,
	`settle_attempts` integer DEFAULT 0 NOT NULL,
	`payout_hash` text,
	`fee_payout_hash` text,
	`refund_payout_hash` text,
	`refunded_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`intent_id`) REFERENCES `subscription_intents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `subscription_payments_status_check` CHECK (`attempt_status` in ('pending', 'processed', 'expired')),
	CONSTRAINT `subscription_payments_processed_check` CHECK (`attempt_status` = 'pending' or `processed_at` is not null),
	CONSTRAINT `subscription_payments_refund_check` CHECK (
		`refunded_at` is null or (`refund_payout_hash` is not null and `processed_at` is not null)
	)
);
--> statement-breakpoint
INSERT INTO `__new_subscription_payments` (
	`id`,
	`intent_id`,
	`user_id`,
	`chat_id`,
	`payment_request`,
	`payment_hash`,
	`price`,
	`subscription_type`,
	`kind`,
	`expires_at`,
	`is_current`,
	`attempt_status`,
	`processed_at`,
	`settled_at`,
	`settle_attempts`,
	`payout_hash`,
	`fee_payout_hash`,
	`refund_payout_hash`,
	`refunded_at`,
	`created_at`
) SELECT
	`id`,
	`id`,
	`user_id`,
	`chat_id`,
	`payment_request`,
	`payment_hash`,
	`price`,
	`subscription_type`,
	`kind`,
	NULL,
	true,
	'pending',
	NULL,
	`settled_at`,
	`settle_attempts`,
	`payout_hash`,
	`fee_payout_hash`,
	NULL,
	NULL,
	`created_at`
FROM `subscription_payments`;
--> statement-breakpoint
DROP TABLE `subscription_payments`;
--> statement-breakpoint
ALTER TABLE `__new_subscription_payments` RENAME TO `subscription_payments`;
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_payments_payment_request_unique`
	ON `subscription_payments` (`payment_request`);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_payments_payment_hash_unique`
	ON `subscription_payments` (`payment_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_payments_current_intent_unique`
	ON `subscription_payments` (`intent_id`)
	WHERE `is_current` = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_chat_unique`
	ON `subscriptions` (`user_id`, `chat_id`);
