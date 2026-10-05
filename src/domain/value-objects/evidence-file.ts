import { LIMITS } from '../../shared/constants/limits.js';
import { PayloadTooLargeError, UnsupportedMediaError } from '../../shared/errors/app-errors.js';

/** Metadata of an uploaded evidence file (the bytes live in object storage). */
export interface EvidenceFile {
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export type EvidenceMimeType = (typeof LIMITS.evidenceMimeTypes)[number];

const EXTENSION: Record<EvidenceMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Identifies the real file type from its first bytes ("magic numbers"),
 * ignoring the client-supplied name and MIME type.
 */
export function sniffEvidenceType(bytes: Uint8Array): EvidenceMimeType | null {
  const b = bytes;
  const ascii = (start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Validates an upload and returns its true MIME type and a safe extension. */
export function validateEvidenceUpload(bytes: Uint8Array): { mimeType: EvidenceMimeType; extension: string } {
  if (bytes.length === 0) throw new UnsupportedMediaError('The file is empty.', 'EMPTY_FILE');
  if (bytes.length > LIMITS.evidenceMaxBytes) {
    throw new PayloadTooLargeError('Evidence files must be 15 MB or smaller.');
  }
  const mimeType = sniffEvidenceType(bytes);
  if (!mimeType) throw new UnsupportedMediaError('Upload a PNG, JPG, WEBP or PDF file.');
  return { mimeType, extension: EXTENSION[mimeType] };
}

/** Display-safe file name: strips paths and control characters, caps the length. */
export function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  return (cleaned || fallback).slice(0, 255);
}
