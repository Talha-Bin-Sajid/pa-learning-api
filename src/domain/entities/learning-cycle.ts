import type { IsoDate } from '../../shared/utils/dates.js';

/** A programme year (table: learning_cycles). */
export interface LearningCycle {
  id: string;
  year: number;
  name: string;
  startsOn: IsoDate;
  endsOn: IsoDate;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NewLearningCycle = Pick<LearningCycle, 'year' | 'name' | 'startsOn' | 'endsOn'>;
