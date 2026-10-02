import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Correos automáticos del tenant a sus inquilinos (activados por defecto). */
describe('Correos por defecto al inquilino (e2e)', () => {
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

  async function setup(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `${prefix}-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, {
      email,
      firstName: 'Lucía',
    });
    const me = await request(app.getHttpServer()).get('/auth/me').set(auth);
    return {
      owner,
      auth,
      email,
      customerId,
      tenantName: me.body.tenant.name as string,
    };
  }

  async function issue(token: string, customerId: string): Promise<string> {
    const inv = await createDraftInvoice(app, token, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${inv}/issue`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    return inv;
  }

  it('ajustes: todo activado por defecto y se puede apagar uno', async () => {
    const s = await setup('ceset');
    const get = await request(app.getHttpServer())
      .get('/settings/tenant/customer-emails')
      .set(s.auth)
      .expect(200);
    expect(Object.values(get.body).every((v) => v === true)).toBe(true);

    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/customer-emails')
      .set(s.auth)
      .send({ invoice_issued: false })
      .expect(200);
    expect(patch.body.invoice_issued).toBe(false);
    expect(patch.body.payment_received).toBe(true);

    await request(app.getHttpServer())
      .patch('/settings/tenant/customer-emails')
      .set(s.auth)
      .send({ no_existe: true })
      .expect(400);
    await request(app.getHttpServer()).get('/settings/tenant/customer-emails').expect(401);
  });

  it('factura emitida y pago recibido llegan al inquilino, con la marca del tenant', async () => {
    const s = await setup('ceinv');
    // IBAN para transferencias: no válido → 400; válido → sale en el correo.
    await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set(s.auth)
      .send({ transferIban: 'ES00 1234' })
      .expect(400);
    const billing = await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set(s.auth)
      .send({ transferIban: 'es91 2100 0418 4502 0005 1332' })
      .expect(200);
    expect(billing.body.transferIban).toBe('ES9121000418450200051332');
    const inv = await issue(s.owner.accessToken, s.customerId);

    const issued = await waitForEmail(s.email, { subjectIncludes: 'Nueva factura' });
    expect(issued.Text).toContain('Hola Lucía,');
    expect(issued.Text).toContain('IBAN: ES91 2100 0418 4502 0005 1332');
    expect(issued.Text).toContain(`/portal/login?slug=${s.owner.slug}`);
    expect(issued.Text).toContain(s.tenantName);
    expect(issued.HTML).not.toMatch(/TrasterOS|STORAGEOS/);
    // Con la marca del tenant (color por defecto mientras no configure el suyo).
    expect(issued.HTML).toContain('#2563eb');
    expect(issued.HTML.match(/<!DOCTYPE html>/g)).toHaveLength(1);

    await request(app.getHttpServer())
      .post(`/invoices/${inv}/mark-paid`)
      .set(s.auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    const paid = await waitForEmail(s.email, { subjectIncludes: 'Pago recibido' });
    expect(paid.Text).toContain('justificante');

    // Quedan en el historial de comunicaciones, enlazados a la factura.
    const comms = await request(app.getHttpServer())
      .get(`/communications?invoiceId=${inv}`)
      .set(s.auth)
      .expect(200);
    const sources = (comms.body as { source: string }[]).map((c) => c.source);
    expect(sources).toEqual(
      expect.arrayContaining(['customer_email.invoice_issued', 'customer_email.payment_received']),
    );
  });

  it('un correo apagado no se envía; con automatización propia no se duplica', async () => {
    const s = await setup('ceoff');
    await request(app.getHttpServer())
      .patch('/settings/tenant/customer-emails')
      .set(s.auth)
      .send({ invoice_issued: false })
      .expect(200);
    await issue(s.owner.accessToken, s.customerId);
    await expect(
      waitForEmail(s.email, { subjectIncludes: 'Nueva factura', timeoutMs: 3000 }),
    ).rejects.toThrow();

    // Con la opción activada pero una automatización para el mismo evento,
    // solo sale la del tenant.
    const s2 = await setup('ceauto');
    const tpls = await request(app.getHttpServer()).get('/message-templates').set(s2.auth);
    const tpl = (tpls.body as { id: string; code: string }[]).find(
      (t) => t.code === 'invoice_issued_email',
    )!;
    await request(app.getHttpServer())
      .post('/automations')
      .set(s2.auth)
      .send({ name: 'x', trigger: 'invoice_issued', actionType: 'send_email', templateId: tpl.id })
      .expect(201);
    await issue(s2.owner.accessToken, s2.customerId);
    await waitForEmail(s2.email, { subjectIncludes: 'disponible' });
    await expect(
      waitForEmail(s2.email, { subjectIncludes: 'Nueva factura', timeoutMs: 2000 }),
    ).rejects.toThrow();
  }, 90_000);

  it('contrato firmado → confirmación con trastero, local y cuota', async () => {
    const s = await setup('cecon');
    const facilityName = `Local cecon ${Date.now()}`;
    const { unitIds } = await createFacilityWithUnits(app, s.owner.accessToken, {
      unitsCount: 1,
      facilityName,
    });
    const c = await request(app.getHttpServer()).post('/contracts').set(s.auth).send({
      customerId: s.customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    await request(app.getHttpServer()).post(`/contracts/${c.body.id}/sign`).set(s.auth).expect(200);

    const mail = await waitForEmail(s.email, { subjectIncludes: 'está firmado' });
    expect(mail.Text).toContain(facilityName);
    expect(mail.Text).toMatch(/50,00\s€/);
  });
});
