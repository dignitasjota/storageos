import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages, getMessageHeaders, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Comunicaciones comerciales (LSSI art. 21): campañas solo a clientes sin baja y
 * a leads con consentimiento; enlace y cabecera de baja en cada correo; la baja
 * desde el enlace deja fuera al destinatario.
 */
describe('Baja y consentimiento en comunicaciones comerciales (e2e)', () => {
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

  it('flujo completo', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'mktunsub');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const stamp = Date.now();
    const emailA = `mkt-a-${stamp}@e2e.local`;
    const emailB = `mkt-b-${stamp}@e2e.local`;

    const mkCustomer = async (email: string, tag: string) =>
      (
        await http()
          .post('/customers')
          .set(auth)
          .send({
            customerType: 'individual',
            firstName: 'Cli',
            lastName: tag,
            email,
            country: 'ES',
            tags: [`mkt${stamp}`],
          })
          .expect(201)
      ).body.id as string;
    await mkCustomer(emailA, 'A');
    const b = await mkCustomer(emailB, 'B');

    // El staff da de baja a B (lo pidió por teléfono).
    const off = await http()
      .post(`/customers/${b}/marketing`)
      .set(auth)
      .send({ subscribed: false });
    expect(off.status).toBe(200);
    expect(off.body.marketingOptOutAt).toBeTruthy();

    // Leads: sin consentimiento no cuentan; con consentimiento sí.
    await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Sin', email: `nl-${stamp}@e2e.local` });
    const withConsent = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Con', email: `cl-${stamp}@e2e.local`, marketingConsent: true })
      .expect(201);
    expect(withConsent.body.marketingConsentAt).toBeTruthy();
    const leads = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'leads' } })
      .expect(200);
    expect(leads.body.audienceCount).toBe(1);

    // Marca del tenant: el correo comercial (solo texto) sale con su color.
    // (Directo en BD: el endpoint resuelve el DNS del logo, que en test no hay.)
    await app.get(PrismaAdminService).tenant.update({
      where: { slug: owner.slug },
      data: { portalBrandColor: '#ff6600', portalLogoUrl: 'https://example.com/logo.png' },
    });

    // Campaña a los clientes del tag: solo A.
    const segment = { audience: 'customers', tag: `mkt${stamp}` };
    const preview = await http().post('/campaigns/preview').set(auth).send({ segment }).expect(200);
    expect(preview.body.audienceCount).toBe(1);
    const campaign = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Oferta',
        subject: 'Oferta de otoño',
        bodyText: 'Hola, 10% este mes.',
        segment,
      })
      .expect(201);
    await http().post(`/campaigns/${campaign.body.id}/send`).set(auth).expect(200);

    // El correo lleva pie y cabecera de baja de un clic.
    const mail = await waitForEmail(emailA, { subjectIncludes: 'Oferta de otoño' });
    expect(mail.Text).toContain('Darme de baja de estas comunicaciones:');
    // Carcasa con la marca: logo, color y el texto en párrafos (no `<pre>`).
    expect(mail.HTML).toContain('#ff6600');
    expect(mail.HTML).toContain('<img src="https://example.com/logo.png"');
    expect(mail.HTML).not.toContain('<pre>');
    expect(mail.HTML).toContain('Darme de baja de estas comunicaciones');
    const link = /\/unsubscribe\/([^\s"<]+)/.exec(mail.Text)?.[1];
    expect(link).toBeTruthy();
    const token = decodeURIComponent(link!);
    const headers = await getMessageHeaders(mail.ID);
    expect(headers['List-Unsubscribe']?.[0]).toContain(`/v1/public/unsubscribe/`);
    expect(headers['List-Unsubscribe-Post']?.[0]).toBe('List-Unsubscribe=One-Click');

    // Página de baja: muestra el email oculto y da de baja (idempotente).
    const info = await http().get(`/public/unsubscribe/${token}`).expect(200);
    expect(info.body).toMatchObject({ unsubscribed: false, email: `m***@e2e.local` });
    await http().post(`/public/unsubscribe/${token}`).expect(200);
    const again = await http().post(`/public/unsubscribe/${token}`).expect(200);
    expect(again.body.unsubscribed).toBe(true);
    await http().get(`/public/unsubscribe/${token}x`).expect(404);

    // A ya no entra en la siguiente campaña.
    const after = await http().post('/campaigns/preview').set(auth).send({ segment }).expect(200);
    expect(after.body.audienceCount).toBe(0);
  }, 60_000);
});
