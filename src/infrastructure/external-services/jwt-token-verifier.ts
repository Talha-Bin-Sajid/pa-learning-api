import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthIdentity, AuthTokenVerifier } from '../../application/ports/identity-provider.js';
import { UnauthenticatedError } from '../../shared/errors/app-errors.js';

/**
 * Verifies Supabase access tokens.
 * - Default: asymmetric signing keys via the project's JWKS endpoint (cached by jose).
 * - Legacy projects: HS256 with SUPABASE_JWT_SECRET.
 */
export class SupabaseJwtVerifier implements AuthTokenVerifier {
  private readonly key: JWTVerifyGetKey | Uint8Array;
  private readonly issuer: string;

  constructor(supabaseUrl: string, jwtSecret?: string) {
    const base = supabaseUrl.replace(/\/$/, '');
    this.issuer = `${base}/auth/v1`;
    this.key = jwtSecret
      ? new TextEncoder().encode(jwtSecret)
      : createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<AuthIdentity> {
    try {
      const options = { issuer: this.issuer, audience: 'authenticated' };
      const { payload } =
        this.key instanceof Uint8Array
          ? await jwtVerify(token, this.key, options)
          : await jwtVerify(token, this.key, options);
      if (!payload.sub) throw new Error('Token has no subject');
      return { authUserId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
    } catch {
      throw new UnauthenticatedError('Your session has expired. Sign in again.', 'INVALID_TOKEN');
    }
  }
}
