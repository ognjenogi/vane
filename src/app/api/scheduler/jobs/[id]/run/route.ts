import SchedulerManager from '@/lib/scheduler/manager';
import { runJobNow } from '@/lib/scheduler/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const manager = new SchedulerManager();

export const POST = async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;
    const job = await manager.getJob(id);

    if (!job) {
      return Response.json(
        { message: 'Scheduled job not found' },
        { status: 404 },
      );
    }

    // `completed` is terminal: there is no run left to perform, and the UI has
    // nothing to resume it to.
    if (job.status === 'completed') {
      return Response.json(
        { message: 'Scheduled job has already completed' },
        { status: 409 },
      );
    }

    /**
     * Deliberately NOT awaited.
     *
     * One run is a whole research turn — a minute or more — and this route has
     * already spent its budget on it (Next's serverless request timeout is far
     * shorter). So the response goes back as soon as the run is under way, and
     * the bookkeeping follows the run wherever it lands.
     *
     * Safety comes from ONE place, and it is the `try`/`catch` INSIDE this async
     * IIFE — which covers both the run and the bookkeeping, and cannot be
     * bypassed. `runJobNow` is contractually non-rejecting and the manager is
     * not, so the catch is the belt to their braces: an escaping rejection
     * would be node's `unhandledRejection`, which for a server process means a
     * dead server over one job. The async wrapper matters for that too — a
     * synchronous throw from the runner becomes a rejection the catch sees,
     * rather than one thrown past the IIFE before any handler exists.
     *
     * Note this is NOT the ticker's shape. `scheduler.ts` chains
     * `void run(job).finally(...).catch(...)`, where the `finally` has to run
     * before the `catch` can be the last handler on the chain. Here there is
     * nothing to clean up per job, so the inner catch is the whole mechanism —
     * keep it that way if this body grows: anything added AFTER the try must go
     * inside it, or it needs its own handler.
     *
     * A job the user paused may still be run on request; `recordRunOutcome`
     * keeps the pause (it only completes a job that reached its end condition).
     */
    void (async () => {
      try {
        const result = await runJobNow(job);
        await manager.recordRunOutcome(job.id, result);
      } catch (err) {
        console.error(`Scheduler: manual run of job ${job.id} failed`, err);
      }
    })();

    return Response.json({}, { status: 202 });
  } catch (err) {
    console.error('Error starting scheduled job run:', err);
    return Response.json(
      { message: 'An error occurred starting the run.' },
      { status: 500 },
    );
  }
};
