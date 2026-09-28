import { permissionsForRole } from '@storageos/shared';
import request from 'supertest';

import { AiToolsService, type AiToolContext } from '../src/modules/ai/ai-tools.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Herramientas de solo lectura añadidas al asistente IA: devuelven los datos
 * del tenant y respetan el alcance por local del usuario que pregunta.
 */
describe('Asistente IA — herramientas de negocio (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('contratos, disponibilidad, tareas, gastos, leads e ingresos, filtrados por local', async () => {
    const owner = await registerVerifiedUser(app, 'aitools');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const a = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Norte',
      unitsCount: 2,
      pricePerUnit: 40,
    });
    const b = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Sur',
      unitsCount: 2,
      pricePerUnit: 55,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    // Un contrato que vence en 20 días en cada local (sin renovación automática).
    for (const unitId of [a.unitIds[0], b.unitIds[0]]) {
      const c = await request(app.getHttpServer())
        .post('/contracts')
        .set(auth)
        .send({
          customerId,
          unitId,
          startDate: isoDate(-200),
          endDate: isoDate(20),
          priceMonthly: 50,
          autoRenew: false,
        });
      await request(app.getHttpServer())
        .post(`/contracts/${c.body.id}/sign`)
        .set(auth)
        .send({})
        .expect(200);
    }
    await request(app.getHttpServer())
      .post('/tasks')
      .set(auth)
      .send({ title: 'Revisar puerta Sur', facilityId: b.facilityId, dueDate: isoDate(-1) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/tasks')
      .set(auth)
      .send({ title: 'Tarea general' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/expenses')
      .set(auth)
      .send({
        facilityId: b.facilityId,
        category: 'utilities',
        description: 'Luz Sur',
        amount: 80,
        expenseDate: isoDate(0),
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/leads')
      .set(auth)
      .send({ source: 'Idealista', firstName: 'Lead', email: `lead-${Date.now()}@x.com` })
      .expect(201);

    const tools = app.get(AiToolsService);
    const all: AiToolContext = {
      tenantId: owner.tenantId,
      permissions: permissionsForRole('owner'),
      facilityScope: null,
    };
    const onlyA: AiToolContext = { ...all, facilityScope: [a.facilityId] };
    const run = async (ctx: AiToolContext, name: string, input: Record<string, unknown> = {}) =>
      JSON.parse(await tools.execute(ctx, name, input));

    // Contratos que vencen: ambos sin límite; con alcance, solo el del Norte.
    const endingAll = await run(all, 'list_contracts_ending', { days: 30 });
    expect(endingAll).toHaveLength(2);
    expect(endingAll[0]).toMatchObject({ autoRenew: false, monthlyPrice: 50 });
    const endingA = await run(onlyA, 'list_contracts_ending', { days: '30' });
    expect(endingA.map((c: { facility: string }) => c.facility)).toEqual(['Local Norte']);

    // Disponibilidad: 1 libre por local, precio «desde» del tipo.
    const availA = await run(onlyA, 'get_unit_availability');
    expect(availA).toEqual([
      expect.objectContaining({ facility: 'Local Norte', total: 2, available: 1, priceFrom: 40 }),
    ]);

    // Tareas: con alcance, la del Sur no aparece (la general sí).
    const tasksA = (await run(onlyA, 'list_open_tasks')) as { title: string }[];
    expect(tasksA.map((t) => t.title)).toEqual(['Tarea general']);
    const tasksAll = (await run(all, 'list_open_tasks')) as { title: string; overdue: boolean }[];
    expect(tasksAll.find((t) => t.title === 'Revisar puerta Sur')?.overdue).toBe(true);

    // Gastos: el del Sur cuenta sin límite y no con alcance al Norte.
    expect((await run(all, 'get_expenses_summary')).byCategory.utilities).toBe(80);
    expect((await run(onlyA, 'get_expenses_summary')).total).toBe(0);

    // Leads (a nivel de empresa) e ingresos (estructura del mes en curso).
    const leads = await run(all, 'get_leads_summary', { days: 7 });
    expect(leads.total).toBe(1);
    expect(leads.bySource.idealista).toBe(1);
    const revenue = await run(all, 'get_monthly_revenue', { months: 99 });
    expect(revenue.months).toHaveLength(12);
    expect(revenue.months[11].month).toBe(new Date().toISOString().slice(0, 7));

    // Sin el permiso de gastos (rol staff personalizado), la herramienta no se ofrece.
    const noExpenses = {
      ...all,
      permissions: all.permissions.filter((p) => p !== 'expenses:read'),
    };
    expect(tools.definitions(noExpenses).map((d) => d.name)).not.toContain('get_expenses_summary');
    expect((await run(noExpenses, 'get_expenses_summary')).error).toMatch(/no disponible/);
  });
});
