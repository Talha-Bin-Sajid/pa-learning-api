import { describe, expect, it } from 'vitest';
import { toEmail } from '../../src/domain/value-objects/email.js';
import { ValidationError } from '../../src/shared/errors/app-errors.js';
import { addYears, daysBetween, isIsoDate, todayIn } from '../../src/shared/utils/dates.js';

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('26-02-01')).toBe(false);
  });

  it('computes today in the firm time zone, not UTC', () => {
    // 23:30 UTC on 30 June is already 1 July in London (BST, UTC+1).
    expect(todayIn('Europe/London', new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
    // In winter London is on UTC.
    expect(todayIn('Europe/London', new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-15');
  });

  it('counts whole days between dates', () => {
    expect(daysBetween('2026-09-10', '2026-09-24')).toBe(14);
    expect(daysBetween('2026-09-24', '2026-09-10')).toBe(-14);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // across the clock change
  });

  it('shifts dates by whole years, clamping 29 Feb', () => {
    expect(addYears('2026-03-31', 1)).toBe('2027-03-31');
    expect(addYears('2028-02-29', 1)).toBe('2029-02-28');
  });
});

describe('toEmail', () => {
  it('normalises case and whitespace', () => {
    expect(toEmail('  IMoolla@ProjectAccountants.co.uk ')).toBe('imoolla@projectaccountants.co.uk');
  });

  it('rejects invalid addresses with a field detail', () => {
    expect(() => toEmail('nope')).toThrow(ValidationError);
  });
});
