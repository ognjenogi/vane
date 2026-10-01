// @vitest-environment jsdom

// Must precede the component import: see the module for why.
import '../../Scheduler/__tests__/mockAnimationsApi';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import Schedule from '../Schedule';

const openButton = () =>
  screen.getByRole('button', { name: /schedule this prompt/i });
const promptField = () => screen.getByLabelText(/^prompt/i);

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ projects: [] }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Schedule', () => {
  it('captures what the user types into the dialog', () => {
    render(<Schedule message="" />);

    fireEvent.click(openButton());

    fireEvent.change(promptField(), { target: { value: 'Ask about X' } });

    expect(promptField()).toHaveValue('Ask about X');
  });

  /**
   * The exact bug: this component is mounted on the chat page's first render,
   * so `CreateJobModal`'s one-shot form seeding ran long before the user typed
   * anything, and the prompt arrived empty.
   */
  it('shows the message prop in the prompt field when it is opened', () => {
    const { rerender } = render(<Schedule message="" />);

    rerender(<Schedule message="Track EU AI Act enforcement news" />);
    fireEvent.click(openButton());

    expect(promptField()).toHaveValue('Track EU AI Act enforcement news');
  });

  /**
   * Re-opening re-seeds from the CURRENT prop rather than keeping the
   * abandoned draft: the source of truth for this dialog is what is in the
   * chat input, and scheduling never edits that input. Re-opening the same
   * component must therefore show what is typed now, not what was typed into
   * a dialog that was thrown away — and not an empty form.
   */
  it('re-seeds the prompt from the current message when re-opened', async () => {
    const { rerender } = render(<Schedule message="First prompt" />);

    fireEvent.click(openButton());
    expect(promptField()).toHaveValue('First prompt');

    // A draft the user abandoned by cancelling.
    fireEvent.change(promptField(), { target: { value: 'Abandoned draft' } });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByLabelText(/^prompt/i)).toBeNull());

    rerender(<Schedule message="Second prompt" />);
    fireEvent.click(openButton());

    expect(promptField()).toHaveValue('Second prompt');
  });

  it('leaves the dialog closed until the button is clicked', () => {
    render(<Schedule message="Anything" />);

    expect(screen.queryByLabelText(/^prompt/i)).toBeNull();
  });
});
