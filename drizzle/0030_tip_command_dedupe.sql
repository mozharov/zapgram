CREATE TABLE `tip_commands` (
	`chat_id` integer NOT NULL,
	`from_user_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`date` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tip_commands_command_unique` ON `tip_commands` (`chat_id`,`from_user_id`,`message_id`,`date`);