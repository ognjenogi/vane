import { z } from 'zod';
import SchedulerManager from '@/lib/scheduler/manager';
import { createJobSchema, type CreateJobInput } from '@/lib/scheduler/types';

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
 * create: `completed` is terminal and only `recordRunOutcome` may set it.
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
