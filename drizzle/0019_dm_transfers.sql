CREATE TABLE `dm_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`from_user_id` integer NOT NULL,
	`to_user_id` integer NOT NULL,
	`sats` integer NOT NULL,
	`status` text NOT NULL,
	`invoice_hash` text,
	`bolt11` text,
	`fee_hash` text,
	`fee_bolt11` text,
	`notice_sent` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `dm_transfers_status_check` CHECK(`status` in ('pending', 'settled'))
);
