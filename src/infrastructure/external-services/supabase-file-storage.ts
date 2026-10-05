import type { FileStorage } from '../../application/ports/file-storage.js';
import { ExternalServiceError } from '../../shared/errors/app-errors.js';

/** Supabase Storage REST API over plain fetch (service-role, private bucket). */
export class SupabaseFileStorage implements FileStorage {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly bucket: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${supabaseUrl.replace(/\/$/, '')}/storage/v1`;
  }

  async upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const res = await this.call(`/object/${this.bucket}/${encodePath(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-upsert': 'false', 'cache-control': 'private, max-age=0' },
      body: bytes,
    });
    if (!res.ok) throw await failure('Could not store the file. Try again.', res);
  }

  async remove(path: string): Promise<void> {
    const res = await this.call(`/object/${this.bucket}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!res.ok && res.status !== 404) throw await failure('Could not remove the old file.', res);
  }

  async download(path: string): Promise<Uint8Array> {
    const res = await this.call(`/object/authenticated/${this.bucket}/${encodePath(path)}`, { method: 'GET' });
    if (!res.ok) throw await failure('Could not read the file.', res);
    return new Uint8Array(await res.arrayBuffer());
  }

  async signedUrl(path: string, expiresInSeconds: number): Promise<string> {
    const res = await this.call(`/object/sign/${this.bucket}/${encodePath(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });
    if (!res.ok) throw await failure('Could not open the file.', res);
    const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const relative = body.signedURL ?? body.signedUrl;
    if (!relative) throw new ExternalServiceError('Could not open the file.', 'STORAGE_ERROR');
    return relative.startsWith('http') ? relative : `${this.base}${relative.startsWith('/') ? '' : '/'}${relative}`;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { apikey: this.serviceRoleKey, Authorization: `Bearer ${this.serviceRoleKey}`, ...init.headers },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ExternalServiceError('File storage is unavailable. Try again shortly.', 'STORAGE_UNAVAILABLE', err);
    }
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function failure(message: string, res: Response): Promise<ExternalServiceError> {
  const detail = await res.text().catch(() => '');
  return new ExternalServiceError(message, 'STORAGE_ERROR', { status: res.status, detail: detail.slice(0, 300) });
}
