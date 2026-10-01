'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { ScheduledJob } from '@/lib/scheduler/types';
import CreateJobModal from './CreateJobModal';
import JobCard from './JobCard';

const JobsView = () => {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);
  /**
   * Bumped on every open so the modal remounts: its form state is seeded from
   * props once, so without this a second "create" would show the previous
   * one's values.
   */
  const [modalKey, setModalKey] = useState(0);

  const fetchJobs = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/scheduler/jobs');
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.message || 'Failed to load schedules');
        return;
      }

      setJobs(data.jobs ?? []);
    } catch {
      toast.error('Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const openCreate = () => {
    setEditingJob(null);
    setModalKey((key) => key + 1);
    setIsModalOpen(true);
  };

  const openEdit = (job: ScheduledJob) => {
    setEditingJob(job);
    setModalKey((key) => key + 1);
    setIsModalOpen(true);
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-6 border-b border-light-200 dark:border-dark-200">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-black text-white dark:bg-white dark:text-black font-medium text-sm hover:opacity-90 transition shadow-sm"
          >
            <Plus size={18} />
            <span>New Schedule</span>
          </button>

          <button
            type="button"
            onClick={fetchJobs}
            title="Refresh schedules"
            aria-label="Refresh schedules"
            className="p-2.5 rounded-xl border border-light-200 dark:border-dark-200 text-black/60 dark:text-white/60 hover:text-black hover:dark:text-white transition"
          >
            <RefreshCw size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs text-black/60 dark:text-white/60">
          <span className="inline-flex items-center gap-1 rounded-full border border-black/20 dark:border-white/20 px-2 py-0.5">
            <CalendarClock size={14} />
            {loading
              ? 'Loading…'
              : `${jobs.filter((job) => job.status === 'active').length} active · ${jobs.length} total`}
          </span>
        </div>
      </div>

      {loading && jobs.length === 0 ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="w-8 h-8 border-2 border-black/20 border-t-black dark:border-white/20 dark:border-t-white rounded-full animate-spin" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] text-center p-8 mt-6 rounded-2xl border border-dashed border-light-200 dark:border-dark-200 bg-light-secondary/30 dark:bg-dark-secondary/30">
          <CalendarClock
            size={48}
            className="text-black/30 dark:text-white/30 mb-3"
          />
          <h3 className="text-lg font-medium text-black dark:text-white">
            No schedules yet
          </h3>
          <p className="text-sm text-black/60 dark:text-white/60 max-w-sm mt-1 mb-4">
            Schedule a prompt to run on an interval. Every run appends its
            answer to a dedicated chat you can read any time.
          </p>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-black text-white dark:bg-white dark:text-black text-sm font-medium hover:opacity-90 transition"
          >
            <Plus size={16} />
            <span>Create your first schedule</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-6 pb-8">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onChanged={fetchJobs}
              onEdit={openEdit}
            />
          ))}
        </div>
      )}

      <CreateJobModal
        key={modalKey}
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreated={fetchJobs}
        job={editingJob ?? undefined}
      />
    </div>
  );
};

export default JobsView;
