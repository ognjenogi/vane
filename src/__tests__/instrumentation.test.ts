import { describe, expect, it } from 'vitest';
import { shouldStartScheduler } from '@/instrumentation';

/**
 * `next build` runs `register()` in the nodejs runtime exactly as the server
 * does, with no way to tell the two apart except `NEXT_PHASE`
 * (`node_modules/next/dist/build/index.js` sets it to `phase-production-build`).
 * On a deployment machine that can reach the database, a ticker started by a
 * build fires every due job as a real paid research turn. `unref()` does not
 * help: it only lets the build exit, after those runs have happened.
 *
 * The predicate takes the environment as an argument instead of reading
 * `process.env`, because the global test setup pins `VANE_DISABLE_SCHEDULER` to
 * `'1'` and the build case is therefore unreachable from a test otherwise.
 */
describe('shouldStartScheduler', () => {
  it('starts in a real server: neither reason to skip', () => {
    expect(shouldStartScheduler({})).toBe(true);
  });

  it('skips when the operator opted out', () => {
    expect(shouldStartScheduler({ VANE_DISABLE_SCHEDULER: '1' })).toBe(false);
  });

  it('skips during a production build, the case that fired real jobs', () => {
    expect(shouldStartScheduler({ NEXT_PHASE: 'phase-production-build' })).toBe(
      false,
    );
  });

  it('skips during a build even without the opt-out set', () => {
    expect(
      shouldStartScheduler({
        NEXT_PHASE: 'phase-production-build',
        VANE_DISABLE_SCHEDULER: undefined,
      }),
    ).toBe(false);
  });

  it('skips when both reasons apply at once', () => {
    expect(
      shouldStartScheduler({
        NEXT_PHASE: 'phase-production-build',
        VANE_DISABLE_SCHEDULER: '1',
      }),
    ).toBe(false);
  });

  it('still starts in every other build phase', () => {
    // `NEXT_PHASE` names the phase, not a boolean: a build worker that is not
    // doing the production build must not lose the ticker.
    for (const phase of [
      'phase-development-server',
      'phase-export',
      'phase-test',
      'phase-production-server',
    ]) {
      expect(shouldStartScheduler({ NEXT_PHASE: phase })).toBe(true);
    }
  });
});
