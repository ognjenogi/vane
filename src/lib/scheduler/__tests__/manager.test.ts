import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as schema from '@/lib/db/schema';
import SchedulerManager from '@/lib/scheduler/manager';
import {
  computeNextRunAt,
  createJobSchema,
  isJobDue,
  type CreateJobInput,
} from '@/lib/scheduler/types';
import {
  betterSqliteMockFactory,
  closeTrackedDatabases,
} from '@/test/dbTracking';

/**
 * `@/lib/db` opens `<DATA_DIR>/data/db.sqlite` at import time, which would
 * touch the developer's real database just by running the unit tests (the
 * convention `src/lib/db/__tests__/migrate.test.ts` sets is to never do that).
 * Every test here injects its own in-memory handle, so the singleton is stubbed
 * out and never used.
 */
vi.mock('@/lib/db', () => ({ default: { __unusedSingleton: true } }));

/**
 * This file prepares hundreds of statements against the in-memory handle, and
 * a `Statement` wrapper left as garbage makes its native finalizer run against
 * a dead environment and abort the worker. The helper keeps every wrapper
 * reachable and closes the handle it owns; see src/test/dbTracking.ts.
 */
vi.mock('better-sqlite3', () =>
  import('@/test/dbTracking').then((m) => m.betterSqliteMockFactory()),
);

const MIGRATION = path.join(
  process.cwd(),
  'drizzle',
  '0004_add_scheduled_jobs.sql',
);

/**
 * Minimal `chats` table, matching the columns `createJob` inserts (the real
 * shape lives in `drizzle/0000_fuzzy_randall.sql` + the 0003 `ALTER TABLE`).
 */
const CHATS_DDL = `
  CREATE TABLE chats (
    id text PRIMARY KEY NOT NULL,
    title text NOT NULL,
    createdAt text NOT NULL,
    sources text DEFAULT '[]',
    files text DEFAULT '[]',
    projectId text
  );
`;

/** Frozen clock: every timestamp assertion is exact, never "about now". */
const T0 = new Date('2026-01-01T00:00:00.000Z');

const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const parse = (raw: Record<string, unknown>): CreateJobInput =>
  createJobSchema.parse(raw);

/** The shape every test starts from; only the interesting field varies. */
const minimal = (overrides: Record<string, unknown> = {}) => ({
  prompt: 'Summarize what changed today',
  intervalMinutes: 60,
  endType: 'never',
  ...overrides,
});

/** The declared `updateJob` patch type, read off the method itself. */
type JobPatch = Parameters<SchedulerManager['updateJob']>[1];

/**
 * `runUntil: null` is outside the declared patch type (the schema rejects it),
 * but a JSON request body can still carry it, and clearing the end date has to
 * clear it rather than store the epoch.
 */
const CLEAR_RUN_UNTIL = { runUntil: null } as unknown as JobPatch;

describe('SchedulerManager', () => {
  let sqlite: Database.Database;
  let manager: SchedulerManager;

  beforeAll(() => {
    sqlite = new Database(':memory:');
    // The real migration, so the test tracks the shipped schema.
    sqlite.exec(fs.readFileSync(MIGRATION, 'utf8'));
    sqlite.exec(CHATS_DDL);

    manager = new SchedulerManager(drizzle(sqlite, { schema }));
  });

  afterAll(() => {
    closeTrackedDatabases();
  });

  beforeEach(() => {
    // Only `Date` is faked: the drizzle driver is synchronous, so faking the
    // timer functions would buy nothing and could starve awaited promises.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);

    // Every test starts from an empty database, so the two tables are all this
    // file has to reset.
    sqlite.exec('DELETE FROM scheduled_jobs; DELETE FROM chats;');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const jobRow = (id: string) =>
    sqlite.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as
      | Record<string, any>
      | undefined;
  const chatRow = (id: string) =>
    sqlite.prepare('SELECT * FROM chats WHERE id = ?').get(id) as
      | Record<string, any>
      | undefined;
  const count = (table: 'scheduled_jobs' | 'chats') =>
    (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;

  describe('createJob', () => {
    it('stores an active job, schedules the first run and creates the chat', async () => {
      const job = await manager.createJob(parse(minimal()));

      expect(job.id).toMatch(/^[0-9a-f]{40}$/);
      expect(job.chatId).toMatch(/^[0-9a-f]{40}$/);
      expect(job.status).toBe('active');
      expect(job.runCount).toBe(0);
      expect(job.nextRunAt).toBe(computeNextRunAt(T0, 60));
      expect(job.createdAt).toBe(T0.toISOString());
      expect(job.updatedAt).toBe(T0.toISOString());
      expect(job.lastRunAt).toBeNull();
      expect(job.lastError).toBeNull();
      expect(job.maxRuns).toBeNull();
      expect(job.runUntil).toBeNull();
      expect(job.projectId).toBeNull();
      expect(job.chatModel).toBeNull();
      expect(job.embeddingModel).toBeNull();

      const row = jobRow(job.id)!;
      expect(row.nextRunAt).toBe(computeNextRunAt(T0, 60));
      expect(row.runCount).toBe(0);
      expect(row.lastRunAt).toBeNull();
      expect(row.chatId).toBe(job.chatId);
      expect(row.endType).toBe('never');

      const chat = chatRow(job.chatId)!;
      expect(chat.title).toBe('Summarize what changed today');
      expect(chat.createdAt).toBe(T0.toISOString());
      expect(JSON.parse(chat.sources)).toEqual(['web']);
      expect(JSON.parse(chat.files)).toEqual([]);
      expect(chat.projectId).toBeNull();
    });

    it('trims an explicit title, otherwise falls back to the first 64 prompt characters', async () => {
      const longPrompt = 'x'.repeat(100);

      const named = await manager.createJob(
        parse(minimal({ title: '  Weekly digest  ' })),
      );
      expect(named.title).toBe('Weekly digest');
      expect(chatRow(named.chatId)!.title).toBe('Weekly digest');

      const unnamed = await manager.createJob(
        parse(minimal({ prompt: longPrompt })),
      );
      expect(unnamed.title).toBe(longPrompt.slice(0, 64));
      expect(chatRow(unnamed.chatId)!.title).toBe(longPrompt.slice(0, 64));
    });

    it('persists the parsed payload and normalizes runUntil to UTC ISO', async () => {
      const job = await manager.createJob(
        parse(
          minimal({
            endType: 'date',
            runUntil: '2030-06-01T12:00:00+02:00',
            optimizationMode: 'quality',
            sources: ['web', 'academic'],
            projectId: 'proj-1',
            chatModel: { providerId: 'p1', key: 'chat-key' },
            embeddingModel: null,
          }),
        ),
      );

      expect(job.runUntil).toBe('2030-06-01T10:00:00.000Z');
      expect(jobRow(job.id)!.runUntil).toBe('2030-06-01T10:00:00.000Z');
      expect(job.optimizationMode).toBe('quality');
      expect(job.sources).toEqual(['web', 'academic']);
      expect(job.projectId).toBe('proj-1');
      expect(job.chatModel).toEqual({ providerId: 'p1', key: 'chat-key' });
      expect(job.embeddingModel).toBeNull();
      expect(jobRow(job.id)!.optimizationMode).toBe('quality');
      expect(JSON.parse(jobRow(job.id)!.sources)).toEqual(['web', 'academic']);

      const chat = chatRow(job.chatId)!;
      expect(chat.projectId).toBe('proj-1');
      expect(JSON.parse(chat.sources)).toEqual(['web', 'academic']);

      // The returned object matches what a fresh read sees.
      expect(await manager.getJob(job.id)).toEqual(job);
    });
  });

  describe('listJobs', () => {
    it('is empty for a fresh database', async () => {
      expect(await manager.listJobs()).toEqual([]);
    });

    it('returns the newest job first', async () => {
      const first = await manager.createJob(parse(minimal()));
      vi.setSystemTime(at(10));
      const second = await manager.createJob(parse(minimal()));
      vi.setSystemTime(at(20));
      const third = await manager.createJob(parse(minimal()));

      expect((await manager.listJobs()).map((job) => job.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
    });

    it('reports a null sources column as an empty array', async () => {
      // The column has a DEFAULT but is nullable, so a row written by hand can
      // hold NULL; readers must not hand that out as a null.
      sqlite
        .prepare(
          `INSERT INTO scheduled_jobs
             (id, title, prompt, chatId, intervalMinutes, sources, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          'legacy',
          'Legacy',
          'p',
          'chat-legacy',
          60,
          T0.toISOString(),
          T0.toISOString(),
        );

      expect((await manager.getJob('legacy'))!.sources).toEqual([]);
      expect((await manager.listJobs())[0].sources).toEqual([]);
    });
  });

  describe('getJob', () => {
    it('returns null for an unknown id', async () => {
      expect(await manager.getJob('nope')).toBeNull();
    });
  });

  describe('updateJob', () => {
    it('writes only the keys present in the patch', async () => {
      const job = await manager.createJob(
        parse(
          minimal({
            endType: 'count',
            maxRuns: 3,
            optimizationMode: 'quality',
            sources: ['web'],
            projectId: 'proj-1',
            chatModel: { providerId: 'p1', key: 'chat-key' },
            embeddingModel: { providerId: 'p2', key: 'embed-key' },
          }),
        ),
      );

      vi.setSystemTime(at(5));
      const patched = await manager.updateJob(job.id, { title: 'Renamed' });

      // Everything the patch did not mention survives, byte for byte.
      expect(patched).toEqual({
        ...job,
        title: 'Renamed',
        updatedAt: at(5).toISOString(),
      });
      expect(jobRow(job.id)!.title).toBe('Renamed');
      expect(jobRow(job.id)!.maxRuns).toBe(3);
      expect(JSON.parse(jobRow(job.id)!.sources)).toEqual(['web']);
      expect(JSON.parse(jobRow(job.id)!.chatModel)).toEqual({
        providerId: 'p1',
        key: 'chat-key',
      });
    });

    it('updates the fields the patch does carry, normalizing runUntil', async () => {
      const job = await manager.createJob(parse(minimal()));

      const patched = await manager.updateJob(job.id, {
        prompt: 'New prompt',
        intervalMinutes: 30,
        endType: 'date',
        runUntil: '2030-06-01T12:00:00+02:00',
        optimizationMode: 'speed',
        sources: ['academic'],
        projectId: null,
        chatModel: { providerId: 'p9', key: 'new-key' },
      });

      expect(patched).toMatchObject({
        prompt: 'New prompt',
        intervalMinutes: 30,
        endType: 'date',
        runUntil: '2030-06-01T10:00:00.000Z',
        optimizationMode: 'speed',
        sources: ['academic'],
        projectId: null,
        chatModel: { providerId: 'p9', key: 'new-key' },
      });
      // Absent from the patch, so untouched.
      expect(patched!.embeddingModel).toBeNull();
      expect(patched!.chatId).toBe(job.chatId);
      expect(patched!.createdAt).toBe(job.createdAt);
      expect(jobRow(job.id)!.projectId).toBeNull();
    });

    it('clears runUntil on an explicit null and still normalizes a real string', async () => {
      const job = await manager.createJob(
        parse(minimal({ endType: 'date', runUntil: at(60).toISOString() })),
      );
      expect(job.runUntil).toBe(at(60).toISOString());

      const cleared = await manager.updateJob(job.id, CLEAR_RUN_UNTIL);

      expect(cleared!.runUntil).toBeNull();
      expect(jobRow(job.id)!.runUntil).toBeNull();

      const restored = await manager.updateJob(job.id, {
        runUntil: '2030-06-01T12:00:00+02:00',
      });
      expect(restored!.runUntil).toBe('2030-06-01T10:00:00.000Z');
      expect(jobRow(job.id)!.runUntil).toBe('2030-06-01T10:00:00.000Z');
    });

    it('pauses without rescheduling and makes the job not due', async () => {
      const job = await manager.createJob(parse(minimal()));
      vi.setSystemTime(at(180));
      expect(isJobDue(job, new Date())).toBe(true);

      const paused = await manager.updateJob(job.id, { status: 'paused' });

      expect(paused!.status).toBe('paused');
      expect(paused!.nextRunAt).toBe(job.nextRunAt);
      expect(isJobDue(paused!, new Date())).toBe(false);
    });

    it('resumes with a stale next run pushed into the future', async () => {
      const job = await manager.createJob(parse(minimal()));
      await manager.updateJob(job.id, { status: 'paused' });

      // The T0 + 60min slot has passed while the job was paused.
      vi.setSystemTime(at(180));
      const resumed = await manager.updateJob(job.id, { status: 'active' });

      expect(resumed!.status).toBe('active');
      expect(resumed!.nextRunAt).toBe(computeNextRunAt(new Date(), 60));
      expect(isJobDue(resumed!, new Date())).toBe(false);
    });

    it('resumes without moving a next run that is still in the future', async () => {
      const job = await manager.createJob(parse(minimal()));
      await manager.updateJob(job.id, { status: 'paused' });

      const resumed = await manager.updateJob(job.id, { status: 'active' });

      expect(resumed!.nextRunAt).toBe(job.nextRunAt);
    });

    it('returns null for an unknown id and creates nothing', async () => {
      await manager.createJob(parse(minimal()));

      expect(await manager.updateJob('nope', { title: 'x' })).toBeNull();
      expect(count('scheduled_jobs')).toBe(1);
    });
  });

  describe('deleteJob', () => {
    it('removes the job but keeps its chat', async () => {
      const job = await manager.createJob(parse(minimal()));

      expect(await manager.deleteJob(job.id)).toBe(true);

      expect(count('scheduled_jobs')).toBe(0);
      expect(await manager.getJob(job.id)).toBeNull();
      expect(chatRow(job.chatId)).toBeDefined();
      expect(count('chats')).toBe(1);
    });

    it('returns false for an unknown id', async () => {
      expect(await manager.deleteJob('nope')).toBe(false);
    });
  });

  describe('recordRunOutcome', () => {
    it('completes a count job on the run that reaches maxRuns', async () => {
      const job = await manager.createJob(
        parse(minimal({ endType: 'count', maxRuns: 1 })),
      );

      vi.setSystemTime(at(1));
      const after = await manager.recordRunOutcome(job.id, { ok: true });

      expect(after!.runCount).toBe(1);
      expect(after!.status).toBe('completed');
      expect(after!.lastError).toBeNull();
      expect(after!.lastRunAt).toBe(at(1).toISOString());
      // Kept for the UI, even though no further run will happen.
      expect(after!.nextRunAt).toBe(computeNextRunAt(at(1), 60));
      expect(jobRow(job.id)!.status).toBe('completed');
      expect(jobRow(job.id)!.runCount).toBe(1);
      expect(jobRow(job.id)!.lastRunAt).toBe(at(1).toISOString());
    });

    it('keeps a count job active until the run that reaches maxRuns', async () => {
      const job = await manager.createJob(
        parse(minimal({ endType: 'count', maxRuns: 2 })),
      );

      vi.setSystemTime(at(1));
      const first = await manager.recordRunOutcome(job.id, { ok: true });
      expect(first!.runCount).toBe(1);
      expect(first!.status).toBe('active');

      vi.setSystemTime(at(61));
      const second = await manager.recordRunOutcome(job.id, { ok: true });
      expect(second!.runCount).toBe(2);
      expect(second!.status).toBe('completed');
      expect(second!.nextRunAt).toBe(computeNextRunAt(at(61), 60));
    });

    it('advances the schedule and records the error when a run fails', async () => {
      const job = await manager.createJob(parse(minimal()));

      vi.setSystemTime(at(1));
      const failed = await manager.recordRunOutcome(job.id, {
        ok: false,
        error: 'provider timed out',
      });

      expect(failed!.runCount).toBe(1);
      expect(failed!.lastError).toBe('provider timed out');
      expect(failed!.status).toBe('active');
      expect(failed!.nextRunAt).toBe(computeNextRunAt(at(1), 60));
      expect(failed!.lastRunAt).toBe(at(1).toISOString());
      expect(jobRow(job.id)!.lastError).toBe('provider timed out');
    });

    it('leaves lastError null for a failure without a message and clears it on recovery', async () => {
      const job = await manager.createJob(parse(minimal()));

      vi.setSystemTime(at(1));
      const failed = await manager.recordRunOutcome(job.id, { ok: false });
      expect(failed!.lastError).toBeNull();
      expect(failed!.runCount).toBe(1);

      vi.setSystemTime(at(61));
      const recovered = await manager.recordRunOutcome(job.id, { ok: true });
      expect(recovered!.lastError).toBeNull();
      expect(recovered!.runCount).toBe(2);
    });

    it('leaves a never-ending job active', async () => {
      const job = await manager.createJob(parse(minimal()));

      vi.setSystemTime(at(1));
      const after = await manager.recordRunOutcome(job.id, { ok: true });

      expect(after!.status).toBe('active');
      expect(after!.endType).toBe('never');
    });

    it('keeps a job paused when its run finishes after the pause', async () => {
      const job = await manager.createJob(parse(minimal()));
      await manager.updateJob(job.id, { status: 'paused' });

      // The user paused while the run was in flight.
      vi.setSystemTime(at(5));
      const after = await manager.recordRunOutcome(job.id, { ok: true });

      // The run is still counted and scheduled, but the pause stands: the job
      // must not start firing again on its own.
      expect(after!.status).toBe('paused');
      expect(after!.runCount).toBe(1);
      expect(after!.lastRunAt).toBe(at(5).toISOString());
      expect(after!.nextRunAt).toBe(computeNextRunAt(at(5), 60));
      expect(isJobDue(after!, new Date())).toBe(false);
      expect(jobRow(job.id)!.status).toBe('paused');

      // Resuming stays an explicit act.
      expect(
        (await manager.updateJob(job.id, { status: 'active' }))!.status,
      ).toBe('active');
    });

    it('keeps a paused job paused even when the run failed', async () => {
      const job = await manager.createJob(parse(minimal()));
      await manager.updateJob(job.id, { status: 'paused' });

      vi.setSystemTime(at(5));
      const after = await manager.recordRunOutcome(job.id, {
        ok: false,
        error: 'provider timed out',
      });

      expect(after!.status).toBe('paused');
      expect(after!.lastError).toBe('provider timed out');
    });

    it('completes a paused job that reached its count end', async () => {
      const job = await manager.createJob(
        parse(minimal({ endType: 'count', maxRuns: 1 })),
      );
      await manager.updateJob(job.id, { status: 'paused' });

      vi.setSystemTime(at(5));
      const after = await manager.recordRunOutcome(job.id, { ok: true });

      // Completion is terminal, so it wins over the pause.
      expect(after!.status).toBe('completed');
      expect(after!.runCount).toBe(1);
    });

    it('completes a paused date job once its next slot passes runUntil', async () => {
      const job = await manager.createJob(
        parse(minimal({ endType: 'date', runUntil: at(59.99).toISOString() })),
      );
      await manager.updateJob(job.id, { status: 'paused' });

      vi.setSystemTime(at(5));
      const after = await manager.recordRunOutcome(job.id, { ok: true });

      expect(after!.nextRunAt).toBe(at(65).toISOString());
      expect(after!.status).toBe('completed');
    });

    it('completes a date job only once the next slot is past runUntil', async () => {
      // Next slot lands exactly on runUntil: the job still gets that run.
      const onBoundary = await manager.createJob(
        parse(minimal({ endType: 'date', runUntil: at(60).toISOString() })),
      );
      const stillActive = await manager.recordRunOutcome(onBoundary.id, {
        ok: true,
      });
      expect(stillActive!.nextRunAt).toBe(at(60).toISOString());
      expect(stillActive!.status).toBe('active');

      // Next slot lands 1ms past runUntil: nothing more to run.
      const justOver = await manager.createJob(
        parse(minimal({ endType: 'date', runUntil: at(59.99).toISOString() })),
      );
      const done = await manager.recordRunOutcome(justOver.id, { ok: true });
      expect(done!.nextRunAt).toBe(at(60).toISOString());
      expect(done!.status).toBe('completed');
    });

    it('returns null for an unknown id', async () => {
      expect(await manager.recordRunOutcome('nope', { ok: true })).toBeNull();
    });
  });

  describe('pushNextRun', () => {
    it('adds one interval to a next run that is still in the future', async () => {
      const job = await manager.createJob(parse(minimal()));

      const pushed = await manager.pushNextRun(job.id);

      expect(pushed!.nextRunAt).toBe(computeNextRunAt(at(60), 60));
      expect(jobRow(job.id)!.nextRunAt).toBe(computeNextRunAt(at(60), 60));
    });

    it('adds one interval to now when the next run is already in the past', async () => {
      const job = await manager.createJob(parse(minimal()));
      vi.setSystemTime(at(180));

      const pushed = await manager.pushNextRun(job.id);

      expect(pushed!.nextRunAt).toBe(computeNextRunAt(at(180), 60));
    });

    it('falls back to now when the job has no next run at all', async () => {
      const job = await manager.createJob(parse(minimal()));
      sqlite
        .prepare('UPDATE scheduled_jobs SET nextRunAt = NULL WHERE id = ?')
        .run(job.id);
      vi.setSystemTime(at(180));

      const pushed = await manager.pushNextRun(job.id);

      expect(pushed!.nextRunAt).toBe(computeNextRunAt(at(180), 60));
    });

    it('leaves the run bookkeeping alone', async () => {
      const job = await manager.createJob(
        parse(minimal({ endType: 'count', maxRuns: 4 })),
      );
      vi.setSystemTime(at(1));
      await manager.recordRunOutcome(job.id, { ok: false, error: 'boom' });

      vi.setSystemTime(at(2));
      const pushed = await manager.pushNextRun(job.id);

      // The failed run left nextRunAt at 00:01 + 60min, still in the future,
      // so that is the base; only the bookkeeping columns must not move.
      expect(pushed).toEqual({
        ...(await manager.getJob(job.id)),
        nextRunAt: computeNextRunAt(at(61), 60),
        updatedAt: at(2).toISOString(),
      });
    });

    it('returns null for an unknown id', async () => {
      expect(await manager.pushNextRun('nope')).toBeNull();
    });
  });
});
