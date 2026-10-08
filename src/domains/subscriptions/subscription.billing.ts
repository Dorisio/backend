export type Interval = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

export function addInterval(date: Date, interval: Interval): Date {
  const d = new Date(date);
  switch (interval) {
    case 'DAILY':
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case 'WEEKLY':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'MONTHLY': {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
      ).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay)); // Jan 31 -> Feb 28, not Mar 3
      break;
    }
    case 'YEARLY':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d;
}

/** Charge only for the part of [periodStart, periodEnd) that is left after `from`. */
export function prorate(
  amount: number,
  periodStart: Date,
  periodEnd: Date,
  from: Date,
): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0) throw new Error('Invalid period');
  const remaining = Math.min(total, Math.max(0, periodEnd.getTime() - from.getTime()));
  return round7((amount * remaining) / total);
}

export function applyDiscount(amount: number, percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('Invalid discount');
  }
  return round7(amount * (1 - percent / 100));
}

/** First and first-of-next day of the UTC month that contains `date`. */
export function monthBounds(date: Date): { start: Date; end: Date } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

export const MAX_ATTEMPTS = 3;
const RETRY_DAYS = [1, 3, 5];

/** Delay before the next retry after failed attempt N. null = give up. */
export function retryDelayMs(attempt: number): number | null {
  const days = RETRY_DAYS[attempt - 1];
  return days ? days * 86_400_000 : null;
}

/** Amount normalised to a monthly figure (for the dashboard). */
export function monthlyEquivalent(amount: number, interval: Interval): number {
  switch (interval) {
    case 'DAILY':
      return amount * 30;
    case 'WEEKLY':
      return (amount * 52) / 12;
    case 'MONTHLY':
      return amount;
    case 'YEARLY':
      return amount / 12;
  }
}