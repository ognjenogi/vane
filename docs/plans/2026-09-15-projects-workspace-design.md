# Design Document: Projects Workspace & Knowledge Base in Vane

> **Date:** September 15, 2026  
> **Status:** Approved  
> **Target:** Vane (`ognjenogi/vane`)

---

## 1. Executive Summary

This feature introduces **Projects** (workspaces) to Vane, transforming it from a single-thread search tool into an extensible research workspace akin to Perplexity Spaces or Claude Projects.

A **Project** encapsulates:
1. **Dedicated System Persona / Instructions:** Custom behavior, tone, or domain specialization (e.g., "Senior Quant Researcher").
2. **Shared Knowledge Base:** Uploaded documents (PDFs, Markdown, TXT, code files) chunked and vector-indexed via `Xenova/all-MiniLM-L6-v2`.
3. **Grouped Conversations:** All chats initiated within the project share access to its knowledge base and instructions.
4. **Hybrid Smart Retrieval:** Automatic routing that queries project documents first and selectively retrieves external web data when needed.

---

## 2. Architecture & Data Model

### 2.1 Database Schema (`src/lib/db/schema.ts`)

```typescript
import { sql } from 'drizzle-orm';
import { text, integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { Block } from '../types';
import { SearchSources } from '../agents/search/types';

export interface DBFile {
  name: string;
  fileId: string;
}

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').default(''),
  systemInstructions: text('systemInstructions').default(''),
  defaultSources: text('defaultSources', { mode: 'json' })
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
  sources: text('sources', { mode: 'json' })
    .$type<SearchSources[]>()
    .default(sql`'[]'`),
  files: text('files', { mode: 'json' })
    .$type<DBFile[]>()
    .default(sql`'[]'`),
  projectId: text('projectId'), // null for regular standalone chats, or project UUID
});

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
  status: text({ enum: ['answering', 'completed', 'error'] }).default('answering'),
});
```

### 2.2 Storage & RAG Lifecycle
1. Documents are parsed and stored using `UploadManager` (`src/lib/uploads/manager.ts`).
2. Text is chunked (500 tokens, 50 overlap) and embedded via `MiniLM`.
3. Chunks are stored with file metadata linking them to the project.
4. **Cascade Deletion:**
   * Deleting a project cascades to delete all child `chats` and `messages`.
   * All associated vector chunks and physical files are purged via `UploadManager.deleteFile(fileId)`.

---

## 3. API Endpoints

### 3.1 Project Management
* `GET /api/projects`: List all projects with metadata and counts.
* `POST /api/projects`: Create project (`name`, `description`, `systemInstructions`, `defaultSources`).
* `GET /api/projects/[id]`: Retrieve project details, files, and conversation history.
* `PATCH /api/projects/[id]`: Update project metadata or instructions.
* `DELETE /api/projects/[id]`: Cascade delete project, chats, and files.

### 3.2 File Attachment
* `POST /api/projects/[id]/files`: Upload, chunk, and index documents directly into the project's vector store.
* `DELETE /api/projects/[id]/files/[fileId]`: Remove file and delete its embeddings.

### 3.3 Chat Execution Pipeline Integration (`POST /api/chat`)
* If `chatId` is linked to a `projectId`, `searchAsync` automatically:
  1. Combines `project.files` with message-level files into `config.fileIds`.
  2. Prepends `project.systemInstructions` into writer prompt context.
  3. Activates `uploads_search` action in the research loop.
  4. Implements **Hybrid Smart Routing**:
     - Evaluates project documents first.
     - Automatically calls `webSearch` if project context is insufficient or if live web data is needed.

---

## 4. UI Components & Pages

1. **Sidebar Navigation (`src/components/Sidebar.tsx`):**
   * Projects list section with active indicator.
   * "+ New Project" button opening creation modal.
2. **Project Workspace (`src/app/project/[id]/page.tsx`):**
   * Editable header (name & description).
   * Knowledge Base card: file list, upload dropzone, indexing status, delete buttons.
   * Custom Instructions card: prompt editor with auto-save.
   * Conversations card: list of project chats + "New Chat in Project" button.
3. **Chat Page (`src/app/c/[chatId]/page.tsx`):**
   * Scoped project header badge with 1-click return to project workspace.
   * Status indicators for attached project documents.

---

## 5. Defensive Edge Case Matrix

| Edge Case | Failure Mode | Defensive Mitigation |
|---|---|---|
| **0 Project Files** | Infinite loop or vector crash | `uploads_search` is disabled if `fileIds.length === 0`; routes directly to web. |
| **Context Overflow** | Exceeding LLM token window | Top-6 most similar chunks returned; capped at 3,500 characters per chunk. |
| **Corrupted PDF** | Fatal server crash | Wrapped in `try/catch`; rejects with clear UI alert. |
| **Concurrent File Deletion** | Missing chunk lookup error | `UploadStore` logs warning and skips missing files gracefully. |
| **Orphaned Chat Tab** | Chat submitted after project deletion | `searchAsync` catches missing `projectId` and executes as standalone chat. |
| **Instruction Priority** | Conflicting system prompts | Strict hierarchy: Grounding Rules > Project Persona > User message prompt. |
| **Non-Destructive DB Migration** | Existing chats corrupted | Migration uses `ALTER TABLE chats ADD COLUMN projectId TEXT DEFAULT NULL`. |
| **Partial Search Failure** | Web fails but doc succeeds | Independent error boundaries ensure doc context still generates valid answer. |
