import type { Completion } from '../../src/domain/entities/completion.js';
import type { LearningItem } from '../../src/domain/entities/learning-item.js';
import type { ReminderSettings } from '../../src/domain/entities/reminder.js';

let seq = 0;
const next = () => `id-${++seq}`;

export function item(over: Partial<LearningItem> = {}): LearningItem {
  return {
    id: next(),
    cycleId: 'cycle-2026',
    title: 'Item',
    categoryId: 1,
    cpdTypeId: 1,
    deliveryTypeId: 1,
    provider: 'ICAEW',
    hours: 1,
    dueDate: null,
    isMandatory: false,
    evidenceMode: 'certificate',
    link: null,
    description: null,
    audience: { all: true, designationIds: [], profileIds: [] },
    createdBy: null,
    archivedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

export function completion(profileId: string, itemId: string, completedOn = '2026-02-01'): Completion {
  return {
    id: next(),
    profileId,
    itemId,
    completedOn,
    reflection: null,
    evidence: null,
    evidenceSha256: null,
    reviewStatus: 'not_reviewed',
    reviewSource: null,
    reviewNotes: null,
    reviewedAt: null,
    submittedAt: new Date(0),
    updatedAt: new Date(0),
  };
}

export function settings(over: Partial<ReminderSettings> = {}): ReminderSettings {
  return {
    autoEnabled: true,
    leadDays: [30, 14, 7],
    overdueFrequency: 'weekly',
    sendTime: '09:00',
    timezone: 'Europe/London',
    ccLineManager: 'overdue',
    updatedAt: new Date(0),
    ...over,
  };
}
