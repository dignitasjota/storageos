import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { OnboardingDto } from '@storageos/shared';

describe('Puesta en marcha del tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  it('imprescindible y recomendado se deducen de lo configurado', async () => {
    const owner = await registerVerifiedUser(app, 'onboarding');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const get = async () =>
      (await http().get('/dashboard/onboarding').set(auth).expect(200)).body as OnboardingDto;
    const step = (o: OnboardingDto, key: string) => o.steps.find((s) => s.key === key);

    await ensureDefaultSeries(app, owner.accessToken);
    const start = await get();
    expect(start.completed).toBe(false);
    expect(start.requiredDone).toBe(0);
    // Con serie no se pide; sin local, los tipos llevan a la lista de locales.
    expect(step(start, 'series')).toBeUndefined();
    expect(step(start, 'unit_type')).toMatchObject({ done: false, href: '/facilities' });
    expect(step(start, 'unit')!.secondary).toEqual({ label: 'Importar', href: '/units/import' });
    expect(step(start, 'verifactu')).toMatchObject({ group: 'recommended', done: false });

    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    await http()
      .post('/settings/saas-billing/billing-details')
      .set(auth)
      .send({
        legalName: 'Trasteros Onboarding SL',
        taxId: '00000000T',
        address: 'C/ Mayor 1',
        city: 'Valencia',
        postalCode: '46001',
      })
      .expect(200);
    await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ transferIban: 'ES9121000418450200051332' })
      .expect(200);

    const after = await get();
    for (const key of ['facility', 'unit_type', 'unit', 'company', 'payments']) {
      expect(step(after, key)!.done).toBe(true);
    }
    // El tipo enlaza a la pestaña de tipos del primer local.
    expect(step(after, 'unit_type')!.href).toBe(`/facilities/${facilityId}?tab=unit-types`);
    expect(step(after, 'customer')!.done).toBe(false);
    expect(after.requiredDone).toBe(5);
    expect(after.requiredTotal).toBe(7);
    expect(after.progress).toBeCloseTo(5 / 7);

    await http().get('/dashboard/onboarding').expect(401);
  });
});
