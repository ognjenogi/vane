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
import CreateJobModal from '../CreateJobModal';
import type { ScheduledJob } from '@/lib/scheduler/types';

const CHAT_MODEL = { providerId: 'openai', key: 'gpt-4o' };
const EMBEDDING_MODEL = { providerId: 'openai', key: 'text-embedding-3-small' };

const PROMPT = 'Track EU AI Act enforcement news';

const jobResponse = (job: Partial<ScheduledJob>): ScheduledJob =>
  ({
    id: 'job-1',
    title: 'AI Act watch',
    prompt: PROMPT,
    chatId: 'chat-1',
    intervalMinutes: 1440,
    endType: 'never',
    maxRuns: null,
    runUntil: null,
    status: 'active',
    runCount: 0,
    lastRunAt: null,
    nextRunAt: new Date(Date.now() + 7200_000).toISOString(),
    lastError: null,
    optimizationMode: 'balanced',
    sources: ['web'],
    chatModel: CHAT_MODEL,
    embeddingModel: EMBEDDING_MODEL,
    projectId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...job,
  }) as ScheduledJob;

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

const jobsCall = (url: string, method?: string) =>
  fetchMock.mock.calls.find(
    ([called, options]) =>
      called === url && (method ? options?.method === method : true),
  );

const bodyOf = (call: unknown[]) =>
  JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

const createSubmit = () =>
  screen.getByRole('button', { name: /create schedule/i });
const editSubmit = () => screen.getByRole('button', { name: /save changes/i });

const setModels = () => {
  localStorage.setItem('chatModelProviderId', CHAT_MODEL.providerId);
  localStorage.setItem('chatModelKey', CHAT_MODEL.key);
  localStorage.setItem('embeddingModelProviderId', EMBEDDING_MODEL.providerId);
  localStorage.setItem('embeddingModelKey', EMBEDDING_MODEL.key);
};

/**
 * A value an `<input type="datetime-local">` accepts, `daysAhead` in the
 * future. Computed rather than hardcoded so the test cannot start failing on
 * its own date, and in LOCAL time because that is what the control means.
 */
const localDateTimeInput = (daysAhead: number) => {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** The same, as the stored instant a `datetime-local` control can round-trip. */
const minuteAlignedISO = (daysAhead: number) => {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  date.setSeconds(0, 0);
  return date.toISOString();
};

beforeEach(() => {
  localStorage.clear();
  setModels();
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/projects') return jsonResponse({ projects: [] });
    if (url === '/api/scheduler/jobs') {
      return jsonResponse({ job: jobResponse({}) }, 201);
    }
    if (url === '/api/scheduler/jobs/job-1') {
      return jsonResponse({ job: jobResponse({}) });
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CreateJobModal', () => {
  it('renders the create form with one labelled control per field', () => {
    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        initialPrompt=""
      />,
    );

    expect(screen.getByLabelText(/^prompt/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Title (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('Runs every')).toBeInTheDocument();
    expect(screen.getByLabelText('Interval unit')).toBeInTheDocument();
    expect(screen.getByLabelText('Forever')).toBeInTheDocument();
    expect(screen.getByLabelText('After N runs')).toBeInTheDocument();
    expect(screen.getByLabelText('Until a date')).toBeInTheDocument();
    expect(screen.getByLabelText('Optimization mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Web')).toBeInTheDocument();
    expect(createSubmit()).toBeEnabled();

    // Defaults the required payload is built from.
    expect(screen.getByLabelText('Runs every')).toHaveValue(1);
    expect(screen.getByLabelText('Interval unit')).toHaveValue('days');
    expect(screen.getByLabelText('Optimization mode')).toHaveValue('balanced');
    expect(screen.getByLabelText('Web')).toBeChecked();
  });

  it('posts the defaults, with the selected models, on submit', async () => {
    const onCreated = vi.fn();
    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={onCreated}
        initialPrompt={PROMPT}
      />,
    );

    expect(screen.getByLabelText(/^prompt/i)).toHaveValue(PROMPT);
    fireEvent.click(createSubmit());

    const call = jobsCall('/api/scheduler/jobs', 'POST');
    expect(call).toBeDefined();

    const [url, options] = call as [string, { method: string; body: string }];
    expect(url).toBe('/api/scheduler/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      prompt: PROMPT,
      intervalMinutes: 1440,
      endType: 'never',
      optimizationMode: 'balanced',
      sources: ['web'],
      chatModel: CHAT_MODEL,
      embeddingModel: EMBEDDING_MODEL,
    });

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('converts the interval with its unit', async () => {
    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        initialPrompt={PROMPT}
      />,
    );

    fireEvent.change(screen.getByLabelText('Runs every'), {
      target: { value: '15' },
    });
    fireEvent.change(screen.getByLabelText('Interval unit'), {
      target: { value: 'minutes' },
    });
    fireEvent.click(createSubmit());

    const body = bodyOf(jobsCall('/api/scheduler/jobs', 'POST')!);
    expect(body.intervalMinutes).toBe(15);
  });

  it('sends runUntil as a full ISO instant when the end type is a date', async () => {
    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        initialPrompt={PROMPT}
      />,
    );

    fireEvent.click(screen.getByLabelText('Until a date'));
    const localValue = localDateTimeInput(30);
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: localValue },
    });
    fireEvent.click(createSubmit());

    const body = bodyOf(jobsCall('/api/scheduler/jobs', 'POST')!);
    expect(body.endType).toBe('date');
    // `z.iso.datetime({ offset: true })` rejects the zone-less value
    // `<input type="datetime-local">` hands back, so it has to be converted
    // to an explicit instant first.
    expect(body.runUntil).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // A date-time form with no offset is parsed as local time, which is the
    // zone the input was typed in — the same instant, so the round trip holds.
    expect(body.runUntil).toBe(new Date(localValue).toISOString());
  });

  it('sends maxRuns when the end type is a count', async () => {
    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        initialPrompt={PROMPT}
      />,
    );

    fireEvent.click(screen.getByLabelText('After N runs'));
    fireEvent.change(screen.getByLabelText('Number of runs'), {
      target: { value: '3' },
    });
    fireEvent.click(createSubmit());

    const body = bodyOf(jobsCall('/api/scheduler/jobs', 'POST')!);
    expect(body.endType).toBe('count');
    expect(body.maxRuns).toBe(3);
    expect(body).not.toHaveProperty('runUntil');
  });

  it('blocks submit with inline validation when a count has no runs value', () => {
    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        initialPrompt={PROMPT}
      />,
    );

    fireEvent.click(screen.getByLabelText('After N runs'));
    fireEvent.click(createSubmit());

    expect(jobsCall('/api/scheduler/jobs', 'POST')).toBeUndefined();
    expect(screen.getByText(/enter the number of runs/i)).toBeInTheDocument();
  });

  it('blocks submit with inline validation when a date has no value', () => {
    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        initialPrompt={PROMPT}
      />,
    );

    fireEvent.click(screen.getByLabelText('Until a date'));
    fireEvent.click(createSubmit());

    expect(jobsCall('/api/scheduler/jobs', 'POST')).toBeUndefined();
    expect(screen.getByText(/choose an end date/i)).toBeInTheDocument();
  });

  it('blocks submit with inline validation when the prompt is empty', () => {
    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        initialPrompt="   "
      />,
    );

    fireEvent.click(createSubmit());

    expect(jobsCall('/api/scheduler/jobs', 'POST')).toBeUndefined();
    expect(screen.getByText(/prompt must not be empty/i)).toBeInTheDocument();
  });

  it('surfaces a 400 message inline instead of failing silently', async () => {
    const onCreated = vi.fn();
    fetchMock.mockImplementation(
      async (url: string, options?: { method?: string }) => {
        if (url === '/api/projects') return jsonResponse({ projects: [] });
        if (url === '/api/scheduler/jobs' && options?.method === 'POST') {
          return jsonResponse(
            {
              message: 'Invalid request body',
              error: [
                { path: 'runUntil', message: 'runUntil must be in the future' },
              ],
            },
            400,
          );
        }
        return jsonResponse({});
      },
    );

    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={onCreated}
        initialPrompt={PROMPT}
      />,
    );

    fireEvent.click(createSubmit());

    await waitFor(() =>
      expect(
        screen.getByText('runUntil must be in the future'),
      ).toBeInTheDocument(),
    );
    expect(onCreated).not.toHaveBeenCalled();
    // Still open, so the user can correct the value.
    expect(createSubmit()).toBeInTheDocument();
  });

  it('pre-fills from the job and patches only the changed fields', async () => {
    const onCreated = vi.fn();
    const job = jobResponse({
      title: 'AI Act watch',
      prompt: 'Old prompt',
      intervalMinutes: 120,
      endType: 'count',
      maxRuns: 5,
      runCount: 1,
    });

    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={onCreated}
        job={job}
      />,
    );

    expect(screen.getByLabelText(/^prompt/i)).toHaveValue('Old prompt');
    expect(screen.getByLabelText('Title (optional)')).toHaveValue(
      'AI Act watch',
    );
    // `120` minutes pre-fills as the largest unit that divides it exactly.
    expect(screen.getByLabelText('Runs every')).toHaveValue(2);
    expect(screen.getByLabelText('Interval unit')).toHaveValue('hours');
    expect(screen.getByLabelText('After N runs')).toBeChecked();
    expect(screen.getByLabelText('Number of runs')).toHaveValue(5);
    expect(screen.getByLabelText('Optimization mode')).toHaveValue('balanced');

    fireEvent.change(screen.getByLabelText(/^prompt/i), {
      target: { value: 'New prompt' },
    });
    fireEvent.click(editSubmit());

    const call = jobsCall('/api/scheduler/jobs/job-1', 'PATCH');
    expect(call).toBeDefined();
    // Everything else is unchanged, so a key-presence merge must not receive it.
    expect(bodyOf(call!)).toEqual({ prompt: 'New prompt' });

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('never sends runUntil: null when a date job is switched to forever', async () => {
    const job = jobResponse({
      endType: 'date',
      runUntil: minuteAlignedISO(30),
    });

    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        job={job}
      />,
    );

    expect(screen.getByLabelText('Until a date')).toBeChecked();
    // Pre-filled in local wall-clock time, which is what the control takes,
    // and it is the same instant as the stored one.
    const prefill = (screen.getByLabelText('End date') as HTMLInputElement)
      .value;
    expect(prefill).toMatch(/^20\d\d-\d\d-\d\dT\d\d:\d\d$/);
    expect(new Date(prefill).toISOString()).toBe(job.runUntil);

    fireEvent.click(screen.getByLabelText('Forever'));
    fireEvent.click(editSubmit());

    const body = bodyOf(jobsCall('/api/scheduler/jobs/job-1', 'PATCH')!);
    // `runUntil` is not nullable on the PATCH route, so it is left off entirely.
    expect(body).toEqual({ endType: 'never' });
    expect(body).not.toHaveProperty('runUntil');
  });

  it('sends the run count when a never-ending job is switched to a count', async () => {
    const job = jobResponse({ endType: 'never', maxRuns: null });

    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        job={job}
      />,
    );

    fireEvent.click(screen.getByLabelText('After N runs'));
    fireEvent.change(screen.getByLabelText('Number of runs'), {
      target: { value: '4' },
    });
    fireEvent.click(editSubmit());

    expect(bodyOf(jobsCall('/api/scheduler/jobs/job-1', 'PATCH')!)).toEqual({
      endType: 'count',
      maxRuns: 4,
    });
  });

  it('surfaces a 400 from the patch route inline', async () => {
    fetchMock.mockImplementation(
      async (url: string, options?: { method?: string }) => {
        if (url === '/api/projects') return jsonResponse({ projects: [] });
        if (options?.method === 'PATCH') {
          return jsonResponse(
            {
              message: 'Invalid request body',
              error: [
                {
                  path: 'maxRuns',
                  message: 'maxRuns is required when endType is count',
                },
              ],
            },
            400,
          );
        }
        return jsonResponse({});
      },
    );

    render(
      <CreateJobModal
        open={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        job={jobResponse({ endType: 'count', maxRuns: 2 })}
      />,
    );

    fireEvent.click(editSubmit());

    await waitFor(() =>
      expect(
        screen.getByText('maxRuns is required when endType is count'),
      ).toBeInTheDocument(),
    );
  });
});
