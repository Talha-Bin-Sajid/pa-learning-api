import type { IsoDate } from '../../shared/utils/dates.js';

/** Time source. Injected so "today" (Europe/London) is testable. */
export interface Clock {
  now(): Date;
  /** Today's calendar date in the firm's time zone. */
  today(): IsoDate;
}
