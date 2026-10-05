import type { Person } from '../../domain/entities/person.js';
import { avatarColorFor } from '../../domain/entities/person.js';
import type { CycleRepository } from '../../domain/repositories/cycle-repository.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { permissionsFor, type Permissions } from '../../domain/services/access-policy.js';
import { emailDomain, toEmail, type Email } from '../../domain/value-objects/email.js';
import { ConflictError, ForbiddenError, ValidationError } from '../../shared/errors/app-errors.js';
import { LIMITS } from '../../shared/constants/limits.js';
import { toCycleDto, type CycleDto } from '../dto/cycle.dto.js';
import { toPersonDto, type PersonDto } from '../dto/person.dto.js';
import type { AuthIdentity, IdentityProvider } from '../ports/identity-provider.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { Logger } from '../../shared/utils/logger.js';

export interface RegisterInput {
  fullName: string;
  email: string;
  password: string;
}

export interface MeDto {
  profile: PersonDto;
  permissions: Permissions;
  currentCycle: CycleDto | null;
}

export interface AuthServiceOptions {
  /** Lower-case domains allowed to register; empty = any domain. */
  allowedEmailDomains: string[];
}

/**
 * Account lifecycle: self-registration, resolving the signed-in person from a
 * verified token, and the /me view. See ADR 0003 (people are provisioned by email).
 */
export class AuthService {
  constructor(
    private readonly people: PersonRepository,
    private readonly lookups: LookupRepository,
    private readonly cycles: CycleRepository,
    private readonly identity: IdentityProvider,
    private readonly uow: UnitOfWork,
    private readonly logger: Logger,
    private readonly options: AuthServiceOptions,
  ) {}

  async register(input: RegisterInput): Promise<PersonDto> {
    const email = toEmail(input.email);
    const fullName = input.fullName.trim();
    if (!fullName) throw new ValidationError('Enter your full name.', [{ path: 'fullName', message: 'Required' }]);
    if (input.password.length < LIMITS.passwordMin) {
      throw new ValidationError(`Use at least ${LIMITS.passwordMin} characters for your password.`, [
        { path: 'password', message: 'Too short' },
      ]);
    }
    this.assertDomainAllowed(email);

    const existing = await this.people.findByEmail(email);
    if (existing?.authUserId) throw new ConflictError('An account with this email already exists.', 'EMAIL_TAKEN');
    if (existing && existing.status === 'inactive') {
      throw new ForbiddenError('This account has been deactivated. Contact the Learning Team.', 'ACCOUNT_INACTIVE');
    }

    const { authUserId } = await this.identity.createUser({ email, password: input.password, fullName });

    try {
      const person = await this.uow.run(async () =>
        existing
          ? // Pre-provisioned by the Learning Team: keep their role/designation, just link the account.
            this.people.update(existing.id, { authUserId })
          : this.createTeamMember(fullName, email, authUserId),
      );
      return this.toDto(person);
    } catch (err) {
      // Compensate: never leave an auth account without a profile.
      await this.identity.deleteUser(authUserId).catch((cleanupErr: unknown) =>
        this.logger.error('Failed to roll back auth user after registration error', { authUserId, cleanupErr }),
      );
      throw err;
    }
  }

  /**
   * Maps a verified token to an active Person. Links by email on first sign-in
   * (users provisioned by the Learning Team, or created in the Supabase dashboard).
   */
  async resolveActor(identity: AuthIdentity): Promise<Person> {
    let person = await this.people.findByAuthUserId(identity.authUserId);
    if (!person && identity.email) {
      const email = toEmail(identity.email);
      person = await this.uow.run(async () => {
        const byEmail = await this.people.findByEmail(email);
        if (byEmail && !byEmail.authUserId) return this.people.update(byEmail.id, { authUserId: identity.authUserId });
        if (byEmail) return null; // email already linked to another auth account
        // Accounts created outside our /auth/register (e.g. directly against Supabase) obey the same domain rule.
        this.assertDomainAllowed(email);
        return this.createTeamMember(email.split('@')[0] ?? email, email, identity.authUserId);
      });
    }
    if (!person) throw new ForbiddenError('No profile is linked to this account.', 'PROFILE_NOT_FOUND');
    if (person.status !== 'active') {
      throw new ForbiddenError('Your account is not active. Contact the Learning Team.', 'ACCOUNT_INACTIVE');
    }
    return person;
  }

  async me(actor: Person): Promise<MeDto> {
    const [profile, currentCycle] = await Promise.all([
      this.toDto(actor),
      this.cycles.findCurrent(),
      this.people.touchLastSeen(actor.id),
    ]);
    return {
      profile,
      permissions: permissionsFor(actor),
      currentCycle: currentCycle ? toCycleDto(currentCycle) : null,
    };
  }

  private assertDomainAllowed(email: Email): void {
    const allowed = this.options.allowedEmailDomains;
    if (allowed.length > 0 && !allowed.includes(emailDomain(email))) {
      throw new ValidationError('Use your work email address.', [{ path: 'email', message: 'Domain not allowed' }], 'DOMAIN_NOT_ALLOWED');
    }
  }

  private async createTeamMember(fullName: string, email: string, authUserId: string): Promise<Person> {
    const seed = await this.people.count();
    return this.people.create({
      fullName,
      email,
      authUserId,
      role: 'team_member',
      designationId: null,
      reportingAccess: 'self',
      lineManagerId: null,
      status: 'active',
      avatarColor: avatarColorFor(seed),
    });
  }

  private async toDto(person: Person): Promise<PersonDto> {
    const [lookups, manager] = await Promise.all([
      this.lookups.all(),
      person.lineManagerId ? this.people.findById(person.lineManagerId) : Promise.resolve(null),
    ]);
    return toPersonDto(person, {
      designations: new Map(lookups.designations.map((d) => [d.id, d])),
      peopleById: new Map(manager ? [[manager.id, manager]] : []),
    });
  }
}
