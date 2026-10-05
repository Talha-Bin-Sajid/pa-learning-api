import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/application/use-cases/auth.service.js';
import { PgCycleRepository } from '../../src/infrastructure/repositories/pg-cycle-repository.js';
import { PgLookupRepository } from '../../src/infrastructure/repositories/pg-lookup-repository.js';
import { PgPersonRepository } from '../../src/infrastructure/repositories/pg-person-repository.js';
import { silentLogger } from '../../src/shared/utils/logger.js';
import { FakeIdentityProvider } from '../support/fakes.js';
import { seedPerson } from '../support/test-app.js';
import { PGliteDatabase } from '../support/test-database.js';

let db: PGliteDatabase;
let identity: FakeIdentityProvider;
let people: PgPersonRepository;

const service = (allowedEmailDomains: string[] = []) =>
  new AuthService(people, new PgLookupRepository(db), new PgCycleRepository(db), identity, db, silentLogger, {
    allowedEmailDomains,
  });

beforeAll(async () => {
  db = await PGliteDatabase.create();
  people = new PgPersonRepository(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('delete from profiles');
  identity = new FakeIdentityProvider();
});

describe('AuthService.register', () => {
  it('creates an active Team Member with own-reports access', async () => {
    const dto = await service().register({ fullName: 'Grace Lin', email: 'GLin@pa.co.uk', password: 'correct-horse-1' });
    expect(dto).toMatchObject({
      fullName: 'Grace Lin',
      email: 'glin@pa.co.uk',
      role: 'team_member',
      reportingAccess: 'self',
      status: 'active',
      hasAccount: true,
      initials: 'GL',
    });
    expect(identity.users.size).toBe(1);
  });

  it('links a person the Learning Team provisioned, keeping their role and designation', async () => {
    await seedPerson(db, { email: 'dokoro@pa.co.uk', fullName: 'Daniel Okoro', role: 'manager', designation: 'Director', linked: false });
    const dto = await service().register({ fullName: 'Dan', email: 'dokoro@pa.co.uk', password: 'correct-horse-1' });
    expect(dto).toMatchObject({ fullName: 'Daniel Okoro', role: 'manager', designation: { name: 'Director' }, hasAccount: true });
    expect(await people.count()).toBe(1);
  });

  it('refuses an email that already has an account', async () => {
    await seedPerson(db, { email: 'taken@pa.co.uk' });
    await expect(service().register({ fullName: 'X', email: 'taken@pa.co.uk', password: 'correct-horse-1' })).rejects.toMatchObject({
      code: 'EMAIL_TAKEN',
    });
  });

  it('enforces the allowed email domains', async () => {
    await expect(
      service(['projectaccountants.co.uk']).register({ fullName: 'X', email: 'x@gmail.com', password: 'correct-horse-1' }),
    ).rejects.toMatchObject({ code: 'DOMAIN_NOT_ALLOWED' });
  });

  it('removes the auth account again if saving the profile fails', async () => {
    // A provisioned-but-linked race: make profile creation fail by pre-inserting a conflicting email after the check.
    const svc = service();
    const original = people.create.bind(people);
    people.create = async () => {
      throw new Error('db down');
    };
    await expect(svc.register({ fullName: 'Y', email: 'y@pa.co.uk', password: 'correct-horse-1' })).rejects.toThrow('db down');
    people.create = original;
    expect(identity.users.size).toBe(0);
  });
});

describe('AuthService.resolveActor', () => {
  it('finds a linked person by auth id', async () => {
    const { authUserId, id } = await seedPerson(db, { email: 'a@pa.co.uk' });
    expect((await service().resolveActor({ authUserId: authUserId!, email: 'a@pa.co.uk' })).id).toBe(id);
  });

  it('links a provisioned person by email on first sign-in', async () => {
    const { id } = await seedPerson(db, { email: 'new@pa.co.uk', linked: false });
    const actor = await service().resolveActor({ authUserId: '6f1c5b7e-1111-4a2b-9c3d-000000000001', email: 'NEW@pa.co.uk' });
    expect(actor.id).toBe(id);
    expect(actor.authUserId).toBe('6f1c5b7e-1111-4a2b-9c3d-000000000001');
  });

  it('rejects inactive people', async () => {
    const { authUserId } = await seedPerson(db, { email: 'gone@pa.co.uk', status: 'inactive' });
    await expect(service().resolveActor({ authUserId: authUserId!, email: null })).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('applies the email-domain rule to accounts created outside /auth/register', async () => {
    await expect(
      service(['projectaccountants.co.uk']).resolveActor({ authUserId: '6f1c5b7e-3333-4a2b-9c3d-000000000003', email: 'outsider@gmail.com' }),
    ).rejects.toMatchObject({ code: 'DOMAIN_NOT_ALLOWED' });
    expect(await people.findByEmail('outsider@gmail.com')).toBeNull();
  });

  it('does not hijack an email already linked to a different auth account', async () => {
    await seedPerson(db, { email: 'owner@pa.co.uk' });
    await expect(
      service().resolveActor({ authUserId: '6f1c5b7e-2222-4a2b-9c3d-000000000002', email: 'owner@pa.co.uk' }),
    ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });
});
