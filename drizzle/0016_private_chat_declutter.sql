ALTER TABLE `users` ADD `last_menu_message_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `last_notification_message_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `last_notification_base_markup` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `source_reply_markup` text;
