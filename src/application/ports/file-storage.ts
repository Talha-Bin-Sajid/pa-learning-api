/** Private object storage for evidence files. */
export interface FileStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Read a stored file back (used by the evidence checker). */
  download(path: string): Promise<Uint8Array>;
  /** Time-limited URL that lets the browser view one file. */
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
}
