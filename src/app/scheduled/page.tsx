'use client';

import { CalendarClock } from 'lucide-react';
import JobsView from '@/components/Scheduler/JobsView';

const ScheduledPage = () => {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 pb-24">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-8 border-b border-light-200 dark:border-dark-200">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-2xl bg-light-200 dark:bg-dark-200 text-black/80 dark:text-white/80">
            <CalendarClock size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-semibold dark:text-white text-black">
              Scheduled
            </h1>
            <p className="text-sm text-black/60 dark:text-white/60">
              Recurring research that runs on its own and files every answer in
              its own chat.
            </p>
          </div>
        </div>
      </div>

      <JobsView />
    </div>
  );
};

export default ScheduledPage;
