import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  betterSqliteMockFactory,
  closeTrackedDatabases,
} from '@/test/dbTracking';

/**
 * The route reaches the real `@/lib/db` singleton, and that singleton opens
 * `<DATA_DIR>/data/db.sqlite` at import time — so this file runs against a
 * throwaway database: a temp `DATA_DIR` with the real `drizzle/*.sql` files
 * copied in, migrations applied, and the route imported dynamically afterwards
 * so the singleton resolves the temp path rather than the developer's own data
 * dir (the convention `src/lib/db/__tests__/migrate.test.ts` sets).
 *
 * `@/lib/db` and `@/lib/db/migrate` both leave a native handle open, and every
 * statement must stay reachable or the worker's teardown aborts the whole file;
 * see src/test/dbTracking.ts.
 */
vi.mock('better-sqlite3', () =>
  import('@/test/dbTracking').then((m) => m.betterSqliteMockFactory()),
);

type ChatRoute = typeof import('@/app/api/chats/[id]/route');

const REPO_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

const NOW = new Date('2026-01-01T00:00:00.000Z');
const NEXT_HOUR = new Date(NOW.getTime() + 60 * 60_000).toISOString();

describe('DELETE /api/chats/[id]', () => {
  let tmpDir: string;
  let inspector: Database.Database;
  let route: ChatRoute;
  const originalDataDir = process.env.DATA_DIR;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-chat-api-'));
    fs.mkdirSync(path.join(tmpDir, 'drizzle'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });

    for (const file of fs.readdirSync(REPO_MIGRATIONS_DIR)) {
      if (file.endsWith('.sql')) {
        fs.copyFileSync(
          path.join(REPO_MIGRATIONS_DIR, file),
          path.join(tmpDir, 'drizzle', file),
        );
      }
    }

    process.env.DATA_DIR = tmpDir;
    // migrate.ts and `@/lib/db` both resolve DATA_DIR at import time, so the
    // registry has to be dropped before either is imported.
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('@/lib/db/migrate');

    route = await import('@/app/api/chats/[id]/route');

    // A second handle so a test can assert on the rows the route wrote rather
    // than only on what it echoes back.
    inspector = new Database(path.join(tmpDir, 'data', 'db.sqlite'));
  });

  afterAll(() => {
    vi.restoreAllMocks();
    closeTrackedDatabases();
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    inspector.exec(
      'DELETE FROM scheduled_jobs; DELETE FROM messages; DELETE FROM chats;',
    );
  });

  const del = (id: string) =>
    route.DELETE(new Request(`http://localhost/api/chats/${id}`), {
      params: Promise.resolve({ id }),
    });

  const chatRow = (id: string) =>
    inspector.prepare('SELECT * FROM chats WHERE id = ?').get(id) as
      | Record<string, any>
      | undefined;
  const jobRow = (id: string) =>
    inspector.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as
      | Record<string, any>
      | undefined;
  const messageCount = (chatId: string) =>
    (
      inspector
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE chatId = ?')
        .get(chatId) as { n: number }
    ).n;
  const jobCount = () =>
    (
      inspector.prepare('SELECT COUNT(*) AS n FROM scheduled_jobs').get() as {
        n: number;
      }
    ).n;

  /** Inserts a chat row by hand, the shape `createJob` and the UI both produce. */
  const insertChat = (id: string) => {
    inspector
      .prepare(
        `INSERT INTO chats (id, title, createdAt, sources, files, projectId)
         VALUES (?, ?, ?, '[]', '[]', NULL)`,
      )
      .run(id, `Chat ${id}`, NOW.toISOString());
  };

  /** Inserts a scheduled job pointed at `chatId`, the row the ticker reads. */
  const insertJob = (
    id: string,
    chatId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    inspector
      .prepare(
        `INSERT INTO scheduled_jobs
           (id, title, prompt, chatId, intervalMinutes, endType, status,
            runCount, nextRunAt, optimizationMode, sources, chatModel,
            embeddingModel, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 60, 'never', 'active', 0, ?, 'balanced', '["web"]',
                 'null', 'null', ?, ?)`,
      )
      .run(
        id,
        `Job ${id}`,
        'Summarize what changed today',
        chatId,
        NEXT_HOUR,
        NOW.toISOString(),
        NOW.toISOString(),
      );

    const keys = Object.keys(overrides);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${key} = ?`).join(', ');
      inspector
        .prepare(`UPDATE scheduled_jobs SET ${assignments} WHERE id = ?`)
        .run(...keys.map((key) => overrides[key]), id);
    }
  };

  /**
   * A job writing into this chat on a timer keeps buying a full paid research
   * turn for as long as it is active, and there are no foreign keys and no other
   * thing that stops it once the chat row is gone. Deleting the chat has to
   * leave the job paused.
   */
  it('pauses the scheduled job that writes into the deleted chat', async () => {
    insertChat('chat-1');
    insertJob('job-1', 'chat-1');

    const response = await del('chat-1');

    expect(response.status).toBe(200);
    expect((await response.json()).message).toBe('Chat deleted successfully');

    const row = jobRow('job-1')!;
    expect(row.status).toBe('paused');
    // Recoverable: the schedule is untouched, so resuming still works and the
    // user keeps the job they configured.
    expect(row.nextRunAt).toBe(NEXT_HOUR);
    expect(row.runCount).toBe(0);
    // The job row itself survives — only the chat is deleted.
    expect(row.id).toBe('job-1');
    expect(chatRow('chat-1')).toBeUndefined();
  });

  it('leaves jobs of other chats alone', async () => {
    insertChat('chat-1');
    insertChat('chat-2');
    insertJob('job-1', 'chat-1');
    insertJob('job-2', 'chat-2');

    expect((await del('chat-1')).status).toBe(200);

    // Unrelated schedule keeps running exactly as before.
    expect(jobRow('job-2')!.status).toBe('active');
    expect(jobRow('job-2')!.nextRunAt).toBe(NEXT_HOUR);
    expect(chatRow('chat-2')).toBeDefined();
    expect(jobCount()).toBe(2);
  });

  it('leaves a job that has already completed completed', async () => {
    // `completed` is terminal. Rewriting it to `paused` would put a "Resume"
    // button on the scheduled page for a schedule that is already over.
    insertChat('chat-1');
    insertJob('job-1', 'chat-1');
    insertJob('job-2', 'chat-1', { status: 'completed' });

    expect((await del('chat-1')).status).toBe(200);

    expect(jobRow('job-1')!.status).toBe('paused');
    expect(jobRow('job-2')!.status).toBe('completed');
  });

  it('pauses every job pointed at the deleted chat', async () => {
    insertChat('chat-1');
    insertJob('job-1', 'chat-1');
    insertJob('job-2', 'chat-1', { status: 'paused' });

    expect((await del('chat-1')).status).toBe(200);

    expect(jobRow('job-1')!.status).toBe('paused');
    // A job that was already paused keeps its own slot rather than being
    // rescheduled by this write.
    expect(jobRow('job-2')!.status).toBe('paused');
    expect(jobCount()).toBe(2);
  });

  it('still deletes the chat and its messages, and is unaffected by having no jobs', async () => {
    insertChat('chat-1');
    insertChat('chat-2');
    inspector
      .prepare(
        `INSERT INTO messages (messageId, chatId, backendId, query, createdAt, responseBlocks, status)
         VALUES (?, ?, ?, ?, ?, '[]', 'completed')`,
      )
      .run(
        'msg-1',
        'chat-1',
        'msg-1-backend',
        'what changed?',
        NOW.toISOString(),
      );

    expect(messageCount('chat-1')).toBe(1);
    expect(jobCount()).toBe(0);

    const response = await del('chat-1');

    expect(response.status).toBe(200);
    expect(chatRow('chat-1')).toBeUndefined();
    expect(messageCount('chat-1')).toBe(0);
    // The other chat and its messages are untouched.
    expect(chatRow('chat-2')).toBeDefined();
    expect(messageCount('chat-2')).toBe(0);
  });

  it('answers 404 for an unknown chat and pauses nothing', async () => {
    insertChat('chat-1');
    insertJob('job-1', 'chat-1');

    const response = await del('nope');

    expect(response.status).toBe(404);
    expect((await response.json()).message).toBe('Chat not found');
    // The guard runs before anything is written, so a miss costs nothing.
    expect(jobRow('job-1')!.status).toBe('active');
    expect(chatRow('chat-1')).toBeDefined();
  });
});
