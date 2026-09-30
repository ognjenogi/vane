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
     * the bookkeeping follows the run wherever it lands. Declared as an async
     * wrapper so a synchronous throw from the runner also arrives as a
     * rejection this `catch` can see, and `.catch` on the tail so nothing is
     * ever left as an unhandled rejection — which for a server process means a
     * dead server over one job.
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
