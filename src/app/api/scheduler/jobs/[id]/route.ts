import { z } from 'zod';
import SchedulerManager from '@/lib/scheduler/manager';
import {
  createJobSchema,
  type CreateJobInput,
  type JobEndType,
} from '@/lib/scheduler/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const manager = new SchedulerManager();

/** The declared `updateJob` patch type, read off the method itself. */
type JobPatch = Partial<CreateJobInput> & { status?: 'active' | 'paused' };

/**
 * The create schema REBUILT from its exported shape, then made partial.
 *
 * `createJobSchema.partial()` compiles (`.superRefine()` returns `this`, so the
 * method is still on the type) but throws at runtime under zod 4, and
 * `.omit()`/`.pick()` throw the same way — so `z.object(createJobSchema.shape)`
 * is the only supported derivation, and tsc cannot catch the alternative. This
 * also drops the create-time end-condition rules (`count -> maxRuns`), which
 * are invariants of a whole job and not of one field update. Pinned by
 * `src/lib/scheduler/__tests__/logic.test.ts`.
 *
 * `status` is layered on separately because it belongs to the update, not to the
 * create: `completed` is terminal, and only the manager's own bookkeeping
 * (`recordRunOutcome`, `completeJob`) may set it.
 */
const patchJobSchema = z
  .object(createJobSchema.shape)
  .extend({
    status: z.enum(['active', 'paused'], {
      message: 'Status must be one of: active, paused',
    }),
  })
  .partial();

const NOT_FOUND = () =>
  Response.json({ message: 'Scheduled job not found' }, { status: 404 });

/**
 * One end-condition issue in the same `{ message, error }` envelope a schema
 * failure uses, and worded exactly like the create-time messages in
 * `src/lib/scheduler/types.ts` — the same mistake, so it reads the same in the
 * UI whichever route caught it.
 */
const INVALID_END_CONDITION = (issue: { path: string; message: string }) =>
  Response.json(
    { message: 'Invalid request body', error: [issue] },
    { status: 400 },
  );

export const GET = async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;
    const job = await manager.getJob(id);

    if (!job) return NOT_FOUND();

    return Response.json({ job }, { status: 200 });
  } catch (err) {
    console.error('Error fetching scheduled job:', err);
    return Response.json(
      { message: 'An error occurred fetching scheduled job.' },
      { status: 500 },
    );
  }
};

export const PATCH = async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;
    const body = (await req.json()) as Record<string, unknown>;
    const parsed = patchJobSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        {
          message: 'Invalid request body',
          error: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    /**
     * Only the keys the CALLER actually sent are forwarded, not the whole parsed
     * object.
     *
     * zod keeps `.default()` through `.partial()`, so a body of `{ prompt: 'x' }`
     * parses to a full object that also carries `optimizationMode: 'balanced'`
     * and `sources: ['web']`. Writing that back would silently reset those two
     * fields — and anything else defaulted — on every partial edit. So this
     * intersects the parsed output with the request body's own keys. Keys the
     * schema does not know are dropped rather than written; `Object.hasOwn` and
     * not `in`, so a body carrying `toString` or `__proto__` cannot smuggle one
     * through the prototype chain.
     */
    const fields = parsed.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      if (!Object.hasOwn(fields, key)) continue;
      const value = fields[key];
      if (value === undefined) continue;
      patch[key] = value;
    }

    /**
     * The patch schema has no `endType -> maxRuns` / `endType -> runUntil`
     * refinement, on purpose: those are invariants of a WHOLE job, and a patch
     * that touches only a title must not be rejected for them. What it cannot
     * also allow is a patch that SWITCHES `endType` to a condition it leaves
     * unsatisfiable — `updateJob` writes only the keys sent, and `evaluateEnd`
     * reads a `count` without `maxRuns` (or a `date` without `runUntil`) as
     * `never`, so the job would silently become UNBOUNDED and bill a full paid
     * research turn every interval for good, with a 200 saying it worked.
     *
     * So the resulting end condition is judged here, against the patch merged
     * with the STORED row — the companion field may legitimately come from
     * either side, and only the combination is the job the user will end up
     * with. Validation only; `updateJob` still writes just the patch keys.
     *
     * Also worth noting for whoever wrote the request: a `date` job whose
     * `runUntil` has already passed completes on its very next run
     * (`evaluateEnd` compares the next slot against the date), so re-arming one
     * with a stale date is a way to stop it, not to extend it.
     */
    const existing = await manager.getJob(id);
    if (!existing) return NOT_FOUND();

    const nextEndType = (patch.endType ?? existing.endType) as JobEndType;
    const nextMaxRuns = 'maxRuns' in patch ? patch.maxRuns : existing.maxRuns;
    const nextRunUntil =
      'runUntil' in patch ? patch.runUntil : existing.runUntil;

    if (nextEndType === 'count' && nextMaxRuns == null) {
      return INVALID_END_CONDITION({
        path: 'maxRuns',
        message: 'maxRuns is required when endType is count',
      });
    }

    if (nextEndType === 'date' && nextRunUntil == null) {
      return INVALID_END_CONDITION({
        path: 'runUntil',
        message: 'runUntil is required when endType is date',
      });
    }

    const updated = await manager.updateJob(id, patch as JobPatch);
    if (!updated) return NOT_FOUND();

    return Response.json({ job: updated }, { status: 200 });
  } catch (err) {
    console.error('Error updating scheduled job:', err);
    return Response.json(
      { message: 'An error occurred updating scheduled job.' },
      { status: 500 },
    );
  }
};

export const DELETE = async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;
    const deleted = await manager.deleteJob(id);

    if (!deleted) return NOT_FOUND();

    // 204 carries no body, so this is a bare `Response` rather than
    // `Response.json` — the constructor rejects a body on a 204.
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error('Error deleting scheduled job:', err);
    return Response.json(
      { message: 'An error occurred deleting scheduled job.' },
      { status: 500 },
    );
  }
};
