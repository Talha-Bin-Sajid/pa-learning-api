import type { LearningCycle } from '../../domain/entities/learning-cycle.js';

export interface CycleDto {
  id: string;
  year: number;
  name: string;
  startsOn: string;
  endsOn: string;
  isCurrent: boolean;
}

export function toCycleDto(c: LearningCycle): CycleDto {
  return { id: c.id, year: c.year, name: c.name, startsOn: c.startsOn, endsOn: c.endsOn, isCurrent: c.isCurrent };
}
