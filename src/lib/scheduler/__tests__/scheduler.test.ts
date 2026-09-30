import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScheduler, stopScheduler, tick } from '@/lib/scheduler/scheduler';
import type { ScheduledJob } from '@/lib/scheduler/types';

const doubles = vi.hoisted(() => ({
  listJobs: vi.fn(),
  recordRunOutcome: vi.fn(),
  pushNextRun: vi.fn(),
  /**
   * Every job the ticker fired, as ids. A plain array rather than a spy on
   * `runJobNow`, because vitest attaches a rejection handler to any promise a
   * spy returns — which is exactly what would hide the unhandled rejection
   * `survives a job whose run and bookkeeping both blow up` is about.
   */
  runJobNowCalls: [] as string[],
  /**
   * What a fired run hands back. A PLAIN function for the same reason: a test
   * has to be able to return a promise nothing else has a handler on, and to
   * leave one pending forever to hold a job "in flight".
   */
  runJobNowResult: (() => Promise.resolve({ ok: true })) as (
    job: ScheduledJob,
  ) => Promise<unknown>,
}));

vi.mock('@/lib/scheduler/manager', () => ({
  default: class SchedulerManager {
    listJobs = doubles.listJobs;
    recordRunOutcome = doubles.recordRunOutcome;
    pushNextRun = doubles.pushNextRun;
  },
}));

vi.mock('@/lib/scheduler/runner', () => ({
  runJobNow: (job: ScheduledJob) => {
    doubles.runJobNowCalls.push(job.id);
    return doubles.runJobNowResult(job);
  },
}));

const NOW = '2026-01-01T01:00:00.000Z';
const T0 = '2026-01-01T00:00:00.000Z';

/** Due by default: the default slot is 30 minutes before the frozen `NOW`. */
const job = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 'job-1',
  title: 'Daily digest',
  prompt: 'Summarize what changed today',
  chatId: 'chat-1',
  intervalMinutes: 60,
  endType: 'never',
  maxRuns: null,
  runUntil: null,
  status: 'active',
  runCount: 0,
  lastRunAt: null,
  nextRunAt: '2026-01-01T00:30:00.000Z',
  lastError: null,
  optimizationMode: 'quality',
  sources: ['web'],
  chatModel: null,
  embeddingModel: null,
  projectId: null,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

/** A promise a test resolves by hand, to hold a run "in flight". */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/**
 * Lets every already-resolved promise chain the ticker left behind settle, so
 * the bookkeeping that happens after a run resolves can be asserted. Only
 * `Date` is faked by these tests, so `setImmediate` is real.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('scheduler ticker', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Only `Date` is faked, so a due slot is an exact comparison and the real
    // `setImmediate` above keeps working. The interval test fakes the lot.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));

    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    doubles.runJobNowCalls = [];
    doubles.runJobNowResult = () => Promise.resolve({ ok: true });
    doubles.listJobs.mockResolvedValue([]);
    doubles.recordRunOutcome.mockResolvedValue(null);
    doubles.pushNextRun.mockResolvedValue(null);
  });

  afterEach(() => {
    // A leaked interval would keep ticking into the next test.
    stopScheduler();
    vi.useRealTimers();
    consoleError.mockRestore();
  });

  it('fires a due job and records the outcome it reports', async () => {
    // The slot has exactly arrived: `isJobDue` is inclusive of `now`.
    doubles.listJobs.mockResolvedValue([job({ nextRunAt: NOW })]);

    await expect(tick()).resolves.toEqual({ ran: ['job-1'], pushed: [] });
    expect(doubles.runJobNowCalls).toEqual(['job-1']);

    await settle();
    expect(doubles.recordRunOutcome).toHaveBeenCalledTimes(1);
    expect(doubles.recordRunOutcome).toHaveBeenCalledWith('job-1', {
      ok: true,
    });
  });

  it('leaves jobs that are not due untouched', async () => {
    doubles.listJobs.mockResolvedValue([
      // Scheduled, but not yet.
      job({ id: 'future', nextRunAt: '2026-01-01T01:30:00.000Z' }),
      // Both due by the clock, but neither active: `isJobDue` owns that rule,
      // and the ticker must not decide it differently.
      job({ id: 'paused', status: 'paused' }),
      job({ id: 'completed', status: 'completed' }),
    ]);

    await expect(tick()).resolves.toEqual({ ran: [], pushed: [] });

    await settle();
    expect(doubles.runJobNowCalls).toEqual([]);
    expect(doubles.recordRunOutcome).not.toHaveBeenCalled();
    expect(doubles.pushNextRun).not.toHaveBeenCalled();
  });

  it('pushes the slot of a job whose run is still going instead of firing it twice', async () => {
    const pending = deferred<{ ok: boolean }>();
    doubles.listJobs.mockResolvedValue([job()]);
    doubles.runJobNowResult = () => pending.promise;

    await expect(tick()).resolves.toEqual({ ran: ['job-1'], pushed: [] });

    // The second tick sees the same job still in flight.
    await expect(tick()).resolves.toEqual({ ran: [], pushed: ['job-1'] });
    expect(doubles.runJobNowCalls).toEqual(['job-1']);
    expect(doubles.pushNextRun).toHaveBeenCalledTimes(1);
    expect(doubles.pushNextRun).toHaveBeenCalledWith('job-1');
    expect(doubles.recordRunOutcome).not.toHaveBeenCalled();

    // Once the run lands it reports its own outcome, and the job is dispatchable
    // again — an id left in the in-flight set would strand it forever.
    pending.resolve({ ok: true });
    await settle();
    expect(doubles.recordRunOutcome).toHaveBeenCalledWith('job-1', {
      ok: true,
    });

    await expect(tick()).resolves.toEqual({ ran: ['job-1'], pushed: [] });
    expect(doubles.runJobNowCalls).toEqual(['job-1', 'job-1']);
  });

  it('runs one interval however many times it is started, and stopScheduler clears it', async () => {
    // The whole timer surface this time: the interval has to be fake to count.
    vi.useFakeTimers();
    // The global setup disables the automatic boot path for every test, and an
    // explicit start must ignore that flag — the env var is read by the boot
    // hook in `src/instrumentation.ts` and nowhere else.
    expect(process.env.VANE_DISABLE_SCHEDULER).toBe('1');
    doubles.listJobs.mockResolvedValue([]);

    startScheduler();
    startScheduler();
    startScheduler();

    // The immediate first tick on boot, then one per interval.
    expect(doubles.listJobs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(doubles.listJobs).toHaveBeenCalledTimes(2);

    stopScheduler();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(doubles.listJobs).toHaveBeenCalledTimes(2);

    // And it really was a clear, not a permanent shutdown: the restart ticks
    // once on boot like any other start, and then keeps its own interval.
    startScheduler();
    expect(doubles.listJobs).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(doubles.listJobs).toHaveBeenCalledTimes(4);
  });

  it('survives a job whose run and bookkeeping both blow up', async () => {
    doubles.listJobs.mockResolvedValue([
      job({ id: 'job-a' }),
      job({ id: 'job-b' }),
    ]);
    // `runJobNow` never rejects in production, so this is the defensive path;
    // `recordRunOutcome` rejecting is the one that really can.
    doubles.runJobNowResult = (target) =>
      target.id === 'job-a'
        ? Promise.reject(new Error('run exploded'))
        : Promise.resolve({ ok: true });
    doubles.recordRunOutcome.mockRejectedValue(new Error('db is gone'));

    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', collect);

    try {
      await expect(tick()).resolves.toEqual({
        ran: ['job-a', 'job-b'],
        pushed: [],
      });
      // Both were fired: the failure of the first did not stop the second.
      expect(doubles.runJobNowCalls).toEqual(['job-a', 'job-b']);

      await settle();
      expect(doubles.recordRunOutcome).toHaveBeenCalledWith('job-b', {
        ok: true,
      });
      // Both failures were logged, one per job: nothing was swallowed either.
      const logged = consoleError.mock.calls.map((call: unknown[]) =>
        String(call[0]),
      );
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(logged[0]).toContain('job-a');
      expect(logged[1]).toContain('job-b');
      // Node reports a handler-less rejection on the next macrotask.
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', collect);
    }

    // The ticker is still alive and both jobs are dispatchable again.
    doubles.runJobNowResult = () => Promise.resolve({ ok: true });
    doubles.recordRunOutcome.mockResolvedValue(null);
    await expect(tick()).resolves.toEqual({
      ran: ['job-a', 'job-b'],
      pushed: [],
    });
  });

  it('does not let a failing job listing escape the tick', async () => {
    doubles.listJobs.mockRejectedValue(new Error('no such table'));
    await expect(tick()).resolves.toEqual({ ran: [], pushed: [] });

    // Also the synchronous throw a `listJobs` that is not `async` could make.
    doubles.listJobs.mockImplementation(() => {
      throw new Error('sync boom');
    });
    await expect(tick()).resolves.toEqual({ ran: [], pushed: [] });

    // Both listings were logged and neither fired anything.
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(doubles.runJobNowCalls).toEqual([]);
  });
});
