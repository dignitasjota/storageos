import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Automatizaciones sobre eventos que antes no enviaban nada: los de factura
 * no llevaban el email del inquilino, ninguno el nombre del tenant, y
 * `reservation_confirmed` no se emitía nunca.
 */
describe('Automatizaciones: datos completos de los eventos (e2e)', () => {
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

  async function setup(prefix: string): Promise<{
    slug: string;
    token: string;
    auth: Record<string, string>;
    tenantName: string;
    customerId: string;
    email: string;
  }> {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `${prefix}-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, {
      email,
      firstName: 'Lucía',
    });
    const me = await request(app.getHttpServer()).get('/auth/me').set(auth);
    return {
      slug: owner.slug,
      token: owner.accessToken,
      auth,
      tenantName: me.body.tenant.name as string,
      customerId,
      email,
    };
  }

  async function addRule(auth: Record<string, string>, trigger: string, code: string) {
    const tpls = await request(app.getHttpServer()).get('/message-templates').set(auth);
    const tpl = (tpls.body as { id: string; code: string }[]).find((t) => t.code === code);
    expect(tpl).toBeDefined();
    await request(app.getHttpServer())
      .post('/automations')
      .set(auth)
      .send({ name: trigger, trigger, actionType: 'send_email', templateId: tpl!.id })
      .expect(201);
  }

  async function issueInvoice(token: string, customerId: string): Promise<string> {
    const inv = await createDraftInvoice(app, token, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${inv}/issue`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    return inv;
  }

  it('factura emitida → correo al inquilino con su nombre y el del tenant', async () => {
    const s = await setup('autoinv');
    await addRule(s.auth, 'invoice_issued', 'invoice_issued_email');
    await issueInvoice(s.token, s.customerId);

    const mail = await waitForEmail(s.email, { subjectIncludes: 'disponible' });
    expect(mail.Text).toContain('Hola Lucía');
    expect(mail.Text).toContain(`El equipo de ${s.tenantName}`);
    expect(mail.Text).toMatch(/Vencimiento: \d{4}-\d{2}-\d{2}/);
  });

  it('reserva confirmada → dispara la automatización «Reserva confirmada»', async () => {
    const s = await setup('autoresv');
    await addRule(s.auth, 'reservation_confirmed', 'reservation_confirmed_email');
    const facilityName = `Local autoresv ${Date.now()}`;
    const { unitIds } = await createFacilityWithUnits(app, s.token, {
      unitsCount: 1,
      facilityName,
    });
    await request(app.getHttpServer())
      .post('/reservations')
      .set(s.auth)
      .send({
        unitId: unitIds[0],
        customerId: s.customerId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);

    const mail = await waitForEmail(s.email, { subjectIncludes: 'Reserva confirmada' });
    expect(mail.Subject).toBe(`Reserva confirmada en ${facilityName}`);
    expect(mail.Text).toContain(`El equipo de ${s.tenantName}`);
  });

  it('sin la funcionalidad en el plan, las reglas existentes no envían', async () => {
    const s = await setup('autofree');
    await addRule(s.auth, 'invoice_issued', 'invoice_issued_email');
    await setTenantPlan(s.slug, 'free');
    await issueInvoice(s.token, s.customerId);

    await expect(
      waitForEmail(s.email, { subjectIncludes: 'disponible', timeoutMs: 3000 }),
    ).rejects.toThrow();
  });
});
