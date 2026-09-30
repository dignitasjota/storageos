import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Los correos que un tenant manda a sus inquilinos salen con su nombre como
 * remitente visible y las respuestas van a su email (no a no-reply). Los
 * correos de cuenta del propio tenant siguen saliendo como la plataforma.
 */
describe('Remitente del tenant en correos a inquilinos (e2e)', () => {
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

  it('el enlace de acceso al portal sale a nombre del tenant con respuesta a su email', async () => {
    const owner = await registerVerifiedUser(app, 'sender', {
      tenantName: 'Trasteros "García" <Norte>',
    });
    const email = `sender-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: owner.slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });

    // Nombre saneado (sin comillas ni <>), dirección de la plataforma.
    expect(mail.From.Name).toBe('Trasteros García Norte');
    expect(mail.From.Address).toBe(process.env.EMAIL_FROM_ADDRESS ?? 'no-reply@storageos.local');
    // Respuestas al email de facturación del tenant (el del alta).
    expect(mail.ReplyTo?.[0]?.Address).toBe(owner.email);
  });

  it('el email de verificación de cuenta sigue saliendo como la plataforma', async () => {
    const owner = await registerVerifiedUser(app, 'sender-platform', {
      tenantName: 'Trasteros Sur',
    });
    const mail = await waitForEmail(owner.email, { subjectIncludes: 'Verifica' });
    expect(mail.From.Name).not.toBe('Trasteros Sur');
    expect(mail.ReplyTo ?? []).toHaveLength(0);
  });
});
