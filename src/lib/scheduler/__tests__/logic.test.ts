import { describe, expect, it } from 'vitest';
import {
  computeNextRunAt,
  createJobSchema,
  evaluateEnd,
  intervalToMinutes,
  isJobDue,
  type CreateJobInput,
  type ModelRef,
  type ScheduledJob,
} from '@/lib/scheduler/types';

/** A fully populated row, so each test only states the fields it cares about. */
const BASE_JOB: ScheduledJob = {
  id: 'job-1',
  title: 'Daily digest',
  prompt: 'Summarize what changed today',
  chatId: 'chat-1',
  intervalMinutes: 1440,
  endType: 'never',
  maxRuns: null,
  runUntil: null,
  status: 'active',
  runCount: 0,
  lastRunAt: null,
  nextRunAt: '2026-01-01T00:00:00.000Z',
  lastError: null,
  optimizationMode: 'balanced',
  sources: ['web'],
  chatModel: null,
  embeddingModel: null,
  projectId: null,
  createdAt: '2025-12-31T00:00:00.000Z',
  updatedAt: '2025-12-31T00:00:00.000Z',
};

const makeJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  ...BASE_JOB,
  ...overrides,
});

/**
 * The smallest payload the schema accepts; `optimizationMode` and `sources`
 * are left out on purpose to prove the defaults are applied.
 */
const minimal = {
  prompt: 'Track the Vane releases',
  intervalMinutes: 60,
  endType: 'never',
};

/** All validation messages, so a test can assert on one of them by value. */
const messagesOf = (result: ReturnType<typeof createJobSchema.safeParse>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.message);

const pathsOf = (result: ReturnType<typeof createJobSchema.safeParse>) =>
  result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'));

describe('intervalToMinutes', () => {
  it('converts days to minutes (2 days = 2880)', () => {
    expect(intervalToMinutes(2, 'days')).toBe(2880);
  });

  it('converts hours to minutes', () => {
    expect(intervalToMinutes(1, 'hours')).toBe(60);
    expect(intervalToMinutes(0.5, 'hours')).toBe(30);
    expect(intervalToMinutes(12, 'hours')).toBe(720);
  });

  it('converts fractional days to minutes', () => {
    expect(intervalToMinutes(0.5, 'days')).toBe(720);
  });

  it('leaves minutes untouched', () => {
    expect(intervalToMinutes(1, 'minutes')).toBe(1);
    expect(intervalToMinutes(30, 'minutes')).toBe(30);
  });
});

describe('computeNextRunAt', () => {
  it('adds the interval in minutes and returns a UTC ISO string', () => {
    expect(computeNextRunAt(new Date('2026-01-01T00:00:00.000Z'), 2880)).toBe(
      '2026-01-03T00:00:00.000Z',
    );
  });

  it('adds sub-day intervals', () => {
    expect(computeNextRunAt(new Date('2026-01-01T00:00:00.000Z'), 90)).toBe(
      '2026-01-01T01:30:00.000Z',
    );
  });

  it('keeps millisecond precision for fractional minutes', () => {
    expect(computeNextRunAt(new Date('2026-01-01T00:00:00.000Z'), 0.5)).toBe(
      '2026-01-01T00:00:30.000Z',
    );
  });

  it('does not mutate the given date', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    computeNextRunAt(from, 60);
    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('always returns a parseable ISO string ending in Z', () => {
    const next = computeNextRunAt(new Date('2026-06-15T12:00:00.000Z'), 5);
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(new Date(next).getTime())).toBe(false);
  });
});

describe('isJobDue', () => {
  const now = new Date('2026-01-02T00:00:00.000Z');

  it('is true for an active job whose next run is in the past', () => {
    expect(
      isJobDue(makeJob({ nextRunAt: '2026-01-01T23:59:59.000Z' }), now),
    ).toBe(true);
  });

  it('is true when the job is due exactly now (inclusive boundary)', () => {
    expect(isJobDue(makeJob({ nextRunAt: now.toISOString() }), now)).toBe(true);
  });

  it('is false when the next run is in the future', () => {
    expect(
      isJobDue(makeJob({ nextRunAt: '2026-01-02T00:00:00.001Z' }), now),
    ).toBe(false);
  });

  it('is false for a paused job even when its next run is due', () => {
    expect(
      isJobDue(
        makeJob({ status: 'paused', nextRunAt: '2026-01-01T00:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
  });

  it('is false for a completed job even when its next run is due', () => {
    expect(
      isJobDue(
        makeJob({ status: 'completed', nextRunAt: '2026-01-01T00:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
  });

  it('is false when nextRunAt is null', () => {
    expect(isJobDue(makeJob({ nextRunAt: null }), now)).toBe(false);
  });

  it('compares instants, not ISO strings', () => {
    // 2026-01-02T02:00:00+03:00 is 2026-01-01T23:00:00Z, i.e. one hour
    // before `now` — a lexicographic string compare would call it later.
    expect(
      isJobDue(makeJob({ nextRunAt: '2026-01-02T02:00:00+03:00' }), now),
    ).toBe(true);
  });

  it('is false for an unparseable nextRunAt instead of throwing', () => {
    expect(isJobDue(makeJob({ nextRunAt: 'not-a-date' }), now)).toBe(false);
  });
});

describe('evaluateEnd', () => {
  it('never stays active', () => {
    expect(
      evaluateEnd(makeJob({ endType: 'never' }), '2030-01-01T00:00:00.000Z'),
    ).toBe('active');
  });

  it('count stays active while runs are below the limit', () => {
    expect(
      evaluateEnd(
        makeJob({ endType: 'count', maxRuns: 5, runCount: 4 }),
        '2026-01-02T00:00:00.000Z',
      ),
    ).toBe('active');
  });

  it('count completes exactly when runCount reaches maxRuns', () => {
    expect(
      evaluateEnd(
        makeJob({ endType: 'count', maxRuns: 5, runCount: 5 }),
        '2026-01-02T00:00:00.000Z',
      ),
    ).toBe('completed');
  });

  it('count completes when runCount is above maxRuns', () => {
    expect(
      evaluateEnd(
        makeJob({ endType: 'count', maxRuns: 5, runCount: 6 }),
        '2026-01-02T00:00:00.000Z',
      ),
    ).toBe('completed');
  });

  it('count with a null maxRuns is treated as never (malformed row)', () => {
    expect(
      evaluateEnd(
        makeJob({ endType: 'count', maxRuns: null, runCount: 9 }),
        '2026-01-02T00:00:00.000Z',
      ),
    ).toBe('active');
  });

  it('date stays active while the next run is before runUntil', () => {
    expect(
      evaluateEnd(
        makeJob({ endType: 'date', runUntil: '2026-02-01T00:00:00.000Z' }),
        '2026-01-31T23:59:59.000Z',
      ),
    ).toBe('active');
  });

  it('date stays active when the next run lands exactly on runUntil', () => {
    expect(
      evaluateEnd(
        makeJob({ endType: 'date', runUntil: '2026-02-01T00:00:00.000Z' }),
        '2026-02-01T00:00:00.000Z',
      ),
    ).toBe('active');
  });

  it('date compares instants, not ISO strings', () => {
    // 2026-01-31T20:00:00-03:00 is 2026-01-31T23:00:00Z, i.e. two hours after
    // runUntil — a lexicographic compare would keep the job active.
    expect(
      evaluateEnd(
        makeJob({ endType: 'date', runUntil: '2026-01-31T21:00:00.000Z' }),
        '2026-01-31T20:00:00-03:00',
      ),
    ).toBe('completed');
  });

  it('date completes when the next run is after runUntil', () => {
    expect(
      evaluateEnd(
        makeJob({ endType: 'date', runUntil: '2026-02-01T00:00:00.000Z' }),
        '2026-02-01T00:00:00.001Z',
      ),
    ).toBe('completed');
  });

  it('date with a null runUntil is treated as never (malformed row)', () => {
    expect(
      evaluateEnd(
        makeJob({ endType: 'date', runUntil: null }),
        '2026-02-01T00:00:00.000Z',
      ),
    ).toBe('active');
  });
});

describe('createJobSchema', () => {
  it('accepts a minimal valid payload and fills defaults', () => {
    const result = createJobSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    expect(result.success && result.data.optimizationMode).toBe('balanced');
    expect(result.success && result.data.sources).toEqual(['web']);
  });

  it('accepts the full payload', () => {
    const result = createJobSchema.safeParse({
      ...minimal,
      title: 'Releases',
      endType: 'count',
      maxRuns: 3,
      optimizationMode: 'quality',
      sources: ['web', 'academic'],
      projectId: 'project-1',
      chatModel: { providerId: 'p1', key: 'model-a' },
      embeddingModel: { providerId: 'p1', key: 'embed-a' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts explicit nulls for the optional model refs and projectId', () => {
    const result = createJobSchema.safeParse({
      ...minimal,
      projectId: null,
      chatModel: null,
      embeddingModel: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a future runUntil on a date job, with or without an offset', () => {
    expect(
      createJobSchema.safeParse({
        ...minimal,
        endType: 'date',
        runUntil: '2999-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      createJobSchema.safeParse({
        ...minimal,
        endType: 'date',
        runUntil: '2999-01-01T00:00:00+02:00',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty prompt', () => {
    const result = createJobSchema.safeParse({ ...minimal, prompt: '' });
    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('prompt');
  });

  it('rejects intervalMinutes below 1', () => {
    const result = createJobSchema.safeParse({
      ...minimal,
      intervalMinutes: 0,
    });
    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('intervalMinutes');
  });

  it('rejects intervalMinutes above one year', () => {
    expect(
      createJobSchema.safeParse({ ...minimal, intervalMinutes: 525601 })
        .success,
    ).toBe(false);
    expect(
      createJobSchema.safeParse({ ...minimal, intervalMinutes: 525600 })
        .success,
    ).toBe(true);
  });

  it('rejects a fractional intervalMinutes', () => {
    const result = createJobSchema.safeParse({
      ...minimal,
      intervalMinutes: 1.5,
    });
    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('intervalMinutes');
  });

  it('rejects an unknown endType, mode or source', () => {
    expect(
      createJobSchema.safeParse({ ...minimal, endType: 'weekly' }).success,
    ).toBe(false);
    expect(
      createJobSchema.safeParse({ ...minimal, optimizationMode: 'turbo' })
        .success,
    ).toBe(false);
    expect(
      createJobSchema.safeParse({ ...minimal, sources: ['blogs'] }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO runUntil', () => {
    const result = createJobSchema.safeParse({
      ...minimal,
      endType: 'date',
      runUntil: 'tomorrow',
    });
    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('runUntil');
  });

  it('rejects a count job without maxRuns', () => {
    const result = createJobSchema.safeParse({ ...minimal, endType: 'count' });
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain(
      'maxRuns is required when endType is count',
    );
    expect(pathsOf(result)).toContain('maxRuns');
  });

  it('rejects a count job with maxRuns below 1', () => {
    const result = createJobSchema.safeParse({
      ...minimal,
      endType: 'count',
      maxRuns: 0,
    });
    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('maxRuns');
  });

  it('rejects a date job without runUntil', () => {
    const result = createJobSchema.safeParse({ ...minimal, endType: 'date' });
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain(
      'runUntil is required when endType is date',
    );
    expect(pathsOf(result)).toContain('runUntil');
  });

  it('rejects a date job whose runUntil is in the past', () => {
    const result = createJobSchema.safeParse({
      ...minimal,
      endType: 'date',
      runUntil: '2000-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain('runUntil must be in the future');
    expect(pathsOf(result)).toContain('runUntil');
  });

  it('ignores the end-condition rules for a never job', () => {
    expect(
      createJobSchema.safeParse({ ...minimal, endType: 'never' }).success,
    ).toBe(true);
  });
});

describe('type contract', () => {
  it('types the parsed create input the way the manager consumes it', () => {
    // `CreateJobInput` is z.infer (the schema's OUTPUT type), so the two
    // defaulted fields are required on the type even though the parser
    // fills them in.
    const model: ModelRef = { providerId: 'p1', key: 'model-a' };
    const input: CreateJobInput = {
      prompt: 'Track the Vane releases',
      intervalMinutes: 60,
      endType: 'never',
      optimizationMode: 'quality',
      sources: ['web', 'discussions', 'academic'],
      chatModel: model,
      projectId: null,
    };
    expect(createJobSchema.safeParse(input).success).toBe(true);
  });
});
