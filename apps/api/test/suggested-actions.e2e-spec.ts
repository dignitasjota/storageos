import request from 'supertest';

import { AI_PROVIDER, type AiProvider } from '../src/modules/ai/ai-provider';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * «Sugerencias de hoy»: acciones concretas priorizadas cruzando las señales del
 * sistema (retención, precio, cobros, renovaciones). Determinista.
 */
describe('Sugerencias de hoy (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('tenant vacío → sin acciones; contrato que vence sin renovación → acción de renovación', async () => {
    const owner = await registerVerifiedUser(app, 'sugg');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Tenant sin datos → sin sugerencias.
    const empty = await request(app.getHttpServer()).get('/analytics/suggested-actions').set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.actions).toEqual([]);

    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    // Contrato que vence en 20 días SIN renovación automática.
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: isoDate(-300),
        endDate: isoDate(20),
        priceMonthly: 100,
        autoRenew: false,
      });
    expect(contract.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({})
      .expect(200);

    const res = await request(app.getHttpServer()).get('/analytics/suggested-actions').set(auth);
    expect(res.status).toBe(200);
    const renewal = (res.body.actions as { category: string; href: string; cta: string }[]).find(
      (a) => a.category === 'renewal',
    );
    expect(renewal).toBeDefined();
    expect(renewal!.href).toBe(`/contracts/${contract.body.id}`);
    expect(renewal!.cta).toBe('Ver contrato');
  });

  it('con asistente IA: el modelo reordena y redacta, sin inventar acciones ni tocar enlaces', async () => {
    const owner = await registerVerifiedUser(app, 'suggai');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 100,
    });
    const customerId = await createCustomer(app, owner.accessToken);
    for (const [i, unitId] of unitIds.entries()) {
      const c = await request(app.getHttpServer())
        .post('/contracts')
        .set(auth)
        .send({
          customerId,
          unitId,
          startDate: isoDate(-300),
          endDate: isoDate(10 + i * 5),
          priceMonthly: 100,
          autoRenew: false,
        });
      await request(app.getHttpServer())
        .post(`/contracts/${c.body.id}/sign`)
        .set(auth)
        .send({})
        .expect(200);
    }

    // Plan starter (sin `ai_assistant`) → lista heurística, sin llamar al modelo.
    const provider = app.get<AiProvider>(AI_PROVIDER);
    const spy = jest.spyOn(provider, 'createMessage');
    const heuristic = await request(app.getHttpServer())
      .get('/analytics/suggested-actions')
      .set(auth)
      .expect(200);
    expect(heuristic.body.aiEnhanced).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const ids = (heuristic.body.actions as { id: string }[]).map((a) => a.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    // Plan pro: el modelo devuelve el orden invertido + un id inventado.
    await setTenantPlan(owner.slug, 'pro');
    const reversed = [...ids].reverse();
    spy.mockResolvedValueOnce({
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            actions: [
              { id: 'inventada', title: 'No debe aparecer', detail: 'x' },
              ...reversed.map((id, i) => ({
                id,
                title: `Prioridad ${i + 1}`,
                detail: 'Hazlo hoy',
              })),
            ],
          }),
        },
      ],
    });
    const enhanced = await request(app.getHttpServer())
      .get('/analytics/suggested-actions')
      .set(auth)
      .expect(200);
    expect(enhanced.body.aiEnhanced).toBe(true);
    const actions = enhanced.body.actions as { id: string; title: string; href: string }[];
    expect(actions.map((a) => a.id)).toEqual(reversed);
    expect(actions[0]!.title).toBe('Prioridad 1');
    expect(actions.every((a) => a.href.startsWith('/'))).toBe(true);

    // Respuesta no válida del modelo → vuelve a la lista heurística.
    spy.mockResolvedValueOnce({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'No puedo ayudarte con eso' }],
    });
    const fallback = await request(app.getHttpServer())
      .get('/analytics/suggested-actions')
      .set(auth)
      .expect(200);
    expect(fallback.body.aiEnhanced).toBe(false);
    expect((fallback.body.actions as { id: string }[]).map((a) => a.id)).toEqual(ids);
    spy.mockRestore();
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/analytics/suggested-actions').expect(401);
  });
});
