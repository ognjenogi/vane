import { formatTimeDifference } from '@/lib/utils';

/**
 * `1440` -> `every 1 day`. Only the units the creation form offers, so the
 * label always names something the user can type back into it.
 */
export const formatIntervalLabel = (minutes: number): string => {
  if (minutes < 60) {
    return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
  }

  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? 'every day' : `every ${days} days`;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'every hour' : `every ${hours} hours`;
  }

  return `every ${minutes} minutes`;
};

/**
 * A complete relative phrase for an absolute instant, past or future. `null`
 * in, `null` out — a job with no next run is a state the caller renders
 * itself, not a gap to paper over with "in never".
 */
export const formatNextRun = (iso: string | null): string | null => {
  if (!iso) return null;

  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;

  const magnitude = formatTimeDifference(new Date(), target);

  return target.getTime() <= Date.now()
    ? `Overdue by ${magnitude}`
    : `Next run in ${magnitude}`;
};

/** A `<input type="datetime-local">` value: local wall clock, no zone. */
export const toLocalInputValue = (iso: string | null): string => {
  if (!iso) return '';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * The inverse of `toLocalInputValue`, and the reason this function exists:
 * the zone-less value an `<input type="datetime-local">` hands back is
 * REJECTED by `z.iso.datetime({ offset: true })` on `runUntil`, so it has to
 * become an explicit instant before it goes anywhere near the API.
 */
export const localInputValueToISO = (localValue: string): string =>
  new Date(localValue).toISOString();
