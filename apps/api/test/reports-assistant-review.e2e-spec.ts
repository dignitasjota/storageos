import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { permissionsForRole } from '@storageos/shared';
import request from 'supertest';

import { AI_PROVIDER, type AiProvider } from '../src/modules/ai/ai-provider';
import { AiToolsService } from '../src/modules/ai/ai-tools.service';
import { ContractsActiveGenerator } from '../src/modules/reports/generators/contracts-active.generator';
import { InvoicesPeriodGenerator } from '../src/modules/reports/generators/invoices-period.generator';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants, setTenantPlan, withAdminDb } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de Informes y del Asistente IA del panel. */
describe('Revisión de Informes y Asistente IA (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  /** Dos locales con un inquilino en cada uno, y un usuario que solo ve el primero. */
  async function twoFacilities(tag: string) {
    const owner = await registerVerifiedUser(app, tag);
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const north = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Norte',
      unitsCount: 1,
    });
    const south = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Sur',
      unitsCount: 1,
    });
    const ana = await createCustomer(app, owner.accessToken, {
      firstName: 'Ana',
      lastName: 'Delnorte',
      email: `ana-${tag}@e2e.local`,
    });
    const blas = await createCustomer(app, owner.accessToken, {
      firstName: 'Blas',
      lastName: 'Delsur',
      email: `blas-${tag}@e2e.local`,
    });
    const anaContract = await signedContractFor(
      app,
      owner.accessToken,
      { id: ana },
      north.facilityId,
    );
    const blasContract = await signedContractFor(
      app,
      owner.accessToken,
      { id: blas },
      south.facilityId,
    );
    const staff = await scopedUser(app, owner, {
      role: 'staff',
      facilityIds: [north.facilityId],
      tag,
    });
    return { owner, auth, north, south, ana, blas, anaContract, blasContract, staff };
  }

  async function waitFor(auth: { Authorization: string }, id: string) {
    for (let i = 0; i < 40; i++) {
      const res = await http().get(`/reports/${id}`).set(auth).expect(200);
      if (res.body.status === 'done' || res.body.status === 'failed') return res.body;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('el informe no terminó');
  }

  it('informes: cada uno sale con los locales de quien lo pide y solo lo ve quien puede', async () => {
    const t = await twoFacilities('repscope');

    // Catálogo: con dos locales a la vista se puede elegir uno; con uno, no.
    const ownerCatalog = await http().get('/reports/catalog').set(t.auth).expect(200);
    const contracts = (ownerCatalog.body as { code: string; paramsSchema: object }[]).find(
      (c) => c.code === 'contracts_active',
    )!;
    expect(contracts.paramsSchema).toHaveProperty('facilityId');
    const staffCatalog = await http().get('/reports/catalog').set(t.staff).expect(200);
    const staffContracts = (staffCatalog.body as { code: string; paramsSchema: object }[]).find(
      (c) => c.code === 'contracts_active',
    )!;
    expect(staffContracts.paramsSchema).not.toHaveProperty('facilityId');

    // El generador solo lee los locales del alcance.
    const scoped = await app.get(ContractsActiveGenerator).run({
      tenantId: t.owner.tenantId,
      params: {},
      scope: { ids: [t.north.facilityId], explicit: false },
      timezone: 'Europe/Madrid',
    });
    expect(scoped.rows.map((r) => r.customerName)).toEqual(['Ana Delnorte']);
    expect(scoped.rows[0]).toMatchObject({ facilityName: 'Norte', status: 'En vigor', fee: 50 });

    // El informe del staff se guarda con su alcance y termina bien.
    const staffRun = await http()
      .post('/reports/run')
      .set(t.staff)
      .send({ generator: 'contracts_active', format: 'xlsx', params: {} })
      .expect(201);
    expect((await waitFor(t.staff, staffRun.body.id)).status).toBe('done');
    const stored = await withAdminDb((db) =>
      db.reportRun.findUniqueOrThrow({ where: { id: staffRun.body.id } }),
    );
    expect(stored.facilityScoped).toBe(true);
    expect(stored.facilityScope).toEqual([t.north.facilityId]);

    // Un local que no ve: no existe para él.
    await http()
      .post('/reports/run')
      .set(t.staff)
      .send({
        generator: 'contracts_active',
        format: 'xlsx',
        params: { facilityId: t.south.facilityId },
      })
      .expect(404);

    // El informe del propietario (todos los locales) no lo ve ni lo descarga el staff.
    const ownerRun = await http()
      .post('/reports/run')
      .set(t.auth)
      .send({
        generator: 'contracts_active',
        format: 'xlsx',
        params: { facilityId: t.south.facilityId },
      })
      .expect(201);
    const done = await waitFor(t.auth, ownerRun.body.id);
    expect(done).toMatchObject({
      status: 'done',
      generatorName: 'Contratos en vigor',
      paramsLabel: 'Sur',
    });
    const staffList = await http().get('/reports').set(t.staff).expect(200);
    expect((staffList.body as { id: string }[]).map((r) => r.id)).toEqual([staffRun.body.id]);
    await http().get(`/reports/${ownerRun.body.id}`).set(t.staff).expect(404);
    await http().get(`/reports/${ownerRun.body.id}/download`).set(t.staff).expect(404);
    // El propietario ve los dos y puede quitar el suyo.
    const ownerList = await http().get('/reports').set(t.auth).expect(200);
    expect((ownerList.body as unknown[]).length).toBe(2);
    await http().delete(`/reports/${ownerRun.body.id}`).set(t.auth).expect(204);
    await http().get(`/reports/${ownerRun.body.id}`).set(t.auth).expect(404);
  });

  it('informes: los parámetros se comprueban al pedirlo y las fianzas no cuentan como facturas', async () => {
    const owner = await registerVerifiedUser(app, 'repcheck');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const run = (params: Record<string, unknown>, format = 'xlsx') =>
      http().post('/reports/run').set(auth).send({ generator: 'invoices_period', format, params });

    expect((await run({ from: '2026-13-45', to: '2026-12-31' }).expect(400)).body.code).toBe(
      'invalid_date',
    );
    expect((await run({ from: '2026-12-31', to: '2026-01-01' }).expect(400)).body.code).toBe(
      'invalid_date_range',
    );
    expect((await run({ from: '2026-01-01' }).expect(400)).body.message).toContain('«Hasta»');
    await run({ from: '2026-01-01', to: '2026-12-31' }, 'csv').expect(400);

    // Una factura y un justificante de fianza: solo la factura es «facturado».
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const invoice = await withAdminDb(async (db) => {
      const row = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      await db.invoice.create({
        data: {
          tenantId: row.tenantId,
          seriesId: row.seriesId,
          customerId,
          kind: 'deposit_receipt',
          invoiceNumber: 'FZ-PRUEBA',
          sequenceNumber: 0,
          status: 'paid',
          issueDate: row.issueDate,
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          amountPaid: 100,
        },
      });
      return row;
    });
    const day = invoice.issueDate!.toISOString().slice(0, 10);
    const result = await app.get(InvoicesPeriodGenerator).run({
      tenantId: owner.tenantId,
      params: { from: day, to: day },
      scope: { ids: undefined, explicit: false },
      timezone: 'Europe/Madrid',
    });
    expect(result.rows.map((r) => r.invoiceNumber)).toEqual([invoice.invoiceNumber]);
    expect(result.rows[0]!.status).toBe('Emitida');
    expect(result.columns.map((c) => c.label)).toContain('Pendiente');
  });

  it('ningún PDF carga Puppeteer con un import que TypeScript convierta en require()', () => {
    // Puppeteer solo se publica como ESM: `await import('puppeteer')` compila a
    // `require()` y el PDF falla. Todos deben usar `loadPuppeteer()`.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          name.endsWith('.ts') &&
          !path.endsWith(join('common', 'puppeteer.ts')) &&
          /await import\(\s*['"]puppeteer['"]\s*\)/.test(readFileSync(path, 'utf8'))
        ) {
          offenders.push(path);
        }
      }
    };
    walk(join(__dirname, '..', 'src'));
    expect(offenders).toEqual([]);
  });

  it('asistente: quien solo ve un local no llega a los inquilinos ni contactos de otro', async () => {
    const t = await twoFacilities('aiscope2');
    const tools = app.get(AiToolsService);
    const lead = await http()
      .post('/leads')
      .set(t.auth)
      .send({
        firstName: 'Carla',
        lastName: 'Contactosur',
        email: 'carla-sur@e2e.local',
        source: 'manual',
        preferredFacilityId: t.south.facilityId,
      })
      .expect(201);

    const staffCtx = {
      tenantId: t.owner.tenantId,
      permissions: permissionsForRole('staff'),
      facilityScope: [t.north.facilityId],
    };
    const ownerCtx = { ...staffCtx, permissions: permissionsForRole('owner'), facilityScope: null };
    const run = async (
      ctx: typeof staffCtx | typeof ownerCtx,
      name: string,
      input: Record<string, unknown>,
    ) => JSON.parse(await tools.execute(ctx, name, input)) as Record<string, unknown>;
    const ids = (r: Record<string, unknown>) =>
      ((r.results ?? r) as { id: string }[]).map((x) => x.id);

    // Inquilinos: el del otro local no aparece ni se puede abrir.
    expect(ids(await run(staffCtx, 'search_records', { query: 'Delsur' }))).not.toContain(t.blas);
    expect(ids(await run(staffCtx, 'search_records', { query: 'Delnorte' }))).toContain(t.ana);
    expect(await run(staffCtx, 'search_customers', { query: 'Delsur' })).toEqual([]);
    expect(await run(staffCtx, 'get_record', { type: 'customer', id: t.blas })).toHaveProperty(
      'error',
    );
    expect(await run(staffCtx, 'get_customer_summary', { customerId: t.blas })).toHaveProperty(
      'error',
    );
    expect(await run(staffCtx, 'get_record', { type: 'customer', id: t.ana })).toMatchObject({
      name: 'Ana Delnorte',
    });
    // El propietario sí los ve.
    expect(await run(ownerCtx, 'get_record', { type: 'customer', id: t.blas })).toMatchObject({
      name: 'Blas Delsur',
    });

    // Contactos de otro local.
    expect(ids(await run(staffCtx, 'search_records', { query: 'Contactosur' }))).not.toContain(
      lead.body.id,
    );
    expect(await run(staffCtx, 'get_record', { type: 'lead', id: lead.body.id })).toHaveProperty(
      'error',
    );
    const staffLeads = (await run(staffCtx, 'list_records', { type: 'leads' })) as unknown as {
      id: string;
    }[];
    expect(staffLeads.map((l) => l.id)).not.toContain(lead.body.id);
    expect(
      ((await run(ownerCtx, 'list_records', { type: 'leads' })) as unknown as { id: string }[]).map(
        (l) => l.id,
      ),
    ).toContain(lead.body.id);

    // Un id mal formado no rompe la consulta.
    expect(
      await run(ownerCtx, 'get_record', { type: 'customer', id: '-'.repeat(36) }),
    ).toHaveProperty('error');

    // Proponer un mensaje a un inquilino de otro local: no se propone.
    const proposal = await run(
      { ...staffCtx, userId: undefined } as typeof staffCtx,
      'propose_customer_message',
      { customerId: t.blas, body: 'Hola' },
    );
    expect(proposal).toHaveProperty('error');

    // «Sugerir respuesta» tampoco llega a ese inquilino.
    await http().post('/ai/suggest-reply').set(t.staff).send({ customerId: t.blas }).expect(404);
    await http().post('/ai/suggest-reply').set(t.staff).send({ customerId: t.ana }).expect(200);
  });

  it('asistente: importes como en el panel y fechas sin correr un día', async () => {
    const owner = await registerVerifiedUser(app, 'aimoney');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tools = app.get(AiToolsService);
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    // Con retención de IRPF (ya va dentro de lo pagado) y emitida el último día del mes.
    const total = await withAdminDb(async (db) => {
      const row = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      await db.invoice.update({
        where: { id: invoiceId },
        data: {
          issueDate: new Date('2026-10-31T00:00:00Z'),
          withholdingAmount: 19,
          amountPaid: 19,
        },
      });
      return Number(row.total);
    });
    const ctx = {
      tenantId: owner.tenantId,
      permissions: permissionsForRole('owner'),
      facilityScope: null,
    };
    const run = async (name: string, input: Record<string, unknown>, c = ctx) =>
      JSON.parse(await tools.execute(c, name, input)) as Record<string, unknown>;

    // La retención no se resta dos veces.
    const card = await run('get_record', { type: 'invoice', id: invoiceId });
    expect(card.pending).toBe(Math.round((total - 19) * 100) / 100);

    // «Facturas de octubre»: entra la del día 31 y no la del 30 de septiembre.
    const october = (await run('list_records', {
      type: 'invoices',
      from: '2026-10-01',
      to: '2026-10-31',
    })) as unknown as { id: string }[];
    expect(october.map((i) => i.id)).toContain(invoiceId);
    const september = (await run('list_records', {
      type: 'invoices',
      from: '2026-09-01',
      to: '2026-09-30',
    })) as unknown as { id: string }[];
    expect(september.map((i) => i.id)).not.toContain(invoiceId);

    // Una factura cancelada no debe nada.
    await withAdminDb((db) =>
      db.invoice.update({ where: { id: invoiceId }, data: { status: 'cancelled' } }),
    );
    const cancelled = (await run('list_records', {
      type: 'invoices',
      status: 'cancelled',
    })) as unknown as { id: string; pending: number }[];
    expect(cancelled.find((i) => i.id === invoiceId)?.pending).toBe(0);

    // Sin permiso de facturas y cobros, las métricas no llevan dinero.
    const noMoney = {
      ...ctx,
      permissions: permissionsForRole('owner').filter(
        (p) => p !== 'invoices:read' && p !== 'payments:read',
      ),
    };
    const metrics = await run('get_business_metrics', {}, noMoney);
    expect(metrics).not.toHaveProperty('mrr');
    expect(metrics).not.toHaveProperty('pendingToCollect');
    expect(await run('get_monthly_revenue', {}, noMoney)).toHaveProperty('error');
    expect(await run('get_business_metrics', {})).toHaveProperty('mrr');
  });

  it('asistente: una consulta que falla no tumba la pregunta', async () => {
    const owner = await registerVerifiedUser(app, 'aifail');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tools = app.get(AiToolsService);
    const provider = app.get<AiProvider>(AI_PROVIDER);
    const execute = jest.spyOn(tools, 'execute').mockRejectedValueOnce(new Error('boom'));
    const spy = jest
      .spyOn(provider, 'createMessage')
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'get_occupancy', input: {} }],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Ahora mismo no puedo consultarlo.' }],
      });
    const res = await http().post('/ai/chat').set(auth).send({ content: '¿Ocupación?' });
    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe('Ahora mismo no puedo consultarlo.');
    execute.mockRestore();
    spy.mockRestore();
  });
});
