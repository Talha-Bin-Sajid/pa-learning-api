import { createTestApp, type Signed, type TestApp, type TestAppOptions } from './test-app.js';

/**
 * A small firm mirroring the prototype:
 *   Amina  - Learning Team (admin)        Elena - HR
 *   Daniel - Manager (Director → full)    manages Sarah, Tomas
 *   Priya  - Manager (Manager → self)     manages Grace
 *   Sarah, Tomas (Accountant), Grace (Junior Accountant), Ibraaheem (Senior Accountant, no manager)
 */
export interface Org {
  t: TestApp;
  amina: Signed;
  elena: Signed;
  daniel: Signed;
  priya: Signed;
  sarah: Signed;
  tomas: Signed;
  grace: Signed;
  ibraaheem: Signed;
}

export async function createOrg(opts: TestAppOptions = {}): Promise<Org> {
  const t = await createTestApp(opts);
  const amina = await t.signInAs({
    email: 'apatel@pa.co.uk',
    fullName: 'Amina Patel',
    role: 'learning_team',
    reportingAccess: 'full',
    designation: 'Senior Manager',
  });
  const elena = await t.signInAs({
    email: 'emarsh@pa.co.uk',
    fullName: 'Elena Marsh',
    role: 'hr',
    reportingAccess: 'full',
    designation: 'Manager',
  });
  const daniel = await t.signInAs({
    email: 'dokoro@pa.co.uk',
    fullName: 'Daniel Okoro',
    role: 'manager',
    reportingAccess: 'full',
    designation: 'Director',
  });
  const priya = await t.signInAs({
    email: 'praman@pa.co.uk',
    fullName: 'Priya Raman',
    role: 'manager',
    reportingAccess: 'self',
    designation: 'Manager',
  });
  const sarah = await t.signInAs({
    email: 'swhitfield@pa.co.uk',
    fullName: 'Sarah Whitfield',
    designation: 'Accountant',
    lineManagerId: daniel.id,
  });
  const tomas = await t.signInAs({
    email: 'tneri@pa.co.uk',
    fullName: 'Tomas Neri',
    designation: 'Accountant',
    lineManagerId: daniel.id,
  });
  const grace = await t.signInAs({
    email: 'glin@pa.co.uk',
    fullName: 'Grace Lin',
    designation: 'Junior Accountant',
    lineManagerId: priya.id,
  });
  const ibraaheem = await t.signInAs({
    email: 'imoolla@pa.co.uk',
    fullName: 'Ibraaheem Moolla',
    designation: 'Senior Accountant',
  });
  return { t, amina, elena, daniel, priya, sarah, tomas, grace, ibraaheem };
}
