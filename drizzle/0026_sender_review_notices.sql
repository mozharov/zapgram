ALTER TABLE `dm_transfers` ADD `review_notified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `dm_transfers` ADD `review_after` integer;--> statement-breakpoint
ALTER TABLE `lnurl_pay_attempts` ADD `review_notified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `lnurl_pay_attempts` ADD `review_after` integer;