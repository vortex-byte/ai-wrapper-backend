/**
 * Calendar-month quota period boundaries in the configured quota timezone.
 */

/** The pieces `Intl.DateTimeFormat` gives us, as numbers, from a UTC instant. */
interface ZoneParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function zoneParts(instant: Date, timeZone: string): ZoneParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value ?? '0';
    return Number.parseInt(value, 10);
  };
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Converts local wall-clock midnight in target timeZone to exact UTC instant with DST correction. */
function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day);
  const offsetGuess = zoneOffsetAt(new Date(naive), timeZone);
  let candidate = new Date(naive - offsetGuess);
  const parts = zoneParts(candidate, timeZone);
  
  if (parts.year !== year || parts.month !== month || parts.day !== day) {
    const offsetCorrected = zoneOffsetAt(candidate, timeZone);
    candidate = new Date(naive - offsetCorrected);
  }
  return candidate;
}

/** Offset (ms) to subtract from a UTC instant to obtain local wall-clock time in the zone. */
function zoneOffsetAt(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

/** The `period_start` for the calendar month containing `instant` in `timeZone` (UTC instant). */
export function periodStartFor(instant: Date, timeZone: string): Date {
  const { year, month } = zoneParts(instant, timeZone);
  return wallClockToInstant(year, month, 1, timeZone);
}

/** The `period_end` (exclusive) — the start of the *next* calendar month in `timeZone`. */
export function periodEndFor(instant: Date, timeZone: string): Date {
  const { year, month } = zoneParts(instant, timeZone);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return wallClockToInstant(nextYear, nextMonth, 1, timeZone);
}

/** The UTC instant the current period ends (for the API's `resetAt` detail). */
export function resetAtFor(instant: Date, timeZone: string): string {
  return periodEndFor(instant, timeZone).toISOString();
}

/** Invariant guard: `period_end` must be strictly after `period_start`. */
export function assertValidPeriod(start: Date, end: Date, timeZone: string): void {
  if (!(end.getTime() > start.getTime())) {
    throw new Error(`Invalid quota period for zone ${timeZone}: end ${end.toISOString()} <= start ${start.toISOString()}`);
  }
}
