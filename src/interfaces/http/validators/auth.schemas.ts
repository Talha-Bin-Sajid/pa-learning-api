import { z } from 'zod';
import { LIMITS } from '../../../shared/constants/limits.js';

export const registerBody = z.object({
  fullName: z.string().trim().min(1, 'Required').max(LIMITS.nameMax),
  email: z.email('Enter a valid email address').max(254),
  password: z.string().min(LIMITS.passwordMin, `At least ${LIMITS.passwordMin} characters`).max(128),
});
