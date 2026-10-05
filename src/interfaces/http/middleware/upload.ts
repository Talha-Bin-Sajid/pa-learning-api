import type { RequestHandler, Response } from 'express';
import multer from 'multer';
import { LIMITS } from '../../../shared/constants/limits.js';
import { PayloadTooLargeError, ValidationError } from '../../../shared/errors/app-errors.js';

/**
 * Single-file multipart upload kept in memory (files are small and go straight
 * to object storage). Real type checks happen in the domain (magic bytes).
 */
function singleFile(field: string, maxBytes: number, tooLargeMessage: string): RequestHandler {
  const handler = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 10_000 } }).single(field);
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return next(new PayloadTooLargeError(tooLargeMessage));
        return next(new ValidationError('The upload is not valid.', [{ path: field, message: err.code }], 'INVALID_UPLOAD'));
      }
      next(err);
    });
  };
}

export const evidenceUpload = singleFile('file', LIMITS.evidenceMaxBytes, 'Evidence files must be 15 MB or smaller.');
export const spreadsheetUpload = singleFile('file', LIMITS.importMaxBytes, 'Spreadsheets must be 5 MB or smaller.');

export function requireFile(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) throw new ValidationError('Attach a file.', [{ path: 'file', message: 'Required' }], 'FILE_REQUIRED');
  return file;
}

/** Sends a generated file as a download. */
export function sendDownload(res: Response, file: { fileName: string; content: Buffer }): void {
  const safe = file.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.content);
}
