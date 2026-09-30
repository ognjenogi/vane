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
 * - `NEXT_PHASE === 'phase-production-build'` — a build is a context where this
 *   boot hook could run but no server ever serves from, so starting a ticker
 *   there has nothing to tick for and can only cost money: on a machine that
 *   can reach the database it would fire every due job as a real paid research
 *   turn. The deployment runs `docker compose build` on the live server, with
 *   real provider keys.
 *
 *   Version-dependent, and currently latent: Next 16.2.2 short-circuits in
 *   `registerInstrumentation` before it calls `register()`
 *   (`node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js`,
 *   "Ensure registerInstrumentation is not called in production build"), so this
 *   branch is not what stops a build today — nothing is. Older Next versions
 *   invoked the hook during a build, and `package.json` pins `"next": "^16.0.7"`,
 *   so the check is kept as Next's own idiom rather than trusted either way:
 *   it costs one comparison and does not depend on which version gets installed.
 *   `build/index.js` is where `NEXT_PHASE` is SET, not where `register()` runs.
 *
 * Only the production-build phase is excluded: the other phases name a server
 * or a test run, which is where the ticker belongs. `NEXT_PHASE` is assigned in
 * exactly one place in Next (`dist/build/index.js`), so `next start` never sees
 * it and this gate cannot disable the ticker in production.
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
    // now that the schema exists. Skipped during a production build (see
    // `shouldStartScheduler`), and behind the same `try` — importing the module
    // builds a `SchedulerManager` over the
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
