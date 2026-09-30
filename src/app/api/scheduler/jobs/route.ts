import { z } from 'zod';
import SchedulerManager from '@/lib/scheduler/manager';
import { createJobSchema } from '@/lib/scheduler/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const manager = new SchedulerManager();

/**
 * Zod issues mapped to `{ path, message }`, the shape the chat route returns
 * (`src/app/api/chat/route.ts:67-84`), so the UI has one error format to render.
 */
const issuesOf = (error: z.ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

export const GET = async () => {
  try {
    const jobs = await manager.listJobs();
    return Response.json({ jobs }, { status: 200 });
  } catch (err) {
    console.error('Error fetching scheduled jobs:', err);
    return Response.json(
      { message: 'An error occurred fetching scheduled jobs.' },
      { status: 500 },
    );
  }
};

export const POST = async (req: Request) => {
  try {
    const parsed = createJobSchema.safeParse(await req.json());

    if (!parsed.success) {
      return Response.json(
        { message: 'Invalid request body', error: issuesOf(parsed.error) },
        { status: 400 },
      );
    }

    const job = await manager.createJob(parsed.data);
    return Response.json({ job }, { status: 201 });
  } catch (err) {
    console.error('Error creating scheduled job:', err);
    return Response.json(
      { message: 'An error occurred creating scheduled job.' },
      { status: 500 },
    );
  }
};
