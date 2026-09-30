import { z } from 'zod';
// Type-only import on purpose: this module is imported by client components
// later, and a value import would pull server-only code (BaseLLM,
// SessionManager, better-sqlite3) into the client bundle.
import type { SearchSources } from '@/lib/agents/search/types';

export type JobEndType = 'never' | 'count' | 'date';

export type ScheduledJobStatus = 'active' | 'paused' | 'completed';

export type ModelRef = { providerId: string; key: string };

/**
 * A row of the `scheduled_jobs` table, with the JSON columns already parsed.
 * Mirrors the drizzle table in `src/lib/db/schema.ts`.
 */
export type ScheduledJob = {
  id: string;
  title: string;
  prompt: string;
  chatId: string;
  intervalMinutes: number;
  endType: JobEndType;
  maxRuns: number | null;
  runUntil: string | null;
  status: ScheduledJobStatus;
  runCount: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  /** Plain TEXT in the DB (no enum), so it stays `string` here as well. */
  optimizationMode: string;
  /**
   * The column has a DEFAULT but no NOT NULL, so drizzle's select type says
   * `SearchSources[] | null`; readers coalesce a null to `[]` when mapping a
   * row to this type.
   */
  sources: SearchSources[];
  chatModel: ModelRef | null;
  embeddingModel: ModelRef | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};

const MINUTES_PER_UNIT = {
  minutes: 1,
  hours: 60,
  days: 60 * 24,
} as const;

/** UI unit -> `intervalMinutes`. */
export const intervalToMinutes = (
  value: number,
  unit: 'minutes' | 'hours' | 'days',
): number => value * MINUTES_PER_UNIT[unit];

/** `from` + interval, as a UTC ISO string. */
export const computeNextRunAt = (from: Date, intervalMinutes: number): string =>
  new Date(from.getTime() + intervalMinutes * 60_000).toISOString();

/** Due = active, scheduled, and its next run has arrived (inclusive). */
export const isJobDue = (job: ScheduledJob, now: Date): boolean =>
  job.status === 'active' &&
  job.nextRunAt !== null &&
  new Date(job.nextRunAt).getTime() <= now.getTime();

/**
 * Decides whether the job survives the run scheduled for `nextRunAt`.
 * A `count` job without `maxRuns` or a `date` job without `runUntil` is
 * treated as `never` rather than throwing on a malformed row.
 */
export const evaluateEnd = (
  job: ScheduledJob,
  nextRunAt: string,
): ScheduledJobStatus => {
  if (job.endType === 'count' && job.maxRuns !== null) {
    return job.runCount >= job.maxRuns ? 'completed' : 'active';
  }

  if (job.endType === 'date' && job.runUntil !== null) {
    return new Date(nextRunAt).getTime() > new Date(job.runUntil).getTime()
      ? 'completed'
      : 'active';
  }

  return 'active';
};

const modelRefSchema = z.object({
  providerId: z.string().min(1, { message: 'Provider id is required' }),
  key: z.string().min(1, { message: 'Model key is required' }),
});

/**
 * Field definitions for a job, module-private on purpose. The exported
 * `createJobSchema` layers the create-time refinements on top, and zod
 * 4.3.6 refuses to run `.partial()`, `.omit()` and `.pick()` on a schema
 * that carries a refinement (`util.js`: "cannot be used on object schemas
 * containing refinements") — even though the method still type-checks, so
 * tsc will not catch the runtime throw.
 *
 * A PATCH route must therefore rebuild the object from the exported shape:
 *   const patchSchema = z.object(createJobSchema.shape).partial();
 * That also drops the create-time end-condition rules, which is correct:
 * `count -> maxRuns` and `date -> runUntil` are invariants of a whole job,
 * not of one field update.
 */
const jobShape = {
  prompt: z.string().min(1, { message: 'Prompt must not be empty' }),
  title: z.string().optional(),
  intervalMinutes: z
    .number()
    .int('Interval must be a whole number of minutes')
    .min(1, { message: 'Interval must be at least 1 minute' })
    .max(525600, { message: 'Interval must be at most 525600 minutes' }),
  endType: z.enum(['never', 'count', 'date'], {
    message: 'End type must be one of: never, count, date',
  }),
  maxRuns: z
    .number()
    .int('Max runs must be a whole number')
    .min(1, { message: 'Max runs must be at least 1' })
    .optional(),
  /**
   * Must carry seconds AND an explicit zone: `2026-02-01T00:00:00Z` or
   * `2026-02-01T00:00:00+02:00` pass, the zone-less form produced by
   * `<input type="datetime-local">` (`2026-02-01T00:00`) does not, because
   * `new Date()` would read it in the server's local zone. Callers must
   * convert, e.g. `new Date(localValue).toISOString()`. The value is
   * validated but NOT normalized, so writers should store the
   * `toISOString()` form (all comparisons parse the instant anyway).
   */
  runUntil: z.iso.datetime({ offset: true }).optional(),
  optimizationMode: z
    .enum(['speed', 'balanced', 'quality', 'superfast'], {
      message:
        'Optimization mode must be one of: speed, balanced, quality, superfast',
    })
    .default('balanced'),
  sources: z
    .array(
      z.enum(['web', 'discussions', 'academic'], {
        message: 'Sources must be one of: web, discussions, academic',
      }),
    )
    .default(['web']),
  projectId: z.string().nullable().optional(),
  chatModel: modelRefSchema.nullable().optional(),
  embeddingModel: modelRefSchema.nullable().optional(),
};

export const createJobSchema = z.object(jobShape).superRefine((input, ctx) => {
  if (input.endType === 'count' && input.maxRuns === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxRuns'],
      message: 'maxRuns is required when endType is count',
    });
  }

  if (input.endType === 'date') {
    if (input.runUntil === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['runUntil'],
        message: 'runUntil is required when endType is date',
      });
    } else if (new Date(input.runUntil).getTime() <= Date.now()) {
      ctx.addIssue({
        code: 'custom',
        path: ['runUntil'],
        message: 'runUntil must be in the future',
      });
    }
  }
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
