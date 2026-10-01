'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowUpRight,
  CircleAlert,
  Pause,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { ScheduledJob } from '@/lib/scheduler/types';
import { formatIntervalLabel, formatNextRun } from './format';

interface JobCardProps {
  job: ScheduledJob;
  /** Re-reads the list after a mutation, so the card never shows stale state. */
  onChanged: () => void;
  /** Hands the job to the page's modal; the card never edits in place. */
  onEdit: (job: ScheduledJob) => void;
}

const STATUS_CHIP: Record<
  ScheduledJob['status'],
  { label: string; className: string }
> = {
  active: {
    label: 'Active',
    className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
  },
  paused: {
    label: 'Paused',
    className:
      'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  },
  completed: {
    label: 'Completed',
    className:
      'bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50 border-black/10 dark:border-white/20',
  },
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

/** `3 runs`, `3 / 10 runs`, `3 runs · until 1 Feb 2027`. */
const runCountLabel = (job: ScheduledJob): string => {
  if (job.endType === 'count' && job.maxRuns !== null) {
    return `${job.runCount} / ${job.maxRuns} runs`;
  }

  if (job.endType === 'date' && job.runUntil) {
    return `${job.runCount} runs · until ${shortDate(job.runUntil)}`;
  }

  return `${job.runCount} runs`;
};

const JobCard = ({ job, onChanged, onEdit }: JobCardProps) => {
  const [busy, setBusy] = useState(false);

  const chip = STATUS_CHIP[job.status];

  /**
   * `completed` is terminal, so there is no run left to perform and the API
   * answers a run request on one with 409.
   */
  const canRun = job.status !== 'completed';

  const runNow = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/scheduler/jobs/${job.id}/run`, {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.message || 'Failed to start the run');
        return;
      }

      // The run itself is fire-and-forget; it lands in the job's chat.
      toast.success('Run started — the answer will appear in its chat');
      onChanged();
    } catch {
      toast.error('Failed to start the run');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: 'active' | 'paused') => {
    setBusy(true);
    try {
      const res = await fetch(`/api/scheduler/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.message || `Failed to ${status} the schedule`);
        return;
      }

      toast.success(
        status === 'paused' ? 'Schedule paused' : 'Schedule resumed',
      );
      onChanged();
    } catch {
      toast.error(`Failed to ${status} the schedule`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !confirm(
        `Delete this schedule? "${job.title || job.prompt}" will stop running. Its chat is kept.`,
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/scheduler/jobs/${job.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.message || 'Failed to delete the schedule');
        return;
      }

      toast.success('Schedule deleted');
      onChanged();
    } catch {
      toast.error('Failed to delete the schedule');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group flex flex-col gap-3 p-4 rounded-2xl border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary hover:border-black/30 dark:hover:border-white/30 transition shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-black dark:text-white line-clamp-1">
            {job.title || job.prompt}
          </h3>
          {job.title && (
            <p className="mt-1 text-xs text-black/60 dark:text-white/60 line-clamp-2">
              {job.prompt}
            </p>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            chip.className,
          )}
        >
          {chip.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-black/60 dark:text-white/60">
        <span>{formatIntervalLabel(job.intervalMinutes)}</span>
        <span aria-hidden="true">·</span>
        <span>{runCountLabel(job)}</span>
        {job.status !== 'completed' && (
          <>
            <span aria-hidden="true">·</span>
            <span>{formatNextRun(job.nextRunAt) ?? 'Awaiting first run'}</span>
          </>
        )}
      </div>

      {job.lastError && (
        <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{job.lastError}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-light-200/60 dark:border-dark-200/60">
        {canRun && (
          <button
            type="button"
            onClick={runNow}
            disabled={busy}
            title="Run this schedule once, right now"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-light-200 dark:border-dark-200 bg-light-primary/50 dark:bg-dark-primary/50 hover:bg-light-primary dark:hover:bg-dark-primary disabled:opacity-50 transition"
          >
            <Play size={14} />
            Run now
          </button>
        )}

        {job.status !== 'completed' &&
          (job.status === 'active' ? (
            <button
              type="button"
              onClick={() => setStatus('paused')}
              disabled={busy}
              title="Pause this schedule"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-light-200 dark:border-dark-200 bg-light-primary/50 dark:bg-dark-primary/50 hover:bg-light-primary dark:hover:bg-dark-primary disabled:opacity-50 transition"
            >
              <Pause size={14} />
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStatus('active')}
              disabled={busy}
              title="Resume this schedule"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-light-200 dark:border-dark-200 bg-light-primary/50 dark:bg-dark-primary/50 hover:bg-light-primary dark:hover:bg-dark-primary disabled:opacity-50 transition"
            >
              <Play size={14} />
              Resume
            </button>
          ))}

        <Link
          href={`/c/${job.chatId}`}
          title="Open the chat this schedule appends to"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-black/70 dark:text-white/70 hover:bg-light-200 hover:dark:bg-dark-200 transition"
        >
          Open chat
          <ArrowUpRight size={14} />
        </Link>

        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={() => onEdit(job)}
            disabled={busy}
            title="Edit this schedule"
            aria-label="Edit schedule"
            className="p-1.5 rounded-lg text-black/50 dark:text-white/50 hover:bg-light-200 hover:dark:bg-dark-200 hover:text-black hover:dark:text-white disabled:opacity-50 transition"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            title="Delete this schedule"
            aria-label="Delete schedule"
            className="p-1.5 rounded-lg text-black/50 dark:text-white/50 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50 transition"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default JobCard;
