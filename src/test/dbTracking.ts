/**
 * Test-only plumbing for better-sqlite3's native teardown abort. Not a test.
 *
 * better-sqlite3 11.10 (on Node 24.21) registers a node environment cleanup
 * hook for every native `Statement` it creates and removes it again from
 * `Statement::~Statement()`. If such a `Statement` is finalized after the
 * environment is gone, that removal runs against a null environment and node
 * aborts the worker outright:
 *
 *     node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
 *     Assertion failed: (env) != nullptr
 *
 * Vitest reports it as `Worker forks emitted error`, drops that file's results
 * and exits non-zero even though every assertion passed. It only fires on runs
 * where the collecting GC happens to be one that finalizes native objects off
 * the main thread, which is why it looks like a ~20% flake.
 *
 * Nothing a test does afterwards can prevent it, so this module keeps every
 * `Statement` reachable for the life of the worker. Measured: 200 prepared
 * statements abandoned to the GC abort 12/12 runs, the same 200 retained
 * abort 0/12. `db.close()` does not help on its own — it finalizes the sqlite3
 * handle but leaves the JS wrapper for the GC.
 *
 * The mock also records the `Database` handles, because two production modules
 * open one at import time and never close it (`src/lib/db/index.ts`,
 * `src/lib/db/migrate.ts`), which a test cannot otherwise reach.
 */
import { vi } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

type SqliteDatabase = BetterSqlite3.Database;
type SqliteConstructor = new (
  filename?: string,
  options?: BetterSqlite3.Options,
) => SqliteDatabase;
type SqliteModule = { default: SqliteConstructor } & Record<string, unknown>;
type Registry = { databases: SqliteDatabase[]; statements: unknown[] };

/**
 * The registry lives on the worker's `globalThis` rather than on this module's
 * own scope because `vi.resetModules()` re-evaluates this module: a test that
 * resets the registry (to re-import something that resolves `DATA_DIR` at
 * import time) would otherwise leave the factory writing into a stale array
 * while the test closed a different one.
 */
const REGISTRY_KEY = '__vaneTrackedSqliteHandles__';

const registry = (): Registry => {
  const scope = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: Registry;
  };
  return (scope[REGISTRY_KEY] ??= { databases: [], statements: [] });
};

/**
 * The `vi.mock('better-sqlite3', ...)` factory. Pass it as
 * `() => import('@/test/dbTracking').then((m) => m.betterSqliteMockFactory())`
 * so the factory body runs after hoisting, and both lists below are the ones
 * `closeTrackedDatabases()` reads.
 *
 * The real module is wrapped, never replaced, so production modules keep real
 * sqlite behaviour. `Proxy` over the constructor keeps `Database.prototype`
 * (so `instanceof` still holds), the static `SqliteError`, and the identity of
 * the objects handed out.
 */
export async function betterSqliteMockFactory(): Promise<SqliteModule> {
  const actual = (await vi.importActual<unknown>(
    'better-sqlite3',
  )) as SqliteModule;
  const tracked = registry();

  const TrackedDatabase = new Proxy(actual.default, {
    construct(target, args, newTarget) {
      const database = Reflect.construct(target, args, newTarget);
      tracked.databases.push(database);
      return database;
    },
  });

  const prototype = actual.default.prototype as {
    prepare?: (source: string) => unknown;
    iterate?: (source: string) => unknown;
  };

  const retain = (
    original: (source: string) => unknown,
  ): ((this: SqliteDatabase, source: string) => unknown) =>
    function (this: SqliteDatabase, source: string) {
      const statement = original.call(this, source);
      tracked.statements.push(statement);
      return statement;
    };

  if (prototype.prepare) prototype.prepare = retain(prototype.prepare);
  if (prototype.iterate) prototype.iterate = retain(prototype.iterate);

  return { ...actual, default: TrackedDatabase };
}

/**
 * Closes every `Database` opened while this worker ran the current test file,
 * including the module-private ones production code opened at import time.
 *
 * Safe to call more than once, and safe on a handle a test already closed:
 * better-sqlite3 throws "The database connection is not open" from a second
 * `close()`, so the open flag is checked first.
 */
export function closeTrackedDatabases(): void {
  const tracked = registry();
  while (tracked.databases.length > 0) {
    const database = tracked.databases.pop()!;
    if (database.open) {
      database.close();
    }
  }
}
