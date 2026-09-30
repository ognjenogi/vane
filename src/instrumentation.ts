/**
 * The bits of the environment the boot hook consults before it starts the
 * scheduled-jobs ticker. Named rather than typed as `NodeJS.ProcessEnv` so the
 * predicate below is a pure function of its argument: the global test setup
 * pins `VANE_DISABLE_SCHEDULER` to `'1'`, and the build case is otherwise
 * unreachable from a test.
 */
type SchedulerBootEnv = {
  VANE_DISABLE_SCHEDULER?: string;
  NEXT_PHASE?: string;
  // `process.env` is an index-signature type. Without this line TypeScript's
  // weak-type check refuses to pass it to a parameter whose properties are all
  // optional, so the real caller would not compile.
  [key: string]: string | undefined;
};

/**
 * Whether the boot hook should start the scheduled-jobs ticker. Two reasons to
 * say no, and both are load-bearing:
 *
 * - `VANE_DISABLE_SCHEDULER` — the explicit opt-out for dev and test runs.
 * - `NEXT_PHASE === 'phase-production-build'` — `register()` runs in the nodejs
 *   runtime during `next build` as well as on the server, and nothing tells the
 *   two apart but this. A build on a machine that can reach the database would
 *   otherwise fire every due job as a real paid research turn, and keep firing
 *   them for as long as the build runs. The deployment runs
 *   `docker compose build` on the live server, with real provider keys.
 *
 * Only the production-build phase is excluded: the other phases name a server
 * or a test run, which is where the ticker belongs.
 */
export const shouldStartScheduler = (env: SchedulerBootEnv): boolean =>
  !env.VANE_DISABLE_SCHEDULER && env.NEXT_PHASE !== 'phase-production-build';

export const register = async () => {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      console.log('Running database migrations...');
      await import('./lib/db/migrate');
      console.log('Database migrations completed successfully');
    } catch (error) {
      console.error('Failed to run database migrations:', error);
    }

    await import('./lib/config/index');

    // The scheduled-jobs ticker, for the same reason the migrations are: only
    // now that the schema exists. Skipped during a production build, and behind
    // the same `try` — importing the module builds a `SchedulerManager` over the
    // `@/lib/db` singleton, and this boot hook must not be what takes a server
    // down. The env vars are read HERE and nowhere else, so an explicit
    // `startScheduler()` call always starts (see its docstring).
    if (shouldStartScheduler(process.env)) {
      try {
        const { startScheduler } = await import('./lib/scheduler/scheduler');
        console.log('Starting the scheduled-jobs ticker...');
        startScheduler();
      } catch (error) {
        console.error('Failed to start the scheduler:', error);
      }
    }
  }
};
