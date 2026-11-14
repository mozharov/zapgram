CREATE TABLE `lnurl_pay_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`from_user_id` integer NOT NULL,
	`recipient` text NOT NULL,
	`sats` integer NOT NULL,
	`status` text NOT NULL,
	`phase` text DEFAULT 'reserved' NOT NULL,
	`rail` text DEFAULT 'internal' NOT NULL,
	`invoice_hash` text,
	`bolt11` text,
	`provider_accepted` integer DEFAULT false NOT NULL,
	`provider_payment_hash` text,
	`review_logged` integer DEFAULT false NOT NULL,
	`sender_notified` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lnurl_pay_attempts_status_check" CHECK("lnurl_pay_attempts"."status" in ('pending', 'settled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lnurl_pay_attempts_one_open` ON `lnurl_pay_attempts` (`from_user_id`,`recipient`) WHERE "lnurl_pay_attempts"."status" = 'pending' AND "lnurl_pay_attempts"."phase" in ('pay_unknown', 'provider_accepted', 'needs_review');--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `notice_dropped` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `notice_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `sender_notified` integer DEFAULT false NOT NULL;