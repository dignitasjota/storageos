import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { DunningService } from '../src/modules/dunning/dunning.service';
import {
  JOB_DUNNING_EXECUTE_ACTION,
  JOB_DUNNING_PROCESS_INVOICE,
} from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

type Comm = { subject: string | null; bodyText: string; source: string | null };

/**
 * Recordatorios de impago: primer aviso (día 1) y segundo aviso (día 7, que
 * antes nunca llegaba a programarse), con importes y fechas legibles y enlace
 * para pagar; una automatización propia de «factura vencida» sustituye al
 * primero.
 */
describe('Recordatorios de impago (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let dunning: DunningService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    dunning = app.get(DunningService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function overdueInvoice(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `${prefix}-${Date.now()}@e2e.local`,
    });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const inv = await admin.invoice.update({
      where: { id: invoiceId },
      data: { status: 'overdue', dueDate: new Date(Date.now() - 10 * 86_400_000) },
      select: { tenantId: true },
    });
    return { owner, auth, tenantId: inv.tenantId, invoiceId };
  }

  async function execute(tenantId: string, invoiceId: string, type: string) {
    const action = await admin.dunningAction.findFirstOrThrow({
      where: { invoiceId, actionType: type as 'email_reminder' },
    });
    await dunning.handleJob(JOB_DUNNING_EXECUTE_ACTION, { tenantId, actionId: action.id });
    return admin.dunningAction.findUniqueOrThrow({ where: { id: action.id } });
  }

  async function comms(auth: Record<string, string>, invoiceId: string): Promise<Comm[]> {
    const res = await request(app.getHttpServer())
      .get(`/communications?invoiceId=${invoiceId}`)
      .set(auth)
      .expect(200);
    return (res.body as Comm[]).filter((c) => c.source?.startsWith('dunning.'));
  }

  it('programa los dos avisos y los envía legibles y con enlace de pago', async () => {
    const { auth, tenantId, invoiceId } = await overdueInvoice('dunrem');
    await dunning.handleJob(JOB_DUNNING_PROCESS_INVOICE, { tenantId, invoiceId, daysOverdue: 10 });

    const types = (await admin.dunningAction.findMany({ where: { invoiceId } })).map(
      (a) => a.actionType,
    );
    expect(types).toEqual(expect.arrayContaining(['email_reminder', 'email_reminder_final']));

    await execute(tenantId, invoiceId, 'email_reminder');
    await execute(tenantId, invoiceId, 'email_reminder_final');

    const sent = await comms(auth, invoiceId);
    const first = sent.find((c) => c.source === 'dunning.email_reminder')!;
    const final = sent.find((c) => c.source === 'dunning.email_reminder_final')!;
    expect(first).toBeDefined();
    expect(final).toBeDefined();
    expect(final.subject).toContain('Segundo aviso');
    for (const c of [first, final]) {
      expect(c.bodyText).toContain('€');
      expect(c.bodyText).not.toContain('EUR');
      expect(c.bodyText).toContain('/portal/login?slug=');
    }
    expect(first.bodyText).toMatch(/venció el \d{1,2} de [a-z]+ de \d{4}/);
    expect(final.bodyText).toContain('suspender el acceso');
  });

  it('una automatización propia de «factura vencida» sustituye al primer aviso', async () => {
    const { auth, tenantId, invoiceId } = await overdueInvoice('dunauto');
    const tpls = await request(app.getHttpServer()).get('/message-templates').set(auth);
    const tpl = (tpls.body as { id: string; code: string }[]).find(
      (t) => t.code === 'invoice_overdue_email',
    );
    await request(app.getHttpServer())
      .post('/automations')
      .set(auth)
      .send({
        name: 'vencida',
        trigger: 'invoice_overdue',
        actionType: 'send_email',
        templateId: tpl!.id,
      })
      .expect(201);

    await dunning.handleJob(JOB_DUNNING_PROCESS_INVOICE, { tenantId, invoiceId, daysOverdue: 10 });
    const first = await execute(tenantId, invoiceId, 'email_reminder');
    expect(first.status).toBe('executed');
    expect(first.result).toMatchObject({ emailEnqueued: false });
    const finalAction = await execute(tenantId, invoiceId, 'email_reminder_final');
    expect(finalAction.result).toMatchObject({ emailEnqueued: true });
  });
});
