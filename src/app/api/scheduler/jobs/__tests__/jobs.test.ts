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
import type { ScheduledJob } from '@/lib/scheduler/types';
import {
  betterSqliteMockFactory,
  closeTrackedDatabases,
} from '@/test/dbTracking';

/**
 * Every route here reaches the real `SchedulerManager`, which reaches the real
 * `@/lib/db` singleton — and that singleton opens `<DATA_DIR>/data/db.sqlite` at
 * import time. So this file runs the whole stack against a throwaway database:
 * a temp `DATA_DIR` with the real `drizzle/*.sql` files copied in, migrations
 * applied, and the route modules imported dynamically afterwards so the
 * singleton resolves the temp path rather than the developer's own data dir (the
 * convention `src/lib/db/__tests__/migrate.test.ts` sets).
 *
 * `@/lib/db` and `@/lib/db/migrate` both leave a native handle open, and the
 * hundreds of prepared statements the routes make must stay reachable, or the
 * worker's teardown aborts the whole file; see src/test/dbTracking.ts.
 */
vi.mock('better-sqlite3', () =>
  import('@/test/dbTracking').then((m) => m.betterSqliteMockFactory()),
);

/**
 * The runner is the only part of this stack that needs a model provider and a
 * network. It never rejects (src/lib/scheduler/runner.ts) and never gets
 * awaited by the route, so a spy that hands back a controllable promise is
 * enough to observe the fire-and-forget contract.
 */
const doubles = vi.hoisted(() => ({
  runJobNow: vi.fn(),
}));

vi.mock('@/lib/scheduler/runner', () => ({
  runJobNow: doubles.runJobNow,
}));

type JobsRoute = typeof import('@/app/api/scheduler/jobs/route');
type JobRoute = typeof import('@/app/api/scheduler/jobs/[id]/route');
type RunRoute = typeof import('@/app/api/scheduler/jobs/[id]/run/route');
type ManagerClass = typeof import('@/lib/scheduler/manager').default;

const REPO_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

describe('scheduler jobs API', () => {
  let tmpDir: string;
  let inspector: Database.Database;
  let jobs: JobsRoute;
  let job: JobRoute;
  let run: RunRoute;
  let Manager: ManagerClass;
  let consoleError: ReturnType<typeof vi.spyOn>;
  const originalDataDir = process.env.DATA_DIR;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-scheduler-api-'));
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
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('@/lib/db/migrate');

    jobs = await import('@/app/api/scheduler/jobs/route');
    job = await import('@/app/api/scheduler/jobs/[id]/route');
    run = await import('@/app/api/scheduler/jobs/[id]/run/route');
    Manager = (await import('@/lib/scheduler/manager')).default;

    // A second, read-only-by-convention handle so a test can assert on the rows
    // the routes wrote rather than only on what they echo back.
    inspector = new Database(path.join(tmpDir, 'data', 'db.sqlite'));
  });

  afterAll(() => {
    consoleError.mockRestore();
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
    vi.clearAllMocks();
    doubles.runJobNow.mockResolvedValue({ ok: true });
    inspector.exec('DELETE FROM scheduled_jobs; DELETE FROM chats;');
  });

  const req = (method: string, url: string, body?: unknown) =>
    new Request(`http://localhost${url}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }),
    });

  const post = (body: unknown) =>
    jobs.POST(req('POST', '/api/scheduler/jobs', body));
  const list = () => jobs.GET();
  const getOne = (id: string) =>
    job.GET(req('GET', `/api/scheduler/jobs/${id}`), {
      params: Promise.resolve({ id }),
    });
  const patch = (id: string, body: unknown) =>
    job.PATCH(req('PATCH', `/api/scheduler/jobs/${id}`, body), {
      params: Promise.resolve({ id }),
    });
  const del = (id: string) =>
    job.DELETE(req('DELETE', `/api/scheduler/jobs/${id}`), {
      params: Promise.resolve({ id }),
    });
  const runNow = (id: string) =>
    run.POST(req('POST', `/api/scheduler/jobs/${id}/run`), {
      params: Promise.resolve({ id }),
    });

  const minimal = (overrides: Record<string, unknown> = {}) => ({
    prompt: 'Summarize what changed today',
    intervalMinutes: 60,
    endType: 'never',
    ...overrides,
  });

  /** Creates a job through the POST route and returns its body. */
  const create = async (overrides: Record<string, unknown> = {}) => {
    const response = await post(minimal(overrides));
    expect(response.status).toBe(201);
    return (await response.json()).job as ScheduledJob;
  };

  const jobRow = (id: string) =>
    inspector.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as
      | Record<string, any>
      | undefined;
  const chatRow = (id: string) =>
    inspector.prepare('SELECT * FROM chats WHERE id = ?').get(id) as
      | Record<string, any>
      | undefined;

  /** Lets the promise chain the run route left behind settle. */
  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  describe('runtime config', () => {
    it('runs on node with dynamic rendering on every route', () => {
      for (const route of [jobs, job, run]) {
        expect(route.runtime).toBe('nodejs');
        expect(route.dynamic).toBe('force-dynamic');
      }
    });
  });

  describe('GET /api/scheduler/jobs', () => {
    it('returns an empty list before anything is created', async () => {
      const response = await list();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jobs: [] });
    });

    it('returns the created job', async () => {
      const created = await create({ title: 'Daily digest' });

      const response = await list();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0]).toEqual(created);
    });

    it('returns every job, newest first', async () => {
      // The order is `ORDER BY createdAt DESC`, so the three jobs have to be a
      // measurable distance apart: three inserts inside one millisecond are a
      // tie the database may resolve in any order.
      vi.useFakeTimers({ toFake: ['Date'] });
      const created: string[] = [];
      for (const minute of [1, 2, 3]) {
        vi.setSystemTime(new Date(`2026-01-01T00:0${minute}:00.000Z`));
        created.push((await create()).id);
      }
      vi.useRealTimers();
      const [first, second, third] = created;

      const body = await (await list()).json();

      expect(body.jobs.map((entry: ScheduledJob) => entry.id)).toEqual([
        third,
        second,
        first,
      ]);
    });
  });

  describe('POST /api/scheduler/jobs', () => {
    it('creates a job and its chat, and answers 201 with the job', async () => {
      const response = await post(
        minimal({
          title: 'Release watch',
          intervalMinutes: 45,
          optimizationMode: 'quality',
          sources: ['web', 'academic'],
        }),
      );

      expect(response.status).toBe(201);

      const { job: created } = await response.json();
      expect(created).toMatchObject({
        title: 'Release watch',
        prompt: 'Summarize what changed today',
        intervalMinutes: 45,
        endType: 'never',
        status: 'active',
        runCount: 0,
        optimizationMode: 'quality',
        sources: ['web', 'academic'],
      });
      expect(created.chatId).toMatch(/^[0-9a-f]{40}$/);
      expect(created.nextRunAt).not.toBeNull();

      // Persisted, together with the chat every run of it appends to.
      expect(jobRow(created.id)).toMatchObject({
        intervalMinutes: 45,
        optimizationMode: 'quality',
      });
      expect(JSON.parse(jobRow(created.id)!.sources)).toEqual([
        'web',
        'academic',
      ]);
      expect(chatRow(created.chatId)).toMatchObject({
        title: 'Release watch',
      });
    });

    it('applies the schema defaults for the fields the body omits', async () => {
      const created = await create();

      expect(created.optimizationMode).toBe('balanced');
      expect(created.sources).toEqual(['web']);
      expect(created.maxRuns).toBeNull();
      expect(created.runUntil).toBeNull();
    });

    it('answers 400 with the issues mapped when an interval is invalid', async () => {
      const response = await post(minimal({ intervalMinutes: 0 }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toBe('Invalid request body');
      expect(body.error).toEqual([
        expect.objectContaining({ path: 'intervalMinutes' }),
      ]);
      // Nothing was written.
      expect(
        inspector.prepare('SELECT COUNT(*) AS n FROM scheduled_jobs').get(),
      ).toEqual({
        n: 0,
      });
    });

    it('answers 400 for a count job without maxRuns', async () => {
      const response = await post(minimal({ endType: 'count' }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toEqual([
        expect.objectContaining({
          path: 'maxRuns',
          message: 'maxRuns is required when endType is count',
        }),
      ]);
    });

    it('answers 400 for a runUntil without seconds or a zone', async () => {
      // What `<input type="datetime-local">` hands back. The route must not
      // weaken the schema to accommodate it: `new Date()` would read it in the
      // server's local zone, so the caller converts before sending.
      const response = await post(
        minimal({ endType: 'date', runUntil: '2999-02-01T00:00' }),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toEqual([
        expect.objectContaining({ path: 'runUntil' }),
      ]);
    });

    it('accepts a full ISO runUntil once the caller converted it', async () => {
      const response = await post(
        minimal({
          endType: 'date',
          runUntil: new Date('2999-02-01T00:00').toISOString(),
        }),
      );

      expect(response.status).toBe(201);
      const { job: created } = await response.json();
      expect(new Date(created.runUntil).getTime()).toBeGreaterThan(
        Date.now() + 1000 * 60 * 60 * 24 * 365 * 100,
      );
    });
  });

  describe('GET /api/scheduler/jobs/[id]', () => {
    it('returns the job', async () => {
      const created = await create();

      const response = await getOne(created.id);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ job: created });
    });

    it('answers 404 for an unknown id', async () => {
      const response = await getOne('nope');

      expect(response.status).toBe(404);
      expect((await response.json()).message).toBe('Scheduled job not found');
    });
  });

  describe('PATCH /api/scheduler/jobs/[id]', () => {
    it('pauses a job', async () => {
      const created = await create();

      const response = await patch(created.id, { status: 'paused' });

      expect(response.status).toBe(200);
      const { job: updated } = await response.json();
      expect(updated.status).toBe('paused');
      expect(jobRow(created.id)!.status).toBe('paused');
    });

    it('resumes a job', async () => {
      const created = await create();
      await patch(created.id, { status: 'paused' });

      const response = await patch(created.id, { status: 'active' });

      expect(response.status).toBe(200);
      expect((await response.json()).job.status).toBe('active');
    });

    it('writes only the keys the request body carried', async () => {
      // The point of the merge-by-key-presence rule. zod keeps `.default()`
      // through `.partial()`, so the parsed body of a `{ title }`-only PATCH
      // also holds `optimizationMode: 'balanced'` and `sources: ['web']`;
      // writing that parsed object would silently reset them.
      const created = await create({
        title: 'Original',
        intervalMinutes: 45,
        endType: 'count',
        maxRuns: 3,
        optimizationMode: 'quality',
        sources: ['web', 'academic'],
        projectId: 'proj-1',
        chatModel: { providerId: 'p1', key: 'chat-key' },
      });

      const response = await patch(created.id, { title: 'Renamed' });

      expect(response.status).toBe(200);
      const { job: updated } = await response.json();
      expect(updated.title).toBe('Renamed');
      expect(updated).toMatchObject({
        intervalMinutes: 45,
        endType: 'count',
        maxRuns: 3,
        optimizationMode: 'quality',
        sources: ['web', 'academic'],
        projectId: 'proj-1',
        chatModel: { providerId: 'p1', key: 'chat-key' },
      });

      // And the stored row, not just the echoed body.
      const row = jobRow(created.id)!;
      expect(row.title).toBe('Renamed');
      expect(row.intervalMinutes).toBe(45);
      expect(row.optimizationMode).toBe('quality');
      expect(row.maxRuns).toBe(3);
      expect(JSON.parse(row.sources)).toEqual(['web', 'academic']);
      expect(JSON.parse(row.chatModel)).toEqual({
        providerId: 'p1',
        key: 'chat-key',
      });
    });

    it('updates several fields at once', async () => {
      const created = await create();

      const response = await patch(created.id, {
        prompt: 'New prompt',
        intervalMinutes: 15,
        endType: 'date',
        runUntil: '2999-06-01T12:00:00+02:00',
        optimizationMode: 'speed',
        sources: ['academic'],
        projectId: null,
        chatModel: { providerId: 'p9', key: 'new-key' },
      });

      expect(response.status).toBe(200);
      expect((await response.json()).job).toMatchObject({
        prompt: 'New prompt',
        intervalMinutes: 15,
        endType: 'date',
        // Stored in the canonical UTC form.
        runUntil: '2999-06-01T10:00:00.000Z',
        optimizationMode: 'speed',
        sources: ['academic'],
        projectId: null,
        chatModel: { providerId: 'p9', key: 'new-key' },
      });
    });

    it('answers 400 when a patched field is invalid', async () => {
      const created = await create();

      const response = await patch(created.id, { intervalMinutes: 0 });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toBe('Invalid request body');
      expect(body.error).toEqual([
        expect.objectContaining({ path: 'intervalMinutes' }),
      ]);
      // The stored row is untouched.
      expect(jobRow(created.id)!.intervalMinutes).toBe(60);
    });

    it('answers 400 for an unknown status', async () => {
      const created = await create();

      const response = await patch(created.id, { status: 'completed' });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toEqual([
        expect.objectContaining({ path: 'status' }),
      ]);
    });

    it('does not require the end-condition fields a whole job needs', async () => {
      // The create-time rules (`count -> maxRuns`) are invariants of a whole
      // job, not of one field update.
      const created = await create({ endType: 'count', maxRuns: 2 });

      const response = await patch(created.id, { title: 'Only a title' });

      expect(response.status).toBe(200);
      expect((await response.json()).job).toMatchObject({
        title: 'Only a title',
        endType: 'count',
        maxRuns: 2,
      });
    });

    it('answers 404 for an unknown id', async () => {
      const response = await patch('nope', { title: 'x' });

      expect(response.status).toBe(404);
      expect((await response.json()).message).toBe('Scheduled job not found');
    });
  });

  describe('DELETE /api/scheduler/jobs/[id]', () => {
    it('answers 204 with no body and removes only the job', async () => {
      const created = await create();

      const response = await del(created.id);

      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');

      expect(jobRow(created.id)).toBeUndefined();
      // The chat and everything collected in it survive.
      expect(chatRow(created.chatId)).toBeDefined();

      expect((await getOne(created.id)).status).toBe(404);
      expect(
        inspector.prepare('SELECT COUNT(*) AS n FROM scheduled_jobs').get(),
      ).toEqual({
        n: 0,
      });
    });

    it('answers 404 for an unknown id', async () => {
      const response = await del('nope');

      expect(response.status).toBe(404);
      expect((await response.json()).message).toBe('Scheduled job not found');
    });
  });

  describe('POST /api/scheduler/jobs/[id]/run', () => {
    it('answers 202 without waiting for the run to finish', async () => {
      const created = await create();
      // Never resolves: if the route awaited the run, this test would time out
      // instead of getting a 202.
      const pending = deferred<{ ok: boolean }>();
      doubles.runJobNow.mockReturnValue(pending.promise);

      const response = await runNow(created.id);

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({});
      expect(doubles.runJobNow).toHaveBeenCalledTimes(1);
      expect(doubles.runJobNow.mock.calls[0][0]).toMatchObject({
        id: created.id,
        prompt: created.prompt,
        chatId: created.chatId,
      });

      // Nothing is recorded until the run reports back.
      expect(jobRow(created.id)!.runCount).toBe(0);

      pending.resolve({ ok: true });
      await settle();
    });

    it('records the outcome once the run settles', async () => {
      const created = await create();
      const pending = deferred<{ ok: boolean }>();
      doubles.runJobNow.mockReturnValue(pending.promise);

      await runNow(created.id);
      expect(jobRow(created.id)!.runCount).toBe(0);

      pending.resolve({ ok: true });
      await settle();

      const row = jobRow(created.id)!;
      expect(row.runCount).toBe(1);
      expect(row.lastRunAt).not.toBeNull();
      expect(row.lastError).toBeNull();
      // The schedule moved on, so the ticker does not fire it again at once.
      expect(new Date(row.nextRunAt).getTime()).toBeGreaterThan(
        new Date(row.lastRunAt).getTime(),
      );
    });

    it('records a failed run with its error', async () => {
      const created = await create();
      const pending = deferred<{ ok: boolean; error?: string }>();
      doubles.runJobNow.mockReturnValue(pending.promise);

      await runNow(created.id);
      pending.resolve({ ok: false, error: 'provider timed out' });
      await settle();

      const row = jobRow(created.id)!;
      expect(row.runCount).toBe(1);
      expect(row.lastError).toBe('provider timed out');
    });

    it('completes a count job that reached maxRuns', async () => {
      const created = await create({ endType: 'count', maxRuns: 1 });

      await runNow(created.id);
      await settle();

      expect(jobRow(created.id)!.status).toBe('completed');
    });

    it('survives a run that rejects outright', async () => {
      const created = await create();
      doubles.runJobNow.mockRejectedValue(new Error('run exploded'));

      const response = await runNow(created.id);

      expect(response.status).toBe(202);
      await settle();
      expect(consoleError).toHaveBeenCalled();
    });

    it('answers 404 for an unknown id and never starts a run', async () => {
      const response = await runNow('nope');

      expect(response.status).toBe(404);
      expect((await response.json()).message).toBe('Scheduled job not found');
      expect(doubles.runJobNow).not.toHaveBeenCalled();
    });

    it('answers 409 for a completed job and never starts a run', async () => {
      const created = await create({ endType: 'count', maxRuns: 1 });
      await new Manager().recordRunOutcome(created.id, { ok: true });
      expect(jobRow(created.id)!.status).toBe('completed');

      const response = await runNow(created.id);

      expect(response.status).toBe(409);
      expect(doubles.runJobNow).not.toHaveBeenCalled();
    });

    it('runs a paused job on request', async () => {
      const created = await create();
      await patch(created.id, { status: 'paused' });

      const response = await runNow(created.id);

      expect(response.status).toBe(202);
      expect(doubles.runJobNow).toHaveBeenCalledTimes(1);
      await settle();
      // A run the user asked for must not silently resume the schedule.
      expect(jobRow(created.id)!.status).toBe('paused');
    });
  });
});
