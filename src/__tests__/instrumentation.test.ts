import { describe, expect, it } from 'vitest';
import { shouldStartScheduler } from '@/instrumentation';

/**
 * Why the build-phase branch of the gate exists at all: Next has historically
 * invoked `register()` during `next build` as well as on the server, and older
 * versions still do. On a deployment machine that can reach the database, a
 * ticker started by a build fires every due job as a real paid research turn,
 * and `unref()` does not help — it only lets the build exit, after those runs
 * have happened.
 *
 * On the installed Next (16.2.2) this is latent rather than live: it
 * short-circuits in `registerInstrumentation` before calling `register()`, so
 * the gate is not what prevents it today. The gate stays anyway — it is Next's
 * own idiom, it costs one comparison, and `package.json` pins a caret range —
 * so these tests pin the DECISION, which is the part this repo owns, and not a
 * claim about which Next version is installed.
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

  it('skips during a production build', () => {
    // The build-phase reason on its own: no opt-out needed, and the opt-out is
    // not the reason this is false.
    expect(shouldStartScheduler({ NEXT_PHASE: 'phase-production-build' })).toBe(
      false,
    );
  });

  it('treats a PRESENT-BUT-EMPTY opt-out as not set', () => {
    // `VANE_DISABLE_SCHEDULER=` in a compose file or a Dockerfile sets the
    // variable to the empty string, and `!''` is `true` — so a bare `=` leaves
    // the ticker RUNNING. That is the wrong way round for a safety flag, and it
    // is pinned here deliberately: the behaviour is real, and the test file is
    // where a reader who assumes otherwise is most likely to be.
    //
    // Fixing it means reading presence (`in`) rather than the value, which is a
    // behaviour change to the gate and therefore out of scope for a comment-only
    // round. It is the one thing in this file I would change next.
    expect(shouldStartScheduler({ VANE_DISABLE_SCHEDULER: '' })).toBe(true);
    // The build phase is still independent of the value, so a build is skipped
    // either way.
    expect(
      shouldStartScheduler({
        VANE_DISABLE_SCHEDULER: '',
        NEXT_PHASE: 'phase-production-build',
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
    // `NEXT_PHASE` names the phase, not a boolean, so the gate must not treat
    // "some phase is set" as "a build is happening". Anything but
    // `phase-production-build` is left alone — which also means `next start`
    // (where Next never sets it at all) is unaffected.
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
