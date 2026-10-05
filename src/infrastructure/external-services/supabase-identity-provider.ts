import type { IdentityProvider } from '../../application/ports/identity-provider.js';
import { ConflictError, ExternalServiceError } from '../../shared/errors/app-errors.js';

/**
 * Supabase Auth admin API over plain fetch (no supabase-js dependency).
 * Uses the service-role key - backend only.
 */
export class SupabaseIdentityProvider implements IdentityProvider {
  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createUser(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<{ authUserId: string }> {
    const res = await this.call('POST', '/auth/v1/admin/users', {
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName },
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: string; user?: { id?: string } };
      const id = body.id ?? body.user?.id;
      if (!id)
        throw new ExternalServiceError('Could not create the account. Try again.', 'AUTH_PROVIDER_ERROR');
      return { authUserId: id };
    }
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      error_code?: string;
      msg?: string;
      message?: string;
    };
    const code = body.error_code ?? body.code;
    const message = body.msg ?? body.message ?? '';
    if (
      code === 'email_exists' ||
      code === 'user_already_exists' ||
      /already (been )?registered/i.test(message)
    ) {
      throw new ConflictError('An account with this email already exists.', 'EMAIL_TAKEN');
    }
    if (code === 'weak_password') {
      throw new ConflictError('Choose a stronger password.', 'WEAK_PASSWORD');
    }
    throw new ExternalServiceError('Could not create the account. Try again.', 'AUTH_PROVIDER_ERROR', {
      status: res.status,
      code,
      message,
    });
  }

  async deleteUser(authUserId: string): Promise<void> {
    const res = await this.call('DELETE', `/auth/v1/admin/users/${encodeURIComponent(authUserId)}`);
    if (!res.ok && res.status !== 404) {
      throw new ExternalServiceError('Could not remove the account.', 'AUTH_PROVIDER_ERROR', {
        status: res.status,
      });
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.supabaseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new ExternalServiceError(
        'The sign-in service is unavailable. Try again shortly.',
        'AUTH_PROVIDER_UNAVAILABLE',
        err,
      );
    }
  }
}
