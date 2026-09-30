CREATE TABLE IF NOT EXISTS `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`chatId` text NOT NULL,
	`intervalMinutes` integer NOT NULL,
	`endType` text NOT NULL DEFAULT 'never',
	`maxRuns` integer,
	`runUntil` text,
	`status` text NOT NULL DEFAULT 'active',
	`runCount` integer NOT NULL DEFAULT 0,
	`lastRunAt` text,
	`nextRunAt` text,
	`lastError` text,
	`optimizationMode` text NOT NULL DEFAULT 'balanced',
	`sources` text DEFAULT '["web"]',
	`chatModel` text DEFAULT 'null',
	`embeddingModel` text DEFAULT 'null',
	`projectId` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_jobs_next_run` ON `scheduled_jobs` (`status`,`nextRunAt`);
