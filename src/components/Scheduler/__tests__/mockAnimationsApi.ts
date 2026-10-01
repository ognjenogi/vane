/**
 * `Element.prototype.getAnimations` is missing in jsdom, so Headless UI
 * installs a `console.warn`-on-every-call fallback of its own at IMPORT time.
 * Defining a real one before that import keeps the suite output clean, and
 * costs nothing: nothing here asserts on animations.
 *
 * The import must come first in each test file — ESM evaluates imports in
 * order, so this module runs before `@headlessui/react` is loaded.
 */
if (
  typeof Element !== 'undefined' &&
  Element.prototype.getAnimations === undefined
) {
  Element.prototype.getAnimations = () => [];
}

export {};
