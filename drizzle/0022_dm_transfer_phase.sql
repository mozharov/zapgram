ALTER TABLE `dm_transfers` ADD `phase` text DEFAULT 'reserved' NOT NULL;
--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `rail` text DEFAULT 'internal' NOT NULL;
--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `provider_accepted` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `provider_payment_hash` text;
--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `fee_skipped` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `notice_claim_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `review_logged` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `dm_transfers` SET `phase` = 'settled' WHERE `status` = 'settled';
--> statement-breakpoint
UPDATE `dm_transfers` SET `phase` = 'invoice_saved' WHERE `status` = 'pending' AND `invoice_hash` IS NOT NULL;
