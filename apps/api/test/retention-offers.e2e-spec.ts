import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { RetentionService } from '../src/modules/retention/retention.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Motor de retención: el staff ofrece un descuento a un inquilino que se da de
 * baja; si lo acepta desde el portal, se revierte la baja y se aplica el
 * descuento a su contrato.
 */
describe('Retención de bajas (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function portalLogin(slug: string, email: string): Promise<string> {
    const req = await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email });
    expect(req.status).toBe(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const tokenMatch = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/);
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token: tokenMatch![1] });
    return consume.body.accessToken as string;
  }

  it('el inquilino acepta la oferta: baja revertida + descuento aplicado', async () => {
    const owner = await registerVerifiedUser(app, 'retention');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const email = `ret-${Date.now().toString(36)}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // Contrato del inquilino, forzado a `ending` (baja en curso).
    const contractRes = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 50,
    });
    expect(contractRes.status).toBe(201);
    const contractId = contractRes.body.id as string;
    const admin = app.get(PrismaAdminService);
    await admin.contract.update({
      where: { id: contractId },
      data: { status: 'ending', endDate: new Date() },
    });

    // Staff crea la oferta: 20% de descuento 3 meses.
    const offerRes = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/retention-offers`)
      .set(auth)
      .send({ discountType: 'percentage', discountValue: 20, months: 3 });
    expect(offerRes.status).toBe(201);
    expect(offerRes.body.status).toBe('pending');

    // El inquilino la ve en su portal con la cuota rebajada.
    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };
    const list = await request(app.getHttpServer()).get('/portal/me/retention-offers').set(pAuth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].discountedPriceMonthly).toBe(40); // 50 - 20%

    // La acepta → baja revertida + descuento aplicado.
    const accept = await request(app.getHttpServer())
      .post(`/portal/me/retention-offers/${offerRes.body.id}/accept`)
      .set(pAuth);
    expect(accept.status).toBe(200);

    const contract = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.status).toBe('active');
    expect(Number(contract.discountAmount)).toBe(10); // 20% de 50
    // El descuento tiene fecha de fin (3 meses); no es perpetuo.
    expect(contract.discountExpiresAt).not.toBeNull();

    // La oferta queda aceptada y ya no aparece como pendiente.
    const list2 = await request(app.getHttpServer()).get('/portal/me/retention-offers').set(pAuth);
    expect(list2.body).toHaveLength(0);

    // Simulamos que el periodo del descuento ya venció y corremos el cron:
    // el descuento se revierte (cuota vuelve al precio base).
    await admin.contract.update({
      where: { id: contractId },
      data: { discountExpiresAt: new Date(Date.now() - 86_400_000) },
    });
    const result = await app.get(RetentionService).revertExpiredDiscounts();
    expect(result.reverted).toBeGreaterThanOrEqual(1);

    const reverted = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(Number(reverted.discountAmount)).toBe(0);
    expect(reverted.discountReason).toBeNull();
    expect(reverted.discountExpiresAt).toBeNull();
  });
});
