import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });

  it('loads the setup file', () => {
    expect(process.env.VANE_DISABLE_SCHEDULER).toBe('1');
  });
});
