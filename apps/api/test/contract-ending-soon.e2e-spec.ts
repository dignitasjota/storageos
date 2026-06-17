import request from 'supertest';

import { ContractEndingSoonCron } from '../src/modules/contracts/contract-ending-soon.cron';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function isoDate(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSignedContract(
  app: INestApplication,
  accessToken: string,
  unitId: string,
  customerId: string,
  endDate: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/contracts')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      customerId,
      unitId,
      startDate: isoDate(-5),
      endDate,
      priceMonthly: 80,
      discountAmount: 0,
      depositAmount: 100,
    });
  if (res.status !== 201) {
    throw new Error(`contract create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const id = res.body.id as string;
  const signed = await request(app.getHttpServer())
    .post(`/contracts/${id}/sign`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({});
  if (signed.status !== 200 && signed.status !== 201) {
    throw new Error(`contract sign failed ${signed.status}: ${JSON.stringify(signed.body)}`);
  }
  return id;
}

describe('Cron contract_ending_soon (e2e)', () => {
  let app: INestApplication;
  let cron: ContractEndingSoonCron;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    cron = app.get(ContractEndingSoonCron);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('avisa de contratos que vencen dentro de la ventana e ignora los lejanos; es idempotente', async () => {
    const owner = await registerVerifiedUser(app, 'ces-window');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);

    // Uno que vence pronto (10 días) y otro lejano (90 días).
    const soonId = await createSignedContract(
      app,
      owner.accessToken,
      unitIds[0]!,
      customerId,
      isoDate(10),
    );
    await createSignedContract(app, owner.accessToken, unitIds[1]!, customerId, isoDate(90));

    const first = await cron.run();
    expect(first.notified).toBeGreaterThanOrEqual(1);

    // El listener in-app es async: reintenta hasta que aparezca la notificación.
    let body: { items: { id: string; type: string; link: string | null }[] } | null = null;
    for (let i = 0; i < 15; i++) {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${owner.accessToken}`);
      body = res.body;
      if (body?.items.some((n) => n.type === 'contract.ending_soon')) break;
      await sleep(300);
    }
    const notifs = body!.items.filter((n) => n.type === 'contract.ending_soon');
    // Solo el contrato "pronto" debe haber generado aviso.
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.link).toBe(`/contracts/${soonId}`);

    // Segunda pasada: idempotente, no vuelve a avisar (endingSoonNotifiedAt seteado).
    const second = await cron.run();
    const detail = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const after = (detail.body.items as { type: string }[]).filter(
      (n) => n.type === 'contract.ending_soon',
    );
    expect(after).toHaveLength(1);
    // (second.notified puede ser >0 si otros tenants tienen contratos; lo relevante
    // es que este tenant no recibe un segundo aviso.)
    void second;
  });
});
