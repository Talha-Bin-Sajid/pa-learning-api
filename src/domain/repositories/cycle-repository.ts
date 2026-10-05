import type { LearningCycle, NewLearningCycle } from '../entities/learning-cycle.js';

export interface CycleRepository {
  list(): Promise<LearningCycle[]>;
  findById(id: string): Promise<LearningCycle | null>;
  findByYear(year: number): Promise<LearningCycle | null>;
  findCurrent(): Promise<LearningCycle | null>;
  create(cycle: NewLearningCycle): Promise<LearningCycle>;
  update(id: string, changes: Partial<Pick<LearningCycle, 'name' | 'startsOn' | 'endsOn'>>): Promise<LearningCycle>;
  /** Makes `id` the only current cycle. */
  setCurrent(id: string): Promise<void>;
}
