import { describe, expect, it } from 'vitest';
import { composeReviewDigestEmail } from '../../src/application/services/reminder-email.js';
import type { Completion } from '../../src/domain/entities/completion.js';
import { isConfirmed, LearningProgress } from '../../src/domain/services/learning-progress.js';
import { planAutomaticReminders, triggersFor } from '../../src/domain/services/reminder-planner.js';
import { completion, item, settings } from '../support/builders.js';

const TODAY = '2026-09-10';
const person = { id: 'p1', designationId: null };
const file = { path: 'x.pdf', fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10 };
const done = (itemId: string, over: Partial<Completion>): Completion => ({ ...completion('p1', itemId), evidence: file, ...over });

describe('isConfirmed', () => {
  it('confirms verified evidence and items that need no file', () => {
    expect(isConfirmed(done('a', { reviewStatus: 'verified', reviewSource: 'ai' }))).toBe(true);
    expect(isConfirmed(done('a', { reviewStatus: 'verified', reviewSource: 'manual' }))).toBe(true);
    expect(isConfirmed(completion('p1', 'a'))).toBe(true); // acknowledgement, no file
  });

  it('does not confirm evidence that is still being checked or flagged', () => {
    expect(isConfirmed(done('a', { reviewStatus: 'not_reviewed' }))).toBe(false);
    expect(isConfirmed(done('a', { reviewStatus: 'flagged', reviewSource: 'ai' }))).toBe(false);
  });
});

describe('progress with confirmation', () => {
  const items = ['v', 'f', 'n', 'ack', 'r', 'todo'].map((id) => item({ id, title: id, hours: 2, dueDate: '2026-12-31', isMandatory: id === 'f' }));
  const completions = [
    done('v', { reviewStatus: 'verified', reviewSource: 'ai' }),
    done('f', { reviewStatus: 'flagged', reviewSource: 'ai' }),
    done('n', { reviewStatus: 'not_reviewed' }),
    completion('p1', 'ack'),
    done('r', { reviewStatus: 'rejected', reviewSource: 'manual', reviewNotes: 'Wrong course' }),
  ];
  const plan = new LearningProgress(items, completions, TODAY).planFor(person);
  const by = Object.fromEntries(plan.entries.map((e) => [e.item.id, e]));

  it('counts under-review work for the person, and confirmed work separately', () => {
    expect(plan.summary).toMatchObject({
      assigned: 6,
      completed: 4, // v, f, n, ack - flagged / unchecked still count
      confirmed: 2, // v, ack
      underReview: 2, // f, n
      mandatoryCompleted: 1,
      mandatoryConfirmed: 0,
      hoursCompleted: 8,
      hoursConfirmed: 4,
      completionPct: 66.67,
      confirmedPct: 33.33,
    });
  });

  it('marks each entry', () => {
    expect([by.v!.confirmed, by.f!.confirmed, by.n!.confirmed, by.ack!.confirmed]).toEqual([true, false, false, true]);
    expect(by.r).toMatchObject({ status: 'outstanding', confirmed: false, completion: null });
    expect(by.r!.rejected?.reviewNotes).toBe('Wrong course');
  });
});

describe('reminders and evidence review', () => {
  const rejectedOn = (date: string) =>
    new LearningProgress(
      [item({ id: 'i0', dueDate: '2026-12-31' })],
      [done('i0', { reviewStatus: 'rejected', reviewSource: 'manual', reviewNotes: 'Blurry', reviewedAt: new Date(`${date}T14:00:00Z`) })],
      TODAY,
    ).planFor(person);

  it('reminds the morning after a rejection, once', () => {
    const day = { today: TODAY, timeZone: 'Europe/London' };
    expect(triggersFor(rejectedOn('2026-09-09').entries, settings(), day)).toEqual(['evidence_rejected']);
    expect(triggersFor(rejectedOn('2026-09-10').entries, settings(), day)).toEqual([]); // later today → tomorrow
    expect(triggersFor(rejectedOn('2026-09-07').entries, settings(), day)).toEqual([]);
    const [r] = planAutomaticReminders([rejectedOn('2026-09-09')], settings(), TODAY);
    expect(r).toMatchObject({ triggers: ['evidence_rejected'] });
    expect(r!.outstanding).toHaveLength(1);
  });

  it('never chases work that is only waiting for review', () => {
    const p = new LearningProgress(
      [item({ id: 'i0', dueDate: '2026-09-24' })], // due in 14 days - a lead-day trigger if outstanding
      [done('i0', { reviewStatus: 'flagged', reviewSource: 'ai' })],
      TODAY,
    ).planFor(person);
    expect(planAutomaticReminders([p], settings(), TODAY)).toEqual([]);
  });

  it('builds a readable digest for the Learning Team', () => {
    const mail = composeReviewDigestEmail({
      to: 'amina@pa.co.uk',
      firstName: 'Amina',
      waiting: 3,
      stale: [{ personName: 'Sarah <b>', title: 'AML', daysWaiting: 8, reason: 'Name not confirmed.' }],
      overDays: 5,
      appUrl: 'https://lms.test',
    });
    expect(mail.subject).toBe('1 evidence submission waiting for review over 5 days');
    expect(mail.text).toContain('Sarah <b> - AML - 8 days');
    expect(mail.text).toContain('https://lms.test/evidence');
    expect(mail.html).toContain('Sarah &lt;b&gt;'); // escaped
  });
});
