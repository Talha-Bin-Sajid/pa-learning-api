import type { Clock } from '../../application/ports/clock.js';
import { todayIn, type IsoDate } from '../../shared/utils/dates.js';

export class SystemClock implements Clock {
  constructor(private readonly timeZone: string) {}

  now(): Date {
    return new Date();
  }

  today(): IsoDate {
    return todayIn(this.timeZone);
  }
}
