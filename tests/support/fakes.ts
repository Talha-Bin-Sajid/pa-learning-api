import { randomUUID } from 'node:crypto';
import type { Clock } from '../../src/application/ports/clock.js';
import type { EmailMessage, EmailSender } from '../../src/application/ports/email-sender.js';
import type {
  EvidenceAnalyzer,
  EvidenceAnalyzerInput,
  EvidenceAnalyzerOutput,
} from '../../src/application/ports/evidence-analyzer.js';
import type { FileStorage } from '../../src/application/ports/file-storage.js';
import type { EvidenceAnalysis } from '../../src/domain/value-objects/evidence-analysis.js';
import type { AuthIdentity, AuthTokenVerifier, IdentityProvider } from '../../src/application/ports/identity-provider.js';
import { ConflictError, UnauthenticatedError } from '../../src/shared/errors/app-errors.js';

/** In-memory auth provider. */
export class FakeIdentityProvider implements IdentityProvider {
  readonly users = new Map<string, { email: string; fullName: string }>();
  failNextCreate = false;

  async createUser(input: { email: string; password: string; fullName: string }) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('provider down');
    }
    if ([...this.users.values()].some((u) => u.email === input.email)) {
      throw new ConflictError('An account with this email already exists.', 'EMAIL_TAKEN');
    }
    const authUserId = randomUUID();
    this.users.set(authUserId, { email: input.email, fullName: input.fullName });
    return { authUserId };
  }

  async deleteUser(authUserId: string) {
    this.users.delete(authUserId);
  }
}

/**
 * Accepts tokens of the form `test:<authUserId>:<email>`; anything else is rejected.
 * Lets API tests act as any person without real JWTs.
 */
export class FakeTokenVerifier implements AuthTokenVerifier {
  async verify(token: string): Promise<AuthIdentity> {
    const [prefix, authUserId, email] = token.split(':');
    if (prefix !== 'test' || !authUserId) throw new UnauthenticatedError('Your session has expired. Sign in again.', 'INVALID_TOKEN');
    return { authUserId, email: email || null };
  }
}

/** In-memory object storage. */
export class FakeFileStorage implements FileStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async upload(path: string, bytes: Uint8Array, contentType: string) {
    this.objects.set(path, { bytes, contentType });
  }

  async remove(path: string) {
    this.objects.delete(path);
  }

  async download(path: string) {
    const obj = this.objects.get(path);
    if (!obj) throw new Error(`no object ${path}`);
    return obj.bytes;
  }

  async signedUrl(path: string, expiresInSeconds: number) {
    return `https://storage.test/${path}?expires=${expiresInSeconds}`;
  }
}

/** Captures outgoing email. */
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failFor = new Set<string>();

  async send(message: EmailMessage) {
    if (this.failFor.has(message.to)) throw new Error('smtp rejected');
    this.sent.push(message);
  }
}

export class FixedClock implements Clock {
  constructor(public todayValue = '2026-09-10') {}
  now() {
    return new Date(`${this.todayValue}T09:00:00Z`);
  }
  today() {
    return this.todayValue;
  }
}

export const tokenFor =(authUserId: string, email = '') => `Bearer test:${authUserId}:${email}`;

/** Scriptable stand-in for the AI model. */
export class FakeEvidenceAnalyzer implements EvidenceAnalyzer {
  readonly calls: EvidenceAnalyzerInput[] = [];
  /** What the next call returns (or throws); defaults to `result`. */
  readonly queue: (Partial<EvidenceAnalysis> | Error)[] = [];
  result: Partial<EvidenceAnalysis> = {};

  async analyze(input: EvidenceAnalyzerInput): Promise<EvidenceAnalyzerOutput> {
    this.calls.push(input);
    const next = this.queue.shift() ?? this.result;
    if (next instanceof Error) throw next;
    const e = input.expected;
    return {
      provider: 'fake',
      model: 'fake-model',
      inputTokens: 1000,
      outputTokens: 200,
      analysis: {
        isCertificate: true,
        documentType: 'Course completion certificate',
        extracted: {
          participantName: e.personName,
          courseTitle: e.itemTitle,
          provider: e.provider,
          completionDate: e.completedOn,
          hours: e.hours,
          certificateId: null,
        },
        checks: { name: 'match', title: 'match', provider: 'match' },
        tamperingSigns: [],
        confidence: 0.95,
        summary: 'Looks fine.',
        ...next,
      },
    };
  }
}
