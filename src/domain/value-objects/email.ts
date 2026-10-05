import { ValidationError } from '../../shared/errors/app-errors.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Normalised (trimmed, lower-cased) email address. */
export type Email = string & { readonly __brand: 'Email' };

export function toEmail(raw: string, path = 'email'): Email {
  const value = raw.trim().toLowerCase();
  if (!EMAIL.test(value) || value.length > 254) {
    throw new ValidationError('Enter a valid email address.', [{ path, message: 'Invalid email address' }]);
  }
  return value as Email;
}

export function emailDomain(email: Email): string {
  return email.slice(email.lastIndexOf('@') + 1);
}
