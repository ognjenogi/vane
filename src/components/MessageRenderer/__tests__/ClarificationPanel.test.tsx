// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ClarificationPanel, {
  buildClarifiedMessage,
} from '../ClarificationPanel';

const QUESTIONS = [
  'Which release are you interested in?',
  'Do you want the changelog or the upgrade guide?',
];

const type = (question: string, value: string) => {
  fireEvent.change(screen.getByLabelText(question), { target: { value } });
};

const submitButton = () =>
  screen.getByRole('button', { name: /answer & research/i });
const skipButton = () => screen.getByRole('button', { name: /^skip$/i });

afterEach(() => {
  cleanup();
});

describe('ClarificationPanel', () => {
  it('renders one labelled input per question', () => {
    render(
      <ClarificationPanel
        questions={QUESTIONS}
        interactive={true}
        loading={false}
        onSubmit={vi.fn()}
      />,
    );

    for (const question of QUESTIONS) {
      expect(screen.getByLabelText(question)).toBeInTheDocument();
    }
    expect(submitButton()).toBeEnabled();
    expect(skipButton()).toBeEnabled();
    // Neither button may fall back to type="submit" and reload the page.
    expect(submitButton()).toHaveAttribute('type', 'button');
    expect(skipButton()).toHaveAttribute('type', 'button');
  });

  it('submits every answered question', () => {
    const onSubmit = vi.fn();
    render(
      <ClarificationPanel
        questions={QUESTIONS}
        interactive={true}
        loading={false}
        onSubmit={onSubmit}
      />,
    );

    type(QUESTIONS[0], 'v2.1.0');
    type(QUESTIONS[1], 'the upgrade guide');
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith({
      skipped: false,
      answers: [
        { question: QUESTIONS[0], answer: 'v2.1.0' },
        { question: QUESTIONS[1], answer: 'the upgrade guide' },
      ],
    });
  });

  it('omits a blank answer instead of sending an empty string', () => {
    const onSubmit = vi.fn();
    render(
      <ClarificationPanel
        questions={QUESTIONS}
        interactive={true}
        loading={false}
        onSubmit={onSubmit}
      />,
    );

    type(QUESTIONS[0], 'v2.1.0');
    // QUESTIONS[1] deliberately left blank
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith({
      skipped: false,
      answers: [{ question: QUESTIONS[0], answer: 'v2.1.0' }],
    });
  });

  it('treats a whitespace-only answer as blank', () => {
    const onSubmit = vi.fn();
    render(
      <ClarificationPanel
        questions={QUESTIONS}
        interactive={true}
        loading={false}
        onSubmit={onSubmit}
      />,
    );

    type(QUESTIONS[0], '   ');
    type(QUESTIONS[1], '  the upgrade guide  ');
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith({
      skipped: false,
      answers: [{ question: QUESTIONS[1], answer: 'the upgrade guide' }],
    });
  });

  it('sends an empty answers array when nothing was answered', () => {
    const onSubmit = vi.fn();
    render(
      <ClarificationPanel
        questions={QUESTIONS}
        interactive={true}
        loading={false}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith({ skipped: false, answers: [] });
  });

  it('skips without sending answers', () => {
    const onSubmit = vi.fn();
    render(
      <ClarificationPanel
        questions={QUESTIONS}
        interactive={true}
        loading={false}
        onSubmit={onSubmit}
      />,
    );

    type(QUESTIONS[0], 'v2.1.0');
    fireEvent.click(skipButton());

    expect(onSubmit).toHaveBeenCalledWith({ skipped: true });
  });

  it('is read-only when a later turn exists', () => {
    const onSubmit = vi.fn();
    render(
      <ClarificationPanel
        questions={QUESTIONS}
        interactive={false}
        loading={false}
        onSubmit={onSubmit}
      />,
    );

    for (const question of QUESTIONS) {
      expect(screen.getByLabelText(question)).toBeDisabled();
    }
    expect(submitButton()).toBeDisabled();
    expect(skipButton()).toBeDisabled();
  });

  it('is read-only while a stream is in flight', () => {
    const onSubmit = vi.fn();
    render(
      <ClarificationPanel
        questions={QUESTIONS}
        interactive={true}
        loading={true}
        onSubmit={onSubmit}
      />,
    );

    for (const question of QUESTIONS) {
      expect(screen.getByLabelText(question)).toBeDisabled();
    }
    expect(submitButton()).toBeDisabled();
    expect(skipButton()).toBeDisabled();

    fireEvent.click(submitButton());
    fireEvent.click(skipButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/**
 * The outgoing message content is what the user's turn renders as, so the
 * answers they typed have to be part of it and not just the payload.
 */
describe('buildClarifiedMessage', () => {
  const QUERY = 'compare the v1 and v2 release notes';

  it('appends every answered pair to the query', () => {
    expect(
      buildClarifiedMessage(QUERY, {
        skipped: false,
        answers: [
          { question: QUESTIONS[0], answer: 'v2.1.0' },
          { question: QUESTIONS[1], answer: 'the upgrade guide' },
        ],
      }),
    ).toBe(
      [
        QUERY,
        '',
        `Q: ${QUESTIONS[0]}`,
        'A: v2.1.0',
        '',
        `Q: ${QUESTIONS[1]}`,
        'A: the upgrade guide',
      ].join('\n'),
    );
  });

  it('omits blank answers and trims the rest', () => {
    expect(
      buildClarifiedMessage(QUERY, {
        skipped: false,
        answers: [
          { question: QUESTIONS[0], answer: '   ' },
          { question: QUESTIONS[1], answer: '  the upgrade guide  ' },
        ],
      }),
    ).toBe(
      [QUERY, '', `Q: ${QUESTIONS[1]}`, 'A: the upgrade guide'].join('\n'),
    );
  });

  it('leaves the query alone when nothing was answered', () => {
    expect(buildClarifiedMessage(QUERY, { skipped: false, answers: [] })).toBe(
      QUERY,
    );

    expect(
      buildClarifiedMessage(QUERY, {
        skipped: false,
        answers: [{ question: QUESTIONS[0], answer: '  ' }],
      }),
    ).toBe(QUERY);
  });

  it('leaves the query alone when the questions were skipped', () => {
    expect(
      buildClarifiedMessage(QUERY, {
        skipped: true,
        answers: [{ question: QUESTIONS[0], answer: 'v2.1.0' }],
      }),
    ).toBe(QUERY);
  });
});
