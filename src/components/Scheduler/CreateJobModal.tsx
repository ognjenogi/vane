'use client';

import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { Fragment, useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { Select } from '@/components/ui/Select';
import type { SearchSources } from '@/lib/agents/search/types';
import {
  intervalToMinutes,
  type JobEndType,
  type ModelRef,
  type ScheduledJob,
} from '@/lib/scheduler/types';
import {
  formatIntervalLabel,
  localInputValueToISO,
  toLocalInputValue,
} from './format';

interface ProjectOption {
  id: string;
  name: string;
}

interface CreateJobModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (job?: ScheduledJob) => void;
  initialPrompt?: string;
  /** Provided -> edit mode: the form pre-fills and the save is a PATCH. */
  job?: ScheduledJob;
}

const OPTIMIZATION_MODES = [
  { value: 'speed', label: 'Speed' },
  { value: 'superfast', label: 'SuperFast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'quality', label: 'Quality' },
];

const SOURCE_OPTIONS: { value: SearchSources; label: string }[] = [
  { value: 'web', label: 'Web' },
  { value: 'discussions', label: 'Discussions' },
  { value: 'academic', label: 'Academic' },
];

const INTERVAL_UNITS = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
] as const;

type IntervalUnit = (typeof INTERVAL_UNITS)[number]['value'];

/** The models the chat is currently using, the same `localStorage` keys
 *  `checkConfig` in `useChat` writes them under. */
const readModelRef = (
  providerKey: string,
  modelKey: string,
): ModelRef | null => {
  const providerId = localStorage.getItem(providerKey);
  const key = localStorage.getItem(modelKey);

  if (!providerId || !key) return null;

  return { providerId, key };
};

/**
 * The largest unit that divides the stored interval exactly, so an edited job
 * shows back what it was created with (`1440` -> `1 day`, not `1440 minutes`).
 */
const splitInterval = (
  minutes: number,
): { value: number; unit: IntervalUnit } => {
  if (minutes % (60 * 24) === 0) {
    return { value: minutes / (60 * 24), unit: 'days' };
  }

  if (minutes % 60 === 0) {
    return { value: minutes / 60, unit: 'hours' };
  }

  return { value: minutes, unit: 'minutes' };
};

const sameSources = (a: SearchSources[], b: SearchSources[]): boolean =>
  a.length === b.length && a.every((source, i) => source === b[i]);

interface FormState {
  prompt: string;
  title: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  endType: JobEndType;
  maxRuns: string;
  runUntilLocal: string;
  optimizationMode: string;
  sources: SearchSources[];
  projectId: string;
}

const seedForm = (
  job: ScheduledJob | undefined,
  initialPrompt: string | undefined,
): FormState => {
  if (!job) {
    return {
      prompt: initialPrompt ?? '',
      title: '',
      intervalValue: '1',
      intervalUnit: 'days',
      endType: 'never',
      maxRuns: '',
      runUntilLocal: '',
      optimizationMode: 'balanced',
      sources: ['web'],
      projectId: '',
    };
  }

  const { value, unit } = splitInterval(job.intervalMinutes);

  return {
    prompt: job.prompt,
    title: job.title ?? '',
    intervalValue: String(value),
    intervalUnit: unit,
    endType: job.endType,
    maxRuns: job.maxRuns === null ? '' : String(job.maxRuns),
    runUntilLocal: toLocalInputValue(job.runUntil),
    optimizationMode: job.optimizationMode,
    sources: job.sources ?? [],
    projectId: job.projectId ?? '',
  };
};

const inputClass =
  'w-full px-3 py-2 text-sm rounded-lg border border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-primary text-black dark:text-white focus:outline-none focus:ring-1 focus:ring-black/40 dark:focus:ring-white/40';

const labelClass =
  'block text-xs font-medium uppercase tracking-wider text-black/60 dark:text-white/60 mb-1';

const errorClass = 'mt-1 text-xs text-red-600 dark:text-red-400';

const CreateJobModal = ({
  open,
  onClose,
  onCreated,
  initialPrompt,
  job,
}: CreateJobModalProps) => {
  const [form, setForm] = useState<FormState>(() =>
    seedForm(job, initialPrompt),
  );
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [apiErrors, setApiErrors] = useState<string[]>([]);

  const patch = (changes: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...changes }));

  const isEdit = Boolean(job);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    const loadProjects = async () => {
      try {
        const res = await fetch('/api/projects');
        const data = await res.json();
        if (!cancelled && res.ok && Array.isArray(data.projects)) {
          setProjects(data.projects);
        }
      } catch {
        // The project picker is optional; an empty list still creates a job.
      }
    };

    loadProjects();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggleSource = (source: SearchSources) => {
    setForm((prev) => ({
      ...prev,
      sources: prev.sources.includes(source)
        ? prev.sources.filter((s) => s !== source)
        : [...prev.sources, source],
    }));
  };

  const intervalMinutes = (() => {
    const value = Number(form.intervalValue);
    if (!Number.isFinite(value)) return NaN;
    return intervalToMinutes(value, form.intervalUnit);
  })();

  /**
   * The body for a create, or — in edit mode — only the keys whose value
   * actually differs from the stored job. The PATCH route merges by KEY
   * PRESENCE, so anything sent here is written; sending an untouched field is
   * how an edit silently resets one.
   */
  const buildPayload = (
    prompt: string,
    title: string,
  ): Record<string, unknown> => {
    if (!job) {
      const payload: Record<string, unknown> = {
        prompt,
        intervalMinutes,
        endType: form.endType,
        optimizationMode: form.optimizationMode,
        sources: form.sources,
        chatModel: readModelRef('chatModelProviderId', 'chatModelKey'),
        embeddingModel: readModelRef(
          'embeddingModelProviderId',
          'embeddingModelKey',
        ),
      };

      if (title) payload.title = title;
      if (form.projectId) payload.projectId = form.projectId;
      if (form.endType === 'count') payload.maxRuns = Number(form.maxRuns);
      if (form.endType === 'date') {
        payload.runUntil = localInputValueToISO(form.runUntilLocal);
      }

      return payload;
    }

    const changes: Record<string, unknown> = {};

    if (prompt !== job.prompt) changes.prompt = prompt;
    if (title !== (job.title ?? '')) changes.title = title;
    if (intervalMinutes !== job.intervalMinutes) {
      changes.intervalMinutes = intervalMinutes;
    }
    if (form.endType !== job.endType) changes.endType = form.endType;
    if (form.optimizationMode !== job.optimizationMode) {
      changes.optimizationMode = form.optimizationMode;
    }
    if (!sameSources(form.sources, job.sources ?? [])) {
      changes.sources = form.sources;
    }
    if ((form.projectId || null) !== (job.projectId ?? null)) {
      changes.projectId = form.projectId || null;
    }

    /**
     * The companion of an end condition is sent whenever it differs, but a
     * `null` never is: `runUntil` is not nullable on the PATCH route, so
     * switching a `date` job to `never` leaves the stored date alone rather
     * than trying to clear it.
     */
    if (form.endType === 'count') {
      if (Number(form.maxRuns) !== job.maxRuns) {
        changes.maxRuns = Number(form.maxRuns);
      }
    } else if (form.endType === 'date') {
      const runUntil = localInputValueToISO(form.runUntilLocal);
      if (runUntil !== (job.runUntil ?? null)) changes.runUntil = runUntil;
    }

    return changes;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setApiErrors([]);

    const prompt = form.prompt.trim();
    const title = form.title.trim();
    const errors: Record<string, string> = {};

    if (!prompt) errors.prompt = 'Prompt must not be empty';

    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
      errors.interval = 'Interval must be at least 1 minute';
    } else if (intervalMinutes > 525600) {
      errors.interval = 'Interval must be at most 525600 minutes';
    }

    if (form.endType === 'count') {
      const runs = Number(form.maxRuns);
      if (
        !form.maxRuns.trim() ||
        !Number.isInteger(runs) ||
        runs < 1 ||
        runs > 100000
      ) {
        errors.end = 'Enter the number of runs.';
      }
    }

    if (form.endType === 'date') {
      const until = form.runUntilLocal
        ? new Date(form.runUntilLocal).getTime()
        : NaN;

      if (!form.runUntilLocal || Number.isNaN(until)) {
        errors.end = 'Choose an end date.';
      } else if (until <= Date.now()) {
        // The create schema rejects a past `runUntil`; a `date` job whose date
        // has already gone completes on its next run rather than extending.
        errors.end = 'Choose an end date in the future.';
      }
    }

    if (form.sources.length === 0) {
      errors.sources = 'Pick at least one source.';
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setLoading(true);

    try {
      const res = await fetch(
        job ? `/api/scheduler/jobs/${job.id}` : '/api/scheduler/jobs',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload(prompt, title)),
        },
      );

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // A 400 here is a user-correctable mistake and its messages already
        // name the offending field, so they are shown rather than swallowed.
        const messages = Array.isArray(data?.error)
          ? data.error
              .map((issue: { message?: string }) => issue?.message)
              .filter((message: unknown): message is string =>
                Boolean(typeof message === 'string' && message),
              )
          : [];

        setApiErrors(
          messages.length > 0
            ? messages
            : [data?.message || 'Failed to save the schedule.'],
        );
        return;
      }

      toast.success(isEdit ? 'Schedule updated' : 'Schedule created');
      onClose();
      onCreated?.(data?.job);
    } catch {
      setApiErrors(['Failed to reach the scheduler.']);
    } finally {
      setLoading(false);
    }
  };

  const submitLabel = loading
    ? 'Saving…'
    : isEdit
      ? 'Save Changes'
      : 'Create Schedule';

  return (
    <Transition appear show={open} as={Fragment}>
      <Dialog
        as="div"
        className="relative z-50"
        onClose={() => {
          if (!loading) onClose();
        }}
      >
        <DialogBackdrop className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="w-full max-w-lg transform rounded-2xl bg-light-primary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 p-6 text-left align-middle shadow-2xl transition-all my-8">
                <div className="flex items-center gap-2 mb-4">
                  <div className="p-2 rounded-lg bg-light-200 dark:bg-dark-200 text-black/80 dark:text-white/80">
                    <CalendarClock size={22} />
                  </div>
                  <DialogTitle className="text-xl font-semibold dark:text-white text-black">
                    {isEdit ? 'Edit Schedule' : 'New Schedule'}
                  </DialogTitle>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="job-prompt" className={labelClass}>
                      Prompt *
                    </label>
                    <textarea
                      id="job-prompt"
                      value={form.prompt}
                      onChange={(e) => patch({ prompt: e.target.value })}
                      rows={3}
                      placeholder="e.g., What changed in the EU AI Act this week?"
                      className={`${inputClass} resize-none`}
                    />
                    {fieldErrors.prompt && (
                      <p role="alert" className={errorClass}>
                        {fieldErrors.prompt}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="job-title" className={labelClass}>
                      Title (optional)
                    </label>
                    <input
                      id="job-title"
                      type="text"
                      value={form.title}
                      onChange={(e) => patch({ title: e.target.value })}
                      placeholder="Shown in the scheduled list"
                      maxLength={100}
                      className={inputClass}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="job-interval-value"
                        className={labelClass}
                      >
                        Runs every
                      </label>
                      <input
                        id="job-interval-value"
                        type="number"
                        min={1}
                        step="any"
                        value={form.intervalValue}
                        onChange={(e) =>
                          patch({ intervalValue: e.target.value })
                        }
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor="job-interval-unit" className={labelClass}>
                        Interval unit
                      </label>
                      <Select
                        id="job-interval-unit"
                        value={form.intervalUnit}
                        onChange={(e) =>
                          patch({
                            intervalUnit: e.target.value as IntervalUnit,
                          })
                        }
                        options={[...INTERVAL_UNITS]}
                      />
                    </div>
                  </div>
                  {fieldErrors.interval && (
                    <p role="alert" className={errorClass}>
                      {fieldErrors.interval}
                    </p>
                  )}

                  <fieldset>
                    <legend className={labelClass}>Stops after</legend>
                    <div className="space-y-2">
                      <label
                        htmlFor="job-end-never"
                        className="flex items-center gap-2 text-sm text-black/80 dark:text-white/80"
                      >
                        <input
                          id="job-end-never"
                          type="radio"
                          name="job-end-type"
                          checked={form.endType === 'never'}
                          onChange={() => patch({ endType: 'never' })}
                        />
                        Forever
                      </label>
                      <label
                        htmlFor="job-end-count"
                        className="flex items-center gap-2 text-sm text-black/80 dark:text-white/80"
                      >
                        <input
                          id="job-end-count"
                          type="radio"
                          name="job-end-type"
                          checked={form.endType === 'count'}
                          onChange={() => patch({ endType: 'count' })}
                        />
                        After N runs
                      </label>
                      {form.endType === 'count' && (
                        <div className="pl-6">
                          <label htmlFor="job-max-runs" className="sr-only">
                            Number of runs
                          </label>
                          <input
                            id="job-max-runs"
                            type="number"
                            min={1}
                            step={1}
                            value={form.maxRuns}
                            onChange={(e) => patch({ maxRuns: e.target.value })}
                            placeholder="Runs"
                            className={`${inputClass} max-w-[12rem]`}
                          />
                        </div>
                      )}
                      <label
                        htmlFor="job-end-date"
                        className="flex items-center gap-2 text-sm text-black/80 dark:text-white/80"
                      >
                        <input
                          id="job-end-date"
                          type="radio"
                          name="job-end-type"
                          checked={form.endType === 'date'}
                          onChange={() => patch({ endType: 'date' })}
                        />
                        Until a date
                      </label>
                      {form.endType === 'date' && (
                        <div className="pl-6">
                          <label htmlFor="job-run-until" className="sr-only">
                            End date
                          </label>
                          <input
                            id="job-run-until"
                            type="datetime-local"
                            value={form.runUntilLocal}
                            onChange={(e) =>
                              patch({ runUntilLocal: e.target.value })
                            }
                            className={`${inputClass} max-w-[16rem]`}
                          />
                        </div>
                      )}
                    </div>
                    {fieldErrors.end && (
                      <p role="alert" className={errorClass}>
                        {fieldErrors.end}
                      </p>
                    )}
                  </fieldset>

                  <div>
                    <label
                      htmlFor="job-optimization-mode"
                      className={labelClass}
                    >
                      Optimization mode
                    </label>
                    <Select
                      id="job-optimization-mode"
                      value={form.optimizationMode}
                      onChange={(e) =>
                        patch({ optimizationMode: e.target.value })
                      }
                      options={OPTIMIZATION_MODES}
                    />
                  </div>

                  <fieldset>
                    <legend className={labelClass}>Sources</legend>
                    <div className="flex flex-wrap gap-4">
                      {SOURCE_OPTIONS.map((option) => (
                        <label
                          key={option.value}
                          htmlFor={`job-source-${option.value}`}
                          className="flex items-center gap-2 text-sm text-black/80 dark:text-white/80"
                        >
                          <input
                            id={`job-source-${option.value}`}
                            type="checkbox"
                            checked={form.sources.includes(option.value)}
                            onChange={() => toggleSource(option.value)}
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                    {fieldErrors.sources && (
                      <p role="alert" className={errorClass}>
                        {fieldErrors.sources}
                      </p>
                    )}
                  </fieldset>

                  <div>
                    <label htmlFor="job-project" className={labelClass}>
                      Project (optional)
                    </label>
                    <Select
                      id="job-project"
                      value={form.projectId}
                      onChange={(e) => patch({ projectId: e.target.value })}
                      options={[
                        { value: '', label: 'No project' },
                        ...projects.map((project) => ({
                          value: project.id,
                          label: project.name,
                        })),
                      ]}
                    />
                  </div>

                  {apiErrors.length > 0 && (
                    <div
                      role="alert"
                      className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 space-y-1"
                    >
                      {apiErrors.map((message, i) => (
                        <p
                          key={`${message}-${i}`}
                          className="text-xs text-red-600 dark:text-red-400"
                        >
                          {message}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="flex justify-end gap-3 pt-4 border-t border-light-200/50 dark:border-dark-200/50">
                    <button
                      type="button"
                      onClick={onClose}
                      disabled={loading}
                      className="px-4 py-2 text-sm font-medium rounded-lg text-black/60 dark:text-white/60 hover:text-black hover:dark:text-white hover:bg-light-200 hover:dark:bg-dark-200 transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="px-5 py-2 text-sm font-medium rounded-lg bg-black text-white dark:bg-white dark:text-black hover:opacity-90 disabled:opacity-50 transition"
                    >
                      {submitLabel}
                    </button>
                  </div>
                </form>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

export default CreateJobModal;
