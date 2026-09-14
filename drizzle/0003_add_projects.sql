CREATE TABLE IF NOT EXISTS `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '',
	`systemInstructions` text DEFAULT '',
	`defaultSources` text DEFAULT '["web"]',
	`files` text DEFAULT '[]',
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `chats` ADD COLUMN `projectId` text;
