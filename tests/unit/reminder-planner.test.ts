import { describe, expect, it } from 'vitest';
import { LearningProgress } from '../../src/domain/services/learning-progress.js';
import { planAutomaticReminders, shouldCcManager, triggersFor } from '../../src/domain/services/reminder-planner.js';
import { completion, item, settings } from '../support/builders.js';

const TODAY = '2026-09-10';
const person = { id: 'p1', designationId: null };

const plan = (dueDates: (string | null)[], done: string[] = []) => {
  const items = dueDates.map((d, i) => item({ id: `i${i}`, dueDate: d }));
  return new LearningProgress(items, done.map((id) => completion('p1', id)), TODAY).planFor(person);
};

describe('triggersFor', () => {
  it('fires on each configured lead day exactly', () => {
    expect(triggersFor(plan(['2026-10-10']).entries, settings())).toEqual(['due_in_30']);
    expect(triggersFor(plan(['2026-09-24']).entries, settings())).toEqual(['due_in_14']);
    expect(triggersFor(plan(['2026-09-17']).entries, settings())).toEqual(['due_in_7']);
    expect(triggersFor(plan(['2026-09-18']).entries, settings())).toEqual([]);
  });

  it('fires on the first overdue day and then every week / fortnight / day', () => {
    const overdueBy = (days: number) => {
      const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
      return plan([d]).entries;
    };
    expect(triggersFor(overdueBy(1), settings())).toEqual(['overdue']);
    expect(triggersFor(overdueBy(2), settings())).toEqual([]);
    expect(triggersFor(overdueBy(8), settings())).toEqual(['overdue']);
    expect(triggersFor(overdueBy(8), settings({ overdueFrequency: 'fortnightly' }))).toEqual([]);
    expect(triggersFor(overdueBy(15), settings({ overdueFrequency: 'fortnightly' }))).toEqual(['overdue']);
    expect(triggersFor(overdueBy(2), settings({ overdueFrequency: 'daily' }))).toEqual(['overdue']);
  });

  it('ignores completed and undated items', () => {
    expect(triggersFor(plan(['2026-09-24'], ['i0']).entries, settings())).toEqual([]);
    expect(triggersFor(plan([null]).entries, settings())).toEqual([]);
  });
});

describe('planAutomaticReminders', () => {
  it('sends nothing when automatic reminders are off', () => {
    expect(planAutomaticReminders([plan(['2026-09-24'])], settings({ autoEnabled: false }))).toEqual([]);
  });

  it('aggregates one reminder per person listing everything outstanding', () => {
    const [r] = planAutomaticReminders([plan(['2026-09-24', '2026-12-01', '2026-09-09'])], settings());
    expect(r).toMatchObject({ triggers: ['due_in_14', 'overdue'], overdueCount: 1, ccLineManager: true });
    expect(r!.outstanding).toHaveLength(3);
  });

  it('skips people with no trigger today', () => {
    expect(planAutomaticReminders([plan(['2026-12-01'])], settings())).toEqual([]);
  });
});

describe('shouldCcManager', () => {
  it('follows the policy', () => {
    expect(shouldCcManager('never', 3)).toBe(false);
    expect(shouldCcManager('overdue', 0)).toBe(false);
    expect(shouldCcManager('overdue', 1)).toBe(true);
    expect(shouldCcManager('always', 0)).toBe(true);
  });
});
