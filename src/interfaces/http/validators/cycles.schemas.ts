import { z } from 'zod';
import { isoDate, uuid } from './common.schemas.js';

export const createCycleBody = z.object({
  year: z.number().int().min(2000).max(2100),
  name: z.string().trim().max(60).optional(),
  startsOn: isoDate,
  endsOn: isoDate,
  makeCurrent: z.boolean().optional(),
  copyItemsFromCycleId: uuid.optional(),
});

export const updateCycleBody = z
  .object({
    name: z.string().trim().max(60).optional(),
    startsOn: isoDate.optional(),
    endsOn: isoDate.optional(),
    makeCurrent: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one change');
