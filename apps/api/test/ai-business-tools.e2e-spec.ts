import { permissionsForRole } from '@storageos/shared';
import request from 'supertest';

import { AiToolsService } from '../src/modules/ai/ai-tools.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Las herramientas del asistente del panel ven todo el negocio del tenant, y solo el suyo. */
describe('Asistente IA: herramientas del negocio (e2e)', () => {
  let app: INestApplication;
  let tools: AiToolsService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    tools = app.get(AiToolsService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('busca, abre fichas, lista y respeta permisos y tenant', async () => {
    const owner = await registerVerifiedUser(app, 'aitools');
    const other = await registerVerifiedUser(app, 'aitoolsb');
    await setTenantPlan(owner.slug, 'pro');
    const customerId = await createCustomer(app, owner.accessToken, {
      firstName: 'Lucía',
      lastName: 'Herramientas',
      email: 'lucia-tools@e2e.local',
    });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    const otherCustomer = await createCustomer(app, other.accessToken, { firstName: 'Ajeno' });

    const ctx = {
      tenantId: owner.tenantId,
      permissions: permissionsForRole('owner'),
      facilityScope: null,
    };
    const names = tools.definitions(ctx).map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_records',
        'get_record',
        'list_records',
        'get_collections_month',
        'list_debtors',
        'get_calendar',
        'get_business_settings',
        'get_contracts_trend',
      ]),
    );
    const run = async (name: string, input: Record<string, unknown>, c = ctx) =>
      JSON.parse(await tools.execute(c, name, input)) as Record<string, unknown>;

    const found = (await run('search_records', { query: 'Lucía Herramientas' })) as {
      results: { type: string; id: string }[];
    };
    expect(found.results).toContainEqual(
      expect.objectContaining({ type: 'customer', id: customerId }),
    );

    const card = await run('get_record', { type: 'customer', id: customerId });
    expect(card).toMatchObject({ name: 'Lucía Herramientas', email: 'lucia-tools@e2e.local' });
    expect((card.pendingInvoices as unknown[]).length).toBe(1);

    const invoice = await run('get_record', { type: 'invoice', id: invoiceId });
    expect((invoice.lines as unknown[]).length).toBeGreaterThan(0);

    const list = (await run('list_records', { type: 'invoices', status: 'issued' })) as unknown as {
      id: string;
    }[];
    expect(list.map((i) => i.id)).toContain(invoiceId);

    for (const name of [
      'get_collections_month',
      'list_debtors',
      'get_calendar',
      'get_business_settings',
      'get_contracts_trend',
    ]) {
      const out = await run(name, {});
      expect(out).not.toHaveProperty('error');
    }

    // Otro tenant: no aparece.
    const foreign = await run('get_record', { type: 'customer', id: otherCustomer });
    expect(foreign).toHaveProperty('error');

    // Sin permiso para facturas: se le dice, sin consultar.
    const limited = {
      ...ctx,
      permissions: permissionsForRole('owner').filter((p) => p !== 'invoices:read'),
    };
    const denied = await run('list_records', { type: 'invoices' }, limited);
    expect(String(denied.error)).toContain('permiso');
    const noAccount = await run('get_record', { type: 'customer', id: customerId }, limited);
    expect(noAccount).not.toHaveProperty('pendingInvoices');
  });

  it('el chat del panel recibe el día y lo que el usuario no puede ver', async () => {
    const owner = await registerVerifiedUser(app, 'aitoolsctx');
    await setTenantPlan(owner.slug, 'pro');
    const res = await request(app.getHttpServer())
      .post('/ai/chat')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ content: 'Hola' })
      .expect(200);
    expect(res.body.message.content.length).toBeGreaterThan(0);
  });
});
