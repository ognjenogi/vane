# Projects Workspace & Knowledge Base Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** Build a full-fledged "Projects" workspace feature in Vane (Perplexity Spaces / Claude Projects style) with dedicated system instructions, a shared document knowledge base, scoped conversation grouping, hybrid smart search retrieval, and complete cascade lifecycle management.

**Architecture:** Add a relational `projects` table and link it to `chats` via Drizzle ORM in SQLite. Re-use Vane's native `UploadManager` and `UploadStore` for document chunking and vector embeddings with `MiniLM`. Inject project instructions and file IDs dynamically into `POST /api/chat` and `agent.searchAsync`, prioritizing document RAG search over live web search. Build a modern Next.js UI with a sidebar section, project dashboard, and in-chat project context indicators.

**Tech Stack:** Next.js 16 (App Router), TypeScript, SQLite (via `better-sqlite3` & `drizzle-orm`), Tailwind CSS, Lucide Icons, `Xenova/all-MiniLM-L6-v2` embeddings, SearXNG.

---

## User Review Required

> [!IMPORTANT]
> **Non-Destructive Database Migration:**  
> The SQLite database on your live VPS contains your existing chat messages. The migration cleanly runs:
> ```sql
> ALTER TABLE chats ADD COLUMN projectId TEXT DEFAULT NULL;
> CREATE TABLE projects (...);
> ```
> All existing chats will remain safe with `projectId = NULL` (standalone mode).

> [!NOTE]
> **Upstream Compatibility:**  
> All changes are additive. The core search pipeline interfaces remain untouched, so future upstream merges from `ItzCrazyKns/Vane` will continue to merge cleanly with zero schema conflicts.

---

## Proposed Changes & Tasks

### Phase 1: Database Schema & Migration

#### [MODIFY] [schema.ts](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/lib/db/schema.ts)
- Add `projects` table definition:
  - `id: text('id').primaryKey()`
  - `name: text('name').notNull()`
  - `description: text('description').default('')`
  - `systemInstructions: text('systemInstructions').default('')`
  - `defaultSources: text('defaultSources', { mode: 'json' }).$type<SearchSources[]>().default(sql`'["web"]'`)`
  - `files: text('files', { mode: 'json' }).$type<DBFile[]>().default(sql`'[]'`)`
  - `createdAt: text('createdAt').notNull()`
  - `updatedAt: text('updatedAt').notNull()`
- Update `chats` table:
  - Add `projectId: text('projectId')` column.

#### [NEW] [0003_add_projects.sql](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/drizzle/0003_add_projects.sql)
- SQL migration script for creating `projects` table and adding `projectId` column to `chats`.

---

### Phase 2: Backend API Endpoints & Project Controllers

#### [NEW] [src/lib/projects/manager.ts](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/lib/projects/manager.ts)
- Service layer handling business logic:
  - `createProject(data)`
  - `getProject(id)`
  - `listProjects()`
  - `updateProject(id, data)`
  - `deleteProject(id)` (with cascade deletion of chats, messages, and vector chunks)
  - `addProjectFile(projectId, file)`
  - `removeProjectFile(projectId, fileId)`

#### [NEW] [src/app/api/projects/route.ts](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/app/api/projects/route.ts)
- `GET`: Return all projects with file and chat counts.
- `POST`: Create project with schema validation (`zod`).

#### [NEW] [src/app/api/projects/[id]/route.ts](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/app/api/projects/[id]/route.ts)
- `GET`: Return project details, attached files, and list of chats.
- `PATCH`: Update project name, description, and custom instructions.
- `DELETE`: Execute cascade deletion.

#### [NEW] [src/app/api/projects/[id]/files/route.ts](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/app/api/projects/[id]/files/route.ts)
- `POST`: Handle document upload, trigger `UploadManager` chunking and embedding, append `DBFile` to `projects.files`.
- `DELETE`: Remove file from project and purge embeddings from disk.

---

### Phase 3: Search Pipeline & Hybrid RAG Routing

#### [MODIFY] [src/app/api/chat/route.ts](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/app/api/chat/route.ts)
- Accept optional `projectId` in request body.
- When `projectId` is present (or retrieved from `chatId`):
  - Load project instructions and prepend to `config.systemInstructions`.
  - Merge project file IDs into `config.fileIds`.
  - Save `projectId` when creating new chat records in SQLite.

#### [MODIFY] [src/lib/agents/search/researcher/actions/uploadsSearch.ts](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/lib/agents/search/researcher/actions/uploadsSearch.ts)
- Ensure robust handling when searching project files:
  - Return top-6 chunks with maximum 3,500 characters each to prevent context overflow.
  - Gracefully handle deleted files without throwing exceptions.

---

### Phase 4: Frontend UI Components

#### [MODIFY] [src/components/Sidebar.tsx](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/components/Sidebar.tsx)
- Add "Projects" section in sidebar with a "+ New Project" button.
- List active projects with folder icon and link to `/project/[id]`.

#### [NEW] [src/components/NewProjectModal.tsx](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/components/NewProjectModal.tsx)
- Modal dialog to create a new project with Name, Description, and initial System Instructions.

#### [NEW] [src/app/project/[id]/page.tsx](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/app/project/[id]/page.tsx)
- Project Workspace screen:
  - Header with editable project title & description.
  - **Knowledge Base card:** Document drag-and-drop uploader, list of attached files with delete button, file size, and chunk status.
  - **Custom Instructions card:** Textarea to customize the AI's persona and focus for this project.
  - **Conversations card:** Searchable list of all chats inside this project + prominent "Start New Chat" hero button.

#### [MODIFY] [src/app/c/[chatId]/page.tsx](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/app/c/[chatId]/page.tsx) & [MessageBox.tsx](file:///Users/ognjennikolic/Documents/ai/vps%20projects/vane-fix/src/components/MessageBox.tsx)
- Show a project badge in the chat header (`📁 Project: [Name]`) linking back to the project workspace.
- Show active project files in the source panel.

---

## Verification Plan

### Automated & Unit Tests
1. **Schema & Migration Test:** Verify Drizzle migration applies cleanly on an existing database copy.
2. **Project API CRUD Tests:** Test `POST /api/projects`, `GET /api/projects`, `PATCH /api/projects/[id]`, `DELETE /api/projects/[id]`.
3. **Cascade Deletion Test:** Verify deleting a project deletes all associated chats, messages, and vector embeddings without leaving orphaned rows.
4. **Edge Case Tests:**
   * Query in project with 0 files (verifies agent falls back cleanly to web search without hanging).
   * Query in project with attached PDF (verifies `uploads_search` retrieves exact document quotes).
   * Delete file while querying (verifies graceful fallback).

### Live Verification on VPS
1. Apply migration on live `vane-data/db.sqlite` on VPS.
2. Rebuild and restart `vane:optimized`.
3. Create test project *"Quant Research"*, attach a test document, and set custom prompt *"You are a Senior Quantitative Analyst"*.
4. Test Query 1: Document-specific query &rarr; Verify answer cites project document.
5. Test Query 2: Current event query &rarr; Verify hybrid search calls web search.
6. Verify UI responsiveness and sidebar project navigation.
