import request from 'supertest';

import { AutomationsService } from '../src/modules/automations/automations.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

type Run = { status: string; errorMessage: string | null };

/**
 * Automatizaciones con retraso: cuando toca enviar, se comprueba que el aviso
 * sigue aplicando (contrato renovado, contacto ya convertido…).
 */
describe('Automatizaciones que ya no aplican al ejecutarse (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('se omiten con el motivo', async () => {
    const owner = await registerVerifiedUser(app, 'autostale');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenantId = (await request(app.getHttpServer()).get('/auth/me').set(auth)).body.tenant
      .id as string;
    const tpls = (await request(app.getHttpServer()).get('/message-templates').set(auth)).body as {
      id: string;
      code: string;
    }[];
    const addRule = async (trigger: string, code: string) =>
      (
        await request(app.getHttpServer())
          .post('/automations')
          .set(auth)
          .send({
            name: trigger,
            trigger,
            actionType: 'send_email',
            templateId: tpls.find((t) => t.code === code)!.id,
            delayMinutes: 60,
          })
          .expect(201)
      ).body.id as string;
    const endingRule = await addRule('contract_ending_soon', 'contract_ending_soon_email');
    const leadRule = await addRule('lead_created', 'lead_thanks_email');

    // Contrato que ya no vence pronto (renovado: fin dentro de 200 días).
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const endDate = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: new Date().toISOString().slice(0, 10),
        endDate,
        priceMonthly: 50,
        discountAmount: 0,
        depositAmount: 0,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({});

    // Contacto ya convertido en cliente.
    const lead = await request(app.getHttpServer())
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Ya', email: `stale-${Date.now()}@e2e.local` })
      .expect(201);
    for (const status of ['contacted', 'qualified', 'won']) {
      await request(app.getHttpServer())
        .post(`/leads/${lead.body.id}/transition`)
        .set(auth)
        .send({ status })
        .expect(201);
    }

    const automations = app.get(AutomationsService);
    const base = { tenantId, recipientEmail: null, recipientPhone: null, leadId: null, scope: {} };
    await automations.runJob({
      ...base,
      ruleId: endingRule,
      trigger: 'contract_ending_soon',
      entityType: 'contract',
      entityId: contract.body.id,
      customerId,
    });
    await automations.runJob({
      ...base,
      ruleId: leadRule,
      trigger: 'lead_created',
      entityType: 'lead',
      entityId: lead.body.id,
      customerId: null,
      leadId: lead.body.id,
    });

    const runs = async (ruleId: string) =>
      (await request(app.getHttpServer()).get(`/automations/runs?ruleId=${ruleId}`).set(auth))
        .body as Run[];
    expect(await runs(endingRule)).toEqual([
      expect.objectContaining({ status: 'skipped', errorMessage: 'contrato renovado' }),
    ]);
    expect(await runs(leadRule)).toEqual([
      expect.objectContaining({ status: 'skipped', errorMessage: 'contacto won' }),
    ]);
  });
});
