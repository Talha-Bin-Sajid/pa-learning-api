import { describe, expect, it } from 'vitest';
import { LearningProgress } from '../../src/domain/services/learning-progress.js';
import { audienceIncludes, toAudience } from '../../src/domain/value-objects/audience.js';
import { completion, item } from '../support/builders.js';

const TODAY = '2026-09-10';
const ACCOUNTANT = 2;
const SENIOR = 3;
const sarah = { id: 'sarah', designationId: ACCOUNTANT };
const ibraaheem = { id: 'ibraaheem', designationId: SENIOR };

describe('audience', () => {
  it('includes everyone, a designation, or a named person', () => {
    expect(audienceIncludes(toAudience({ all: true }), sarah)).toBe(true);
    expect(audienceIncludes(toAudience({ all: false, designationIds: [ACCOUNTANT] }), sarah)).toBe(true);
    expect(audienceIncludes(toAudience({ all: false, designationIds: [ACCOUNTANT] }), ibraaheem)).toBe(false);
    expect(audienceIncludes(toAudience({ all: false, profileIds: ['ibraaheem'] }), ibraaheem)).toBe(true);
  });

  it('clears lists for everyone and requires a target otherwise', () => {
    expect(toAudience({ all: true, designationIds: [1], profileIds: ['x'] })).toEqual({ all: true, designationIds: [], profileIds: [] });
    expect(() => toAudience({ all: false })).toThrow(/Choose who/);
  });

  it('deduplicates targets', () => {
    expect(toAudience({ all: false, designationIds: [1, 1], profileIds: ['a', 'a'] })).toEqual({ all: false, designationIds: [1], profileIds: ['a'] });
  });
});

describe('LearningProgress.planFor', () => {
  const aml = item({ title: 'AML', hours: 1.5, dueDate: '2026-03-31', isMandatory: true });
  const ethics = item({ title: 'Ethics', hours: 2.5, dueDate: '2026-06-30', isMandatory: true });
  const ifrs = item({ title: 'IFRS 16', hours: 3, dueDate: '2026-09-30', audience: toAudience({ all: false, designationIds: [SENIOR] }) });
  const audit = item({ title: 'Audit Quality', hours: 5, dueDate: '2026-11-30', audience: toAudience({ all: false, profileIds: ['ibraaheem'] }) });
  const archived = item({ title: 'Old', hours: 9, archivedAt: new Date() });
  const items = [aml, ethics, ifrs, audit, archived];

  it('assigns by audience and ignores archived items', () => {
    const progress = new LearningProgress(items, [], TODAY);
    expect(progress.planFor(sarah).entries.map((e) => e.item.title)).toEqual(['AML', 'Ethics']);
    expect(progress.planFor(ibraaheem).entries.map((e) => e.item.title)).toEqual(['AML', 'Ethics', 'IFRS 16', 'Audit Quality']);
  });

  it('derives completed / overdue / outstanding against today', () => {
    const progress = new LearningProgress(items, [completion('sarah', aml.id)], TODAY);
    const byTitle = Object.fromEntries(progress.planFor(sarah).entries.map((e) => [e.item.title, e]));
    expect(byTitle.AML).toMatchObject({ status: 'completed', daysOverdue: 0, daysUntilDue: null });
    expect(byTitle.Ethics).toMatchObject({ status: 'overdue', daysOverdue: 72, daysUntilDue: -72 });
  });

  it('treats an item due today as outstanding, not overdue', () => {
    const dueToday = item({ dueDate: TODAY });
    const [entry] = new LearningProgress([dueToday], [], TODAY).planFor(sarah).entries;
    expect(entry).toMatchObject({ status: 'outstanding', daysUntilDue: 0 });
  });

  it('computes hours-weighted completion %, matching the prototype', () => {
    // Prototype: Ibraaheem completed AML (1.5), Ethics (2.5), IFRS 16 (3) of 12h assigned → 58.33%.
    const comps = [completion('ibraaheem', aml.id), completion('ibraaheem', ethics.id), completion('ibraaheem', ifrs.id)];
    const { summary } = new LearningProgress(items, comps, TODAY).planFor(ibraaheem);
    expect(summary).toEqual({
      assigned: 4,
      completed: 3,
      outstanding: 1,
      overdue: 0,
      mandatoryAssigned: 2,
      mandatoryCompleted: 2,
      mandatoryOutstanding: 0,
      hoursAssigned: 12,
      hoursCompleted: 7,
      hoursOutstanding: 5,
      completionPct: 58.33,
      // No files on these completions (acknowledgement-style) → confirmed.
      confirmed: 3,
      mandatoryConfirmed: 2,
      hoursConfirmed: 7,
      underReview: 0,
      confirmedPct: 58.33,
    });
  });

  it('is 0% (not NaN) for someone with nothing assigned', () => {
    expect(new LearningProgress([], [], TODAY).planFor(sarah).summary.completionPct).toBe(0);
  });

  it('only counts completions inside a period when one is given', () => {
    const comps = [completion('sarah', aml.id, '2026-02-11'), completion('sarah', ethics.id, '2026-07-02')];
    const progress = new LearningProgress(items, comps, TODAY);
    const q3 = progress.planFor(sarah, { from: '2026-07-01', to: '2026-09-30' });
    expect(q3.entries.filter((e) => e.status === 'completed').map((e) => e.item.title)).toEqual(['Ethics']);
    expect(q3.entries.find((e) => e.item.title === 'AML')?.status).toBe('overdue');
  });

  it('lists assignees of an item', () => {
    const progress = new LearningProgress(items, [], TODAY);
    expect(progress.assigneesOf(ifrs, [sarah, ibraaheem]).map((p) => p.id)).toEqual(['ibraaheem']);
    expect(progress.assigneesOf(archived, [sarah, ibraaheem])).toEqual([]);
  });
});
