import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Captura email-first del booking: el visitante deja su email y se guarda un
 * lead (aunque no complete la reserva), visible para el staff. Idempotente.
 */
describe('Booking email-first (captura de lead) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('captura un lead al dejar el email; el staff lo ve; es idempotente', async () => {
    const owner = await registerVerifiedUser(app, 'emailfirst');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const email = `visitante-${Date.now()}@e2e.local`;

    // El visitante deja su email (sin completar el booking).
    const cap1 = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}/lead`)
      .send({ email, firstName: 'Nora', facilityId, unitTypeId });
    expect(cap1.status).toBe(201);
    expect(cap1.body.captured).toBe(true);

    // El staff ve el lead capturado.
    const leads1 = await request(app.getHttpServer()).get('/leads').set(auth);
    const mine = (leads1.body as { email: string; id: string }[]).filter((l) => l.email === email);
    expect(mine).toHaveLength(1);

    // Reintento con el mismo email → NO duplica (idempotente).
    const cap2 = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}/lead`)
      .send({ email, facilityId, unitTypeId });
    expect(cap2.status).toBe(201);
    const leads2 = await request(app.getHttpServer()).get('/leads').set(auth);
    expect((leads2.body as { email: string }[]).filter((l) => l.email === email)).toHaveLength(1);

    // Honeypot relleno → no captura.
    const bot = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}/lead`)
      .send({ email: `bot-${Date.now()}@e2e.local`, website: 'spam' });
    expect(bot.body.captured).toBe(false);
  });
});
