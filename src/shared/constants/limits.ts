/** Limits shared by API validation and UI hints. */
export const LIMITS = {
  evidenceMaxBytes: 15 * 1024 * 1024,
  evidenceMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const,
  importMaxBytes: 5 * 1024 * 1024,
  importMaxRows: 1000,
  titleMax: 200,
  providerMax: 120,
  descriptionMax: 2000,
  reflectionMax: 2000,
  reminderMessageMax: 2000,
  nameMax: 120,
  hoursMax: 500,
  passwordMin: 10,
} as const;
