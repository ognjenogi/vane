import crypto from 'crypto';
import { desc, eq, sql } from 'drizzle-orm';
import db from '@/lib/db';
import { chats, scheduledJobs } from '@/lib/db/schema';
import {
  computeNextRunAt,
  evaluateEnd,
  type CreateJobInput,
  type ScheduledJob,
} from './types';

type Db = typeof db;
type JobRow = typeof scheduledJobs.$inferSelect;
type JobInsert = typeof scheduledJobs.$inferInsert;

/**
 * A stored row as the rest of the app sees it. `sources` has a DEFAULT but no
 * NOT NULL, so drizzle types the select as nullable; callers always get an
 * array back.
 */
const toJob = (row: JobRow): ScheduledJob => ({
  ...row,
  sources: (row.sources ?? []) as ScheduledJob['sources'],
});

/** 20 random bytes hex encoded, the id shape the chat routes use. */
const newId = () => crypto.randomBytes(20).toString('hex');

/**
 * Read/write access to `scheduled_jobs`. Every run of a job appends to the one
 * chat the job owns, so `createJob` creates that chat as well; deleting a job
 * deliberately leaves the chat (and everything collected in it) in place.
 *
 * The db handle is injectable so the tests can run against an in-memory
 * database instead of the singleton.
 */
class SchedulerManager {
  private readonly db: Db;

  constructor(dbHandle: Db = db) {
    this.db = dbHandle;
  }

  async createJob(input: CreateJobInput): Promise<ScheduledJob> {
    const now = new Date();
    const nowIso = now.toISOString();
    const sources = input.sources ?? ['web'];
    const title = input.title?.trim() || input.prompt.slice(0, 64);
    const chatId = newId();

    // Mirrors `ensureChatExists` in `src/app/api/chat/route.ts`. The
    // duplication is deliberate: a shared helper would mean editing a file
    // outside this plan.
    await this.db
      .insert(chats)
      .values({
        id: chatId,
        title,
        createdAt: nowIso,
        sources,
        files: [],
        projectId: input.projectId ?? null,
      })
      .run();

    const job = {
      id: newId(),
      title,
      prompt: input.prompt,
      chatId,
      intervalMinutes: input.intervalMinutes,
      endType: input.endType,
      maxRuns: input.maxRuns ?? null,
      // `createJobSchema` validates `runUntil` but does not normalize it, so
      // store the canonical UTC form.
      runUntil: input.runUntil ? new Date(input.runUntil).toISOString() : null,
      status: 'active' as const,
      runCount: 0,
      lastRunAt: null,
      nextRunAt: computeNextRunAt(now, input.intervalMinutes),
      lastError: null,
      optimizationMode: input.optimizationMode,
      sources,
      chatModel: input.chatModel ?? null,
      embeddingModel: input.embeddingModel ?? null,
      projectId: input.projectId ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.db.insert(scheduledJobs).values(job).run();

    return toJob(job);
  }

  /** Newest first, which is the order the scheduled page lists them in. */
  async listJobs(): Promise<ScheduledJob[]> {
    const rows = await this.db
      .select()
      .from(scheduledJobs)
      .orderBy(desc(scheduledJobs.createdAt))
      .all();

    return rows.map(toJob);
  }

  async getJob(id: string): Promise<ScheduledJob | null> {
    const row = await this.db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.id, id))
      .get();

    return row ? toJob(row) : null;
  }

  async updateJob(
    id: string,
    patch: Partial<CreateJobInput> & { status?: 'active' | 'paused' },
  ): Promise<ScheduledJob | null> {
    const job = await this.getJob(id);
    if (!job) return null;

    // Only the keys the caller actually sent are written: a patch assembled
    // from a request body must not clobber the stored value of a field it
    // leaves out.
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;

      // `createJobSchema` validates `runUntil` but does not normalize it, so
      // store the canonical UTC form. An explicit `null` clears the end date
      // and must be written as SQL NULL, not coerced to the epoch.
      updates[key] =
        key === 'runUntil' && value != null
          ? new Date(value as string).toISOString()
          : value;
    }

    // Resuming must not fire the slot the job missed while it was paused.
    if (
      patch.status === 'active' &&
      job.nextRunAt !== null &&
      new Date(job.nextRunAt).getTime() <= Date.now()
    ) {
      updates.nextRunAt = computeNextRunAt(
        new Date(),
        (updates.intervalMinutes as number | undefined) ?? job.intervalMinutes,
      );
    }

    await this.db
      .update(scheduledJobs)
      .set({ ...updates, updatedAt: new Date().toISOString() } as JobInsert)
      .where(eq(scheduledJobs.id, id))
      .run();

    return this.getJob(id);
  }

  async deleteJob(id: string): Promise<boolean> {
    const result = await this.db
      .delete(scheduledJobs)
      .where(eq(scheduledJobs.id, id))
      .run();

    return result.changes > 0;
  }

  /**
   * Bookkeeping for a finished run: count it, remember when it ran and why it
   * failed, and move the schedule on. `count` and `date` jobs evaluate to
   * `completed` here, on the run that reaches their end condition.
   *
   * A run can outlive the pause the user requested while it was in flight, so
   * `evaluateEnd` alone is not allowed to decide the status: it answers "is
   * this job finished?", not "should it run again?". Completion is terminal and
   * wins; otherwise a job that was paused stays paused instead of silently
   * resuming.
   *
   * The increment is ATOMIC IN SQL (`runCount + 1`) rather than read here and
   * written back. Two callers can report at the same instant — the ticker and
   * the manual run route, or two of the latter — and a read-modify-write would
   * let both write the same number and lose one: a `count: 2` job that has
   * really run three times, or never completes. `evaluateEnd` still reads a job
   * it fetched here, so the count it judges can be one behind the row under a
   * genuine overlap; the pre-dispatch check in the dispatchers then completes
   * the job on the NEXT tick instead of paying for another turn.
   */
  async recordRunOutcome(
    id: string,
    result: { ok: boolean; error?: string },
  ): Promise<ScheduledJob | null> {
    const job = await this.getJob(id);
    if (!job) return null;

    const now = new Date();
    const nextRunAt = computeNextRunAt(now, job.intervalMinutes);
    // The run that just finished is part of the count, so the end condition is
    // evaluated against the incremented runCount.
    const finished: ScheduledJob = { ...job, runCount: job.runCount + 1 };
    const status = evaluateEnd(finished, nextRunAt);

    await this.db
      .update(scheduledJobs)
      .set({
        runCount: sql`${scheduledJobs.runCount} + 1`,
        lastRunAt: now.toISOString(),
        nextRunAt,
        lastError: result.ok ? null : (result.error ?? null),
        status:
          status === 'completed'
            ? 'completed'
            : job.status === 'paused'
              ? 'paused'
              : 'active',
        updatedAt: now.toISOString(),
      })
      .where(eq(scheduledJobs.id, id))
      .run();

    return this.getJob(id);
  }

  /**
   * Marks a job completed WITHOUT counting a run.
   *
   * The dispatchers evaluate the end condition before every dispatch, and a job
   * that fails it must still end up `completed` rather than keep being offered
   * a run that is not going to happen — that is what stops a `date` job whose
   * date has passed, or a `count` job PATCHed down to the runCount it already
   * has, from buying another full research turn. Nothing ran, so `runCount`,
   * `lastRunAt` and `nextRunAt` are deliberately left exactly as they are.
   */
  async completeJob(id: string): Promise<ScheduledJob | null> {
    const job = await this.getJob(id);
    if (!job) return null;

    await this.db
      .update(scheduledJobs)
      .set({ status: 'completed', updatedAt: new Date().toISOString() })
      .where(eq(scheduledJobs.id, id))
      .run();

    return this.getJob(id);
  }

  /**
   * Skips the slot that is due now. The ticker calls this when a job's run is
   * still going: rather than queue a second run, push the schedule one interval
   * past the later of now and the pending slot.
   */
  async pushNextRun(id: string): Promise<ScheduledJob | null> {
    const job = await this.getJob(id);
    if (!job) return null;

    const now = new Date();
    const pending = job.nextRunAt === null ? null : new Date(job.nextRunAt);
    const base =
      pending !== null && pending.getTime() > now.getTime() ? pending : now;
    const nextRunAt = computeNextRunAt(base, job.intervalMinutes);

    await this.db
      .update(scheduledJobs)
      .set({ nextRunAt, updatedAt: now.toISOString() })
      .where(eq(scheduledJobs.id, id))
      .run();

    return this.getJob(id);
  }
}

export default SchedulerManager;
