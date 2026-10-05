import type { IsoDate } from '../../shared/utils/dates.js';
import type { EvidenceMode } from '../enums.js';
import type { Audience } from '../value-objects/audience.js';

/** One required activity in a cycle's Learning Template (table: learning_items + audience tables). */
export interface LearningItem {
  id: string;
  cycleId: string;
  title: string;
  categoryId: number;
  cpdTypeId: number;
  deliveryTypeId: number;
  provider: string;
  hours: number;
  dueDate: IsoDate | null;
  isMandatory: boolean;
  evidenceMode: EvidenceMode;
  link: string | null;
  description: string | null;
  audience: Audience;
  createdBy: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LearningItemFields = Pick<
  LearningItem,
  | 'title'
  | 'categoryId'
  | 'cpdTypeId'
  | 'deliveryTypeId'
  | 'provider'
  | 'hours'
  | 'dueDate'
  | 'isMandatory'
  | 'evidenceMode'
  | 'link'
  | 'description'
  | 'audience'
>;

export type NewLearningItem = LearningItemFields & { cycleId: string; createdBy: string | null };
