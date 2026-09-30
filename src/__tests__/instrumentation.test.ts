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
 * The opt-out itself is read by PRESENCE, not by value: setting
 * `VANE_DISABLE_SCHEDULER` at all disables the ticker, whatever it is set to,
 * including the empty string. `skips when the opt-out is set to ANY value…`
 * below pins that; do not read it as "set to a non-empty value".
 *
 * The predicate takes the environment as an argument instead of reading
 * `process.env`, because the global test setup pins `VANE_DISABLE_SCHEDULER` to
 * `'1'` and the build case is therefore unreachable from a test otherwise.
 */
describe('shouldStartScheduler', () => {
  it('starts in a real server: neither reason to skip', () => {
    expect(shouldStartScheduler({})).toBe(true);
  });

  it('skips when the opt-out is set to ANY value, including a degenerate one', () => {
    // Fail CLOSED. The flag is read by PRESENCE, not by value, because the two
    // ways to be wrong are not symmetric: an unrecognised spelling would leave
    // the ticker running and firing paid research turns on a box whose operator
    // believes they turned it off, while a recognised one costs a single MISSED
    // scheduled run — silent, but free.
    //
    // So `VANE_DISABLE_SCHEDULER=` (a bare `=` in a compose file or a
    // Dockerfile) and the other spellings people reach for when they think they
    // are being clever all read as OFF. The value is never interpreted.
    for (const value of ['1', '0', 'false', 'true', '', 'no', ' ']) {
      expect(shouldStartScheduler({ VANE_DISABLE_SCHEDULER: value })).toBe(
        false,
      );
    }
  });

  it('skips during a production build', () => {
    // The build-phase reason on its own: no opt-out needed, and the opt-out is
    // not the reason this is false.
    expect(shouldStartScheduler({ NEXT_PHASE: 'phase-production-build' })).toBe(
      false,
    );
    // Two independent reasons: a build is skipped with the variable absent, and
    // a degenerate value does not weaken the build check either.
    expect(
      shouldStartScheduler({
        NEXT_PHASE: 'phase-production-build',
        VANE_DISABLE_SCHEDULER: '',
      }),
    ).toBe(false);
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
