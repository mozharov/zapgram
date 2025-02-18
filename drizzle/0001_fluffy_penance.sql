PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`key` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_conversations`("key", "version", "state") SELECT "key", '[0,0]', "state" FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;