import type { LearningItem, LearningItemFields, NewLearningItem } from '../entities/learning-item.js';

export interface LearningItemRepository {
  listByCycle(cycleId: string, options?: { includeArchived?: boolean }): Promise<LearningItem[]>;
  findById(id: string): Promise<LearningItem | null>;
  create(item: NewLearningItem): Promise<LearningItem>;
  /** Inserts many items (import / template copy). Must run inside a unit of work. */
  createMany(items: NewLearningItem[]): Promise<number>;
  update(id: string, fields: Partial<LearningItemFields>): Promise<LearningItem>;
  archive(id: string): Promise<void>;
}
