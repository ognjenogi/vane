'use client';

import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils';
import CreateJobModal from '@/components/Scheduler/CreateJobModal';

interface ScheduleProps {
  /** The prompt typed so far, carried into the form. */
  message: string;
}

/**
 * Turns whatever is in the chat input into a recurring prompt, pre-filled
 * with it. The input itself is untouched — scheduling a prompt does not send
 * it.
 */
const Schedule = ({ message }: ScheduleProps) => {
  const [isOpen, setIsOpen] = useState(false);
  /**
   * Bumped on every open, so the modal remounts and re-seeds.
   *
   * `CreateJobModal` seeds its form ONCE per mount, from `initialPrompt`. This
   * component is mounted with the chat page's first render — before anything
   * has been typed — so without a remount the form kept the empty prompt from
   * that first render and every scheduled job lost what the user typed. Same
   * reason `JobsView` keys its modal the same way.
   */
  const [modalKey, setModalKey] = useState(0);

  const open = () => {
    setModalKey((key) => key + 1);
    setIsOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        title="Repeat this prompt on a schedule"
        aria-label="Schedule this prompt"
        className={cn(
          'shrink-0 flex items-center justify-center active:border-none p-2 rounded-lg focus:outline-none',
          'text-black/50 dark:text-white/50 active:scale-95 transition duration-200',
          'hover:bg-light-200 hover:dark:bg-dark-200 hover:text-black hover:dark:text-white',
        )}
      >
        <CalendarClock size={18} />
      </button>

      <CreateJobModal
        key={modalKey}
        open={isOpen}
        onClose={() => setIsOpen(false)}
        initialPrompt={message}
      />
    </>
  );
};

export default Schedule;
