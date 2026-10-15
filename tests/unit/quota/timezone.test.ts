import { describe, expect, it } from 'vitest';
import { periodEndFor, periodStartFor, assertValidPeriod } from '@/quota/domain/timezone.ts';

describe('quota period boundaries', () => {
  it('Asia/Jakarta: a month starts at 17:00Z on the last day of the previous month', () => {
    // 2026-10-01 00:00 +07:00 == 2026-09-30T17:00:00Z
    const instant = new Date('2026-10-01T02:00:00+07:00');
    const start = periodStartFor(instant, 'Asia/Jakarta');
    const end = periodEndFor(instant, 'Asia/Jakarta');
    expect(start.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    assertValidPeriod(start, end, 'Asia/Jakarta');
  });

  it('UTC-adjacent instant before local midnight belongs to the previous month', () => {
    // 2026-10-01 00:30 +07:00 is 2026-09-30T17:30Z — still Oct 1 locally.
    const justBefore = new Date('2026-09-30T16:59:59Z');
    const justAfter = new Date('2026-09-30T17:00:00Z');
    expect(periodStartFor(justBefore, 'Asia/Jakarta').toISOString()).toBe(
      '2026-08-31T17:00:00.000Z',
    );
    expect(periodStartFor(justAfter, 'Asia/Jakarta').toISOString()).toBe(
      '2026-09-30T17:00:00.000Z',
    );
  });

  it('UTC behaves as plain calendar months', () => {
    const instant = new Date('2026-03-15T12:00:00Z');
    expect(periodStartFor(instant, 'UTC').toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(periodEndFor(instant, 'UTC').toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('handles a DST-observing zone across a spring-forward boundary', () => {
    // America/New_York: March 2026 — DST starts Mar 8; month start is local midnight Mar 1
    // = 05:00Z (EST, UTC-5); April 1 = 04:00Z (EDT, UTC-4).
    const march = new Date('2026-03-15T12:00:00Z');
    const april = new Date('2026-04-15T12:00:00Z');
    expect(periodStartFor(march, 'America/New_York').toISOString()).toBe(
      '2026-03-01T05:00:00.000Z',
    );
    expect(periodStartFor(april, 'America/New_York').toISOString()).toBe(
      '2026-04-01T04:00:00.000Z',
    );
  });

  it('handles leap-year February', () => {
    // 2028 is a leap year: March 1 follows Feb 29.
    const instant = new Date('2028-02-10T12:00:00Z');
    expect(periodEndFor(instant, 'UTC').toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  it('end of year rolls to the next January', () => {
    const instant = new Date('2026-12-31T23:59:59Z');
    expect(periodStartFor(instant, 'UTC').toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(periodEndFor(instant, 'UTC').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
