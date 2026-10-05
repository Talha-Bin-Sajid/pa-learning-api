import { z } from 'zod';

export const uuid = z.uuid('Must be a valid id');
export const isoDate = z.iso.date('Use the format YYYY-MM-DD');
export const idParams = z.object({ id: uuid });
