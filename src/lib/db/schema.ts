import { sql } from 'drizzle-orm';
import { text, integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { Block } from '../types';
import { SearchSources } from '../agents/search/types';

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey(),
  messageId: text('messageId').notNull(),
  chatId: text('chatId').notNull(),
  backendId: text('backendId').notNull(),
  query: text('query').notNull(),
  createdAt: text('createdAt').notNull(),
  responseBlocks: text('responseBlocks', { mode: 'json' })
    .$type<Block[]>()
    .default(sql`'[]'`),
  status: text({ enum: ['answering', 'completed', 'error'] }).default(
    'answering',
  ),
});

export interface DBFile {
  name: string;
  fileId: string;
}

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').default(''),
  systemInstructions: text('systemInstructions').default(''),
  defaultSources: text('defaultSources', {
    mode: 'json',
  })
    .$type<SearchSources[]>()
    .default(sql`'["web"]'`),
  files: text('files', { mode: 'json' })
    .$type<DBFile[]>()
    .default(sql`'[]'`),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: text('createdAt').notNull(),
  sources: text('sources', {
    mode: 'json',
  })
    .$type<SearchSources[]>()
    .default(sql`'[]'`),
  files: text('files', { mode: 'json' })
    .$type<DBFile[]>()
    .default(sql`'[]'`),
  projectId: text('projectId'),
});

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  chatId: text('chatId').notNull(),
  intervalMinutes: integer('intervalMinutes').notNull(),
  endType: text({ enum: ['never', 'count', 'date'] })
    .notNull()
    .default('never'),
  maxRuns: integer('maxRuns'),
  runUntil: text('runUntil'),
  status: text({ enum: ['active', 'paused', 'completed'] })
    .notNull()
    .default('active'),
  runCount: integer('runCount').notNull().default(0),
  lastRunAt: text('lastRunAt'),
  nextRunAt: text('nextRunAt'),
  lastError: text('lastError'),
  optimizationMode: text('optimizationMode').notNull().default('balanced'),
  sources: text('sources', {
    mode: 'json',
  })
    .$type<SearchSources[]>()
    .default(sql`'["web"]'`),
  chatModel: text('chatModel', { mode: 'json' })
    .$type<{ providerId: string; key: string } | null>()
    .default(sql`'null'`),
  embeddingModel: text('embeddingModel', { mode: 'json' })
    .$type<{ providerId: string; key: string } | null>()
    .default(sql`'null'`),
  projectId: text('projectId'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});
