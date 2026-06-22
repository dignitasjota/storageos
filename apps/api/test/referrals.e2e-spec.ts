import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Referrals (e2e)', () => {
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
    const req = await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email });
    expect(req.status).toBe(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const tokenMatch = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/);
    expect(tokenMatch).toBeTruthy();
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token: tokenMatch![1] });
    expect(consume.status).toBe(200);
    return consume.body.accessToken as string;
  }

  it('flujo completo: alta con código → firma → conversión + recompensa', async () => {
    const owner = await registerVerifiedUser(app, 'referrals');

    // Activar el programa (recompensa 15€ fijos).
    const settings = await request(app.getHttpServer())
      .patch('/settings/tenant/referrals')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ referralEnabled: true, referralRewardType: 'fixed', referralRewardValue: 15 });
    expect(settings.status).toBe(200);
    expect(settings.body.referralEnabled).toBe(true);

    // Referidor + su código (vía portal).
    const referrerEmail = `referrer-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email: referrerEmail });
    const portalToken = await portalLogin(owner.slug, referrerEmail);
    const portalView = await request(app.getHttpServer())
      .get('/portal/me/referrals')
      .set('Authorization', `Bearer ${portalToken}`);
    expect(portalView.status).toBe(200);
    expect(portalView.body.enabled).toBe(true);
    const code = portalView.body.referralCode as string;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);

    // Referido se da de alta con el código.
    const referred = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerType: 'individual',
        firstName: 'Referido',
        lastName: 'Nuevo',
        email: `referred-${Date.now()}@e2e.local`,
        country: 'ES',
        referralCode: code,
      });
    expect(referred.status).toBe(201);
    const referredId = referred.body.id as string;

    // Referral registrado (pending).
    const listPending = await request(app.getHttpServer())
      .get('/referrals')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(listPending.status).toBe(200);
    expect(listPending.body).toHaveLength(1);
    expect(listPending.body[0].status).toBe('pending');
    expect(listPending.body[0].referredCustomerId).toBe(referredId);

    // Contrato del referido + firma → dispara la conversión.
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerId: referredId,
        unitId: unitIds[0],
        startDate: '2026-07-01',
        priceMonthly: 100,
        depositAmount: 0,
      });
    expect(contract.status).toBe(201);
    const sign = await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(sign.status).toBe(200);

    // La conversión es async (listener): reintentar.
    let converted: { status: string; rewardCode: string | null } | null = null;
    for (let i = 0; i < 20; i++) {
      const list = await request(app.getHttpServer())
        .get('/referrals')
        .set('Authorization', `Bearer ${owner.accessToken}`);
      converted = list.body[0];
      if (converted?.status === 'converted') break;
      await sleep(300);
    }
    expect(converted?.status).toBe('converted');
    expect(converted?.rewardCode).toMatch(/^REF-[0-9A-F]{8}$/);

    // El referidor ve su recompensa en el portal.
    const portalAfter = await request(app.getHttpServer())
      .get('/portal/me/referrals')
      .set('Authorization', `Bearer ${portalToken}`);
    expect(portalAfter.body.rewards).toContain(converted!.rewardCode);

    // La promoción-recompensa existe y es de un solo uso.
    const promos = await request(app.getHttpServer())
      .get('/promotions')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const reward = promos.body.find((p: { code: string }) => p.code === converted!.rewardCode);
    expect(reward).toBeTruthy();
    expect(reward.maxUses).toBe(1);
    expect(reward.discountValue).toBe(15);
  });

  it('programa desactivado: el portal no expone código y no se registra referral', async () => {
    const owner = await registerVerifiedUser(app, 'referrals-off');
    const email = `noref-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });
    const portalToken = await portalLogin(owner.slug, email);
    const view = await request(app.getHttpServer())
      .get('/portal/me/referrals')
      .set('Authorization', `Bearer ${portalToken}`);
    expect(view.status).toBe(200);
    expect(view.body.enabled).toBe(false);
    expect(view.body.referralCode).toBeNull();
  });
});
