import SchedulerManager from './manager';
import { runJobNow } from './runner';
import { evaluateEnd, isJobDue, type ScheduledJob } from './types';

/** How often the ticker looks for jobs that have come due. */
const TICK_INTERVAL_MS = 30_000;

const manager = new SchedulerManager();

/**
 * Jobs whose run has not settled yet, by id.
 *
 * A run is a whole research turn — a minute or more — and the tick that starts
 * it does not wait for it. So a job that is still going when the next tick
 * comes around is NOT fired a second time: the slot it was due for is pushed
 * one interval out instead, and the run already in flight reports its own
 * outcome when it lands. Without this, a job slower than the interval would
 * queue a new run on every tick and pile up without limit.
 *
 * The SAME set is the manual run route's guard (`claimJob`), because "already
 * running" has to mean the same thing to both dispatchers: a double-clicked
 * "Run now", or the same job open in two tabs of `/scheduled`, is the same
 * hazard as a slow tick, and only one run of it may ever be paid for.
 */
const running = new Set<string>();

/**
 * Claims a job for one run, for either dispatcher. `false` means a run is
 * already in flight, and the caller must not start one.
 *
 * Release with `releaseJob` in a `finally`, so a run that rejects, throws, or
 * never settles cannot strand the id — a stranded id would stop that job from
 * ever running again.
 */
export const claimJob = (id: string): boolean => {
  if (running.has(id)) return false;
  running.add(id);
  return true;
};

/** Releases a claim taken by `claimJob`. Releasing an unclaimed id is a no-op. */
export const releaseJob = (id: string): void => {
  running.delete(id);
};

/**
 * Awaits one bookkeeping call, turning any failure into a log line. Both
 * `runJobNow` and the manager are written not to throw, so this is the belt to
 * their braces: the ticker runs with NOTHING awaiting it, where an escaping
 * rejection is node's `unhandledRejection` and takes the whole server process
 * down over one job.
 */
const attempt = async (
  what: string,
  work: () => Promise<unknown>,
): Promise<void> => {
  try {
    await work();
  } catch (err) {
    console.error(`Scheduler: could not ${what}`, err);
  }
};

/**
 * One job, start to finish: the run itself, then the bookkeeping that moves its
 * schedule on. Declared `async` rather than chained off `runJobNow` directly so
 * that even a synchronous throw from the runner arrives as a rejection — a throw
 * that escaped `tick` mid-loop would leave the id in `running` forever, and the
 * job could never be fired again.
 */
const run = async (job: ScheduledJob): Promise<void> => {
  const result = await runJobNow(job);
  await manager.recordRunOutcome(job.id, result);
};

/**
 * One pass over the job table: fire everything that is due, once each.
 *
 * Returns the ids it dispatched (`ran`) and the ids whose slot it pushed
 * because a run was still in flight (`pushed`). Exported, and part of the
 * contract, because the tests drive it directly — `startScheduler` only ever
 * calls it in the background.
 *
 * A job that is due but already past its end condition appears in NEITHER list:
 * it was completed without a run, which spends nothing.
 *
 * Restart catch-up needs nothing here: `startScheduler`'s immediate first tick
 * finds any job whose slot passed while the process was down, fires it once,
 * and the run that lands records its own outcome and reschedules from there.
 * Missed runs are never backfilled.
 */
export const tick = async (): Promise<{ ran: string[]; pushed: string[] }> => {
  const ran: string[] = [];
  const pushed: string[] = [];

  let jobs: ScheduledJob[];
  try {
    jobs = await manager.listJobs();
  } catch (err) {
    console.error('Scheduler: could not list scheduled jobs', err);
    return { ran, pushed };
  }

  // One clock for the whole pass, so two jobs cannot disagree about "now".
  const now = new Date();

  for (const job of jobs) {
    if (!isJobDue(job, now)) continue;

    /**
     * The end condition, checked BEFORE the dispatch as the feature's rule
     * requires, not only afterwards by `recordRunOutcome`.
     *
     * A due slot can already be past a job's end: a `date` job the server was
     * down (or the user had paused) across its `runUntil`, or a `count` job
     * PATCHed to a `maxRuns` at or below the `runCount` it already has. Both
     * are one tick away from a full PAID research turn that the user did not
     * intend and the job must never perform — so it is completed here, without
     * a run, and no turn is dispatched.
     */
    if (
      job.nextRunAt !== null &&
      evaluateEnd(job, job.nextRunAt) === 'completed'
    ) {
      await attempt(`complete ${job.id}`, () => manager.completeJob(job.id));
      continue;
    }

    if (!claimJob(job.id)) {
      // Awaited, unlike a run: pushing a slot is one row write, and this job
      // cannot fire on this pass either way. Waiting for it keeps the returned
      // `pushed` list honest — the schedule really has moved by the time `tick`
      // resolves.
      pushed.push(job.id);
      await attempt(`push the next run of ${job.id}`, () =>
        manager.pushNextRun(job.id),
      );
      continue;
    }

    ran.push(job.id);
    // Deliberately NOT awaited: each run is a full research turn, and awaiting
    // one before starting the next would serialize the whole queue behind the
    // slowest job in it. The in-flight id above is what keeps the overlap from
    // turning into a double fire.
    void run(job)
      // `finally` FIRST, so the id is released however the run ended and the
      // `catch` on the tail of the chain is the last handler — nothing is left
      // holding a rejected promise that has none.
      .finally(() => {
        releaseJob(job.id);
      })
      .catch((err) => {
        console.error(`Scheduler: job ${job.id} failed`, err);
      });
  }

  return { ran, pushed };
};

/**
 * The only way this module starts a tick. Nothing awaits a tick, so a rejected
 * one is node's `unhandledRejection` and takes the process down; routing every
 * entry point through here means no such promise is ever left bare.
 */
const onTick = (): void => {
  void tick().catch((err) => {
    console.error('Scheduler: tick failed', err);
  });
};

type Ticker = ReturnType<typeof setInterval>;

const scope = globalThis as typeof globalThis & {
  __vaneScheduler?: Ticker | null;
};

/**
 * `setInterval` hands back a `NodeJS.Timeout` in node and a bare id under the
 * DOM typings, so node's `unref` is reached through this narrow view of it.
 */
const unref = (timer: Ticker): void => {
  const nodeTimer = timer as unknown as { unref?: () => void };
  if (typeof nodeTimer.unref === 'function') nodeTimer.unref();
};

/**
 * Starts the 30 second ticker: one interval, plus an immediate first tick.
 *
 * `VANE_DISABLE_SCHEDULER` is deliberately NOT read here. It belongs to the
 * boot hook in `src/instrumentation.ts`, which is the only caller that wants
 * the flag; this function is also called directly by its tests, which run with
 * that variable set to `'1'`, and an explicit start must always start. Moving
 * the guard in here would silently disable the ticker in every test.
 *
 * The interval lives on `globalThis` so a dev-mode module reload cannot leave
 * two of them running — the same reason `SessionManager` keeps its map there.
 * Unlike that map, it is stored UNCONDITIONALLY: unlike a leaked session map,
 * a second live ticker double-fires jobs.
 */
export const startScheduler = (): void => {
  if (scope.__vaneScheduler) return;

  const interval = setInterval(onTick, TICK_INTERVAL_MS);
  // `unref` so the ticker can never be the reason a short-lived process stays
  // alive — a build or a script that starts it has nothing to tick for, and
  // should exit when its own work is done rather than wait out the interval.
  // This is about process EXIT only: it stops nothing from running, which is
  // why the boot hook's gate is a separate concern (see
  // `shouldStartScheduler` in src/instrumentation.ts).
  unref(interval);

  scope.__vaneScheduler = interval;
  onTick();
};

/**
 * Clears the interval and the guard, so a later `startScheduler` is a fresh
 * start rather than a no-op. Exported for the tests; nothing in production
 * stops the ticker.
 */
export const stopScheduler = (): void => {
  const interval = scope.__vaneScheduler;
  if (!interval) return;
  clearInterval(interval);
  scope.__vaneScheduler = null;
};
