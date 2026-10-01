// @vitest-environment jsdom

// Must precede the component import: see the module for why.
import './mockAnimationsApi';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import JobsView from '../JobsView';
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
    runCount: 1,
    lastRunAt: null,
    nextRunAt: new Date(Date.now() + 7200_000).toISOString(),
    lastError: null,
    optimizationMode: 'balanced',
    sources: ['web'],
    chatModel: null,
    embeddingModel: null,
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
let jobs: ScheduledJob[] = [];

beforeEach(() => {
  jobs = [];
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/scheduler/jobs') return jsonResponse({ jobs });
    if (url === '/api/projects') return jsonResponse({ projects: [] });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('JobsView', () => {
  it('loads the list from the jobs endpoint', async () => {
    jobs = [job({ id: 'job-1' }), job({ id: 'job-2', title: 'Second' })];

    render(<JobsView />);

    await waitFor(() =>
      expect(screen.getByText('AI Act watch')).toBeInTheDocument(),
    );
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/scheduler/jobs');
  });

  it('shows the empty state when there are no jobs', async () => {
    render(<JobsView />);

    await waitFor(() =>
      expect(screen.getByText('No schedules yet')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /create your first schedule/i }),
    ).toBeInTheDocument();
  });

  it('opens the create modal and re-reads the list after a job is added', async () => {
    render(<JobsView />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /new schedule/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/^prompt/i)).toBeVisible(),
    );
    // A second open must not carry the previous form's values over.
    fireEvent.change(screen.getByLabelText(/^prompt/i), {
      target: { value: 'Ask again' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByLabelText(/^prompt/i)).not.toBeInTheDocument(),
    );

    fetchMock.mockImplementation(
      async (url: string, options?: { method?: string }) => {
        if (url === '/api/scheduler/jobs' && options?.method === 'POST') {
          jobs = [...jobs, job({ id: 'job-3', prompt: 'Ask again' })];
          return jsonResponse({ job: jobs[jobs.length - 1] }, 201);
        }
        if (url === '/api/scheduler/jobs') return jsonResponse({ jobs });
        if (url === '/api/projects') return jsonResponse({ projects: [] });
        return jsonResponse({});
      },
    );

    fireEvent.click(screen.getByRole('button', { name: /new schedule/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/^prompt/i)).toHaveValue(''),
    );

    fireEvent.change(screen.getByLabelText(/^prompt/i), {
      target: { value: 'Ask again' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create schedule/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    // The page re-reads the list rather than guessing at the new row.
    await waitFor(() =>
      expect(screen.getByText('Ask again')).toBeInTheDocument(),
    );
  });

  it('edits an existing job through the same modal', async () => {
    jobs = [job({ id: 'job-1', title: 'AI Act watch' })];

    render(<JobsView />);

    await waitFor(() =>
      expect(screen.getByText('AI Act watch')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /edit schedule/i }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /save changes/i }),
      ).toBeVisible(),
    );
    expect(screen.getByLabelText('Title (optional)')).toHaveValue(
      'AI Act watch',
    );
  });

  it('refreshes on demand', async () => {
    render(<JobsView />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    jobs = [job({ id: 'job-9', title: 'Appeared later' })];
    fireEvent.click(screen.getByRole('button', { name: /refresh schedules/i }));

    await waitFor(() =>
      expect(screen.getByText('Appeared later')).toBeInTheDocument(),
    );
  });
});
