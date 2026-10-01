// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import JobCard from '../JobCard';
import type { ScheduledJob } from '@/lib/scheduler/types';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const CHAT_MODEL = { providerId: 'openai', key: 'gpt-4o' };

const job = (overrides: Partial<ScheduledJob> = {}): ScheduledJob =>
  ({
    id: 'job-1',
    title: 'AI Act watch',
    prompt: 'Track EU AI Act enforcement news',
    chatId: 'chat-1',
    intervalMinutes: 1440,
    endType: 'never',
    maxRuns: null,
    runUntil: null,
    status: 'active',
    runCount: 3,
    lastRunAt: '2026-01-01T00:00:00.000Z',
    nextRunAt: new Date(Date.now() + 7200_000).toISOString(),
    lastError: null,
    optimizationMode: 'balanced',
    sources: ['web'],
    chatModel: CHAT_MODEL,
    embeddingModel: CHAT_MODEL,
    projectId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as ScheduledJob;

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

const runNowButton = () => screen.getByRole('button', { name: /run now/i });
const callFor = (url: string) =>
  fetchMock.mock.calls.find(([called]) => called === url);

const renderCard = (overrides: Partial<ScheduledJob> = {}) => {
  const onChanged = vi.fn();
  const onEdit = vi.fn();
  render(
    <JobCard job={job(overrides)} onChanged={onChanged} onEdit={onEdit} />,
  );
  return { onChanged, onEdit };
};

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
    if (url === '/api/scheduler/jobs/job-1/run' && options?.method === 'POST') {
      return jsonResponse({}, 202);
    }
    if (url === '/api/scheduler/jobs/job-1' && options?.method === 'PATCH') {
      return jsonResponse({ job: job() });
    }
    if (url === '/api/scheduler/jobs/job-1' && options?.method === 'DELETE') {
      return jsonResponse({}, 204);
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('JobCard', () => {
  it('shows the title, prompt, interval, run count and next run for an active job', () => {
    renderCard();

    expect(screen.getByText('AI Act watch')).toBeInTheDocument();
    expect(
      screen.getByText(/Track EU AI Act enforcement news/),
    ).toBeInTheDocument();
    expect(screen.getByText(/every day/i)).toBeInTheDocument();
    expect(screen.getByText('3 runs')).toBeInTheDocument();
    expect(screen.getByText(/next run in 1 hour/i)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('offers Run now and Pause while active', () => {
    renderCard({ status: 'active' });

    expect(runNowButton()).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^pause$/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
  });

  it('offers Resume while paused', () => {
    renderCard({ status: 'paused' });

    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pause$/i })).toBeNull();
  });

  it('hides Run now once the job is completed', () => {
    renderCard({ status: 'completed', runCount: 5, maxRuns: 5 });

    expect(screen.queryByRole('button', { name: /run now/i })).toBeNull();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('links to the chat the job appends to', () => {
    renderCard();

    expect(screen.getByRole('link', { name: /open chat/i })).toHaveAttribute(
      'href',
      '/c/chat-1',
    );
  });

  it('posts to the run endpoint when Run now is clicked', async () => {
    const { onChanged } = renderCard({ status: 'active' });

    fireEvent.click(runNowButton());

    await waitFor(() =>
      expect(callFor('/api/scheduler/jobs/job-1/run')).toBeDefined(),
    );
    const call = callFor('/api/scheduler/jobs/job-1/run')!;
    expect((call[1] as { method: string }).method).toBe('POST');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('pauses an active job', async () => {
    const { onChanged } = renderCard({ status: 'active' });

    fireEvent.click(screen.getByRole('button', { name: /^pause$/i }));

    await waitFor(() =>
      expect(callFor('/api/scheduler/jobs/job-1')).toBeDefined(),
    );
    const call = callFor('/api/scheduler/jobs/job-1')!;
    expect((call[1] as { method: string }).method).toBe('PATCH');
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({
      status: 'paused',
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('resumes a paused job', async () => {
    renderCard({ status: 'paused' });

    fireEvent.click(screen.getByRole('button', { name: /resume/i }));

    await waitFor(() => {
      const call = callFor('/api/scheduler/jobs/job-1');
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as { body: string }).body)).toEqual({
        status: 'active',
      });
    });
  });

  it('shows the run cap and the end date alongside the run count', () => {
    const { unmount } = render(
      <JobCard
        job={job({ endType: 'count', maxRuns: 10 })}
        onChanged={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText('3 / 10 runs')).toBeInTheDocument();
    unmount();

    render(
      <JobCard
        job={job({ endType: 'date', runUntil: '2027-02-01T09:30:00.000Z' })}
        onChanged={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText(/3 runs · until /i)).toBeInTheDocument();
  });

  it('shows the last error in red when a run failed', () => {
    renderCard({ lastError: 'No chat model configured' });

    const error = screen.getByText('No chat model configured');
    expect(error).toBeInTheDocument();
    // Red, so a failed run is not mistaken for metadata.
    expect(error.closest('p')?.className).toMatch(/text-red-600/);
  });

  it('asks the owner to edit rather than editing inline', () => {
    const { onEdit } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: /edit schedule/i }));

    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
    );
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    // jsdom's `confirm` is a no-op, so it has to be answered explicitly.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onChanged } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: /delete schedule/i }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(callFor('/api/scheduler/jobs/job-1')).toBeUndefined();
    expect(onChanged).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('deletes the job once the confirmation is accepted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onChanged } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: /delete schedule/i }));

    await waitFor(() =>
      expect(callFor('/api/scheduler/jobs/job-1')).toBeDefined(),
    );
    const call = callFor('/api/scheduler/jobs/job-1')!;
    expect((call[1] as { method: string }).method).toBe('DELETE');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    confirmSpy.mockRestore();
  });
});
