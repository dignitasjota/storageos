import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal: incidencias (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function portalLogin(slug: string, email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return consume.body.accessToken as string;
  }

  it('el inquilino reporta una incidencia y la ve; el staff la encuentra', async () => {
    const owner = await registerVerifiedUser(app, 'pincident');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `pincident-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Sin token → 401.
    await request(app.getHttpServer()).get('/portal/me/incidents').expect(401);

    // Lista vacía al principio.
    const empty = await request(app.getHttpServer()).get('/portal/me/incidents').set(pAuth);
    expect(empty.status).toBe(200);
    expect(empty.body).toHaveLength(0);

    // Reportar incidencia.
    const report = await request(app.getHttpServer())
      .post('/portal/me/incidents')
      .set(pAuth)
      .send({
        title: 'La puerta del trastero no cierra bien',
        description: 'Cuesta echar la llave.',
      });
    expect(report.status).toBe(201);
    expect(report.body.status).toBe('reported');
    expect(report.body.severity).toBe('medium');
    const incidentId = report.body.id as string;

    // El inquilino la ve en su lista.
    const mine = await request(app.getHttpServer()).get('/portal/me/incidents').set(pAuth);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].id).toBe(incidentId);

    // El staff la encuentra en el panel.
    const staffList = await request(app.getHttpServer()).get('/incidents').set(auth);
    expect(staffList.status).toBe(200);
    expect(staffList.body.some((i: { id: string }) => i.id === incidentId)).toBe(true);

    // Validación: título demasiado corto → 400.
    const bad = await request(app.getHttpServer())
      .post('/portal/me/incidents')
      .set(pAuth)
      .send({ title: 'no' });
    expect(bad.status).toBe(400);
  });
});
