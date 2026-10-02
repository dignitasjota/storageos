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
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Correos en el idioma del inquilino (`customers.locale = 'en'`): los correos
 * por defecto, los recordatorios con plantilla sin editar (importes y fechas
 * en inglés) y el enlace de acceso al área de clientes. Una plantilla que el
 * tenant editó sale con su texto.
 */
describe('Correos en el idioma del inquilino (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function englishCustomer(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `${prefix}-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email, firstName: 'John' });
    await admin.customer.update({ where: { id: customerId }, data: { locale: 'en' } });
    return { owner, auth, email, customerId };
  }

  async function overdue(
    owner: { accessToken: string },
    auth: Record<string, string>,
    customerId: string,
  ) {
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const inv = await admin.invoice.update({
      where: { id: invoiceId },
      data: { status: 'overdue', dueDate: new Date('2026-09-21T10:00:00Z') },
      select: { tenantId: true },
    });
    const dunning = app.get(DunningService);
    await dunning.handleJob(JOB_DUNNING_PROCESS_INVOICE, {
      tenantId: inv.tenantId,
      invoiceId,
      daysOverdue: 10,
    });
    const action = await admin.dunningAction.findFirstOrThrow({
      where: { invoiceId, actionType: 'email_reminder' },
    });
    await dunning.handleJob(JOB_DUNNING_EXECUTE_ACTION, {
      tenantId: inv.tenantId,
      actionId: action.id,
    });
    return invoiceId;
  }

  it('factura, recordatorio de impago y acceso al área de clientes en inglés', async () => {
    const { owner, auth, email, customerId } = await englishCustomer('locen');

    // Correo por defecto: factura emitida.
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const issued = await waitForEmail(email, { subjectIncludes: 'New invoice' });
    expect(issued.Text).toContain('Hello John,');
    expect(issued.Text).toContain('€121.00');
    expect(issued.Text).toContain('Kind regards,');

    // Recordatorio con la plantilla por defecto sin editar → versión inglesa.
    const overdueId = await overdue(owner, auth, customerId);
    const comms = await request(app.getHttpServer())
      .get(`/communications?invoiceId=${overdueId}&source=dunning.email_reminder`)
      .set(auth)
      .expect(200);
    const reminder = (comms.body as { subject: string; bodyText: string }[])[0]!;
    expect(reminder.subject).toContain('Reminder: invoice');
    expect(reminder.bodyText).toContain('was due on 21 September 2026');
    expect(reminder.bodyText).toContain('€121.00');

    // Enlace de acceso al área de clientes.
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: owner.slug, email })
      .expect(204);
    const magic = await waitForEmail(email, { subjectIncludes: 'Sign in to your' });
    expect(magic.Text).toContain('can only be used once');
  }, 60_000);

  it('una plantilla editada por el tenant sale con su texto', async () => {
    const { owner, auth, customerId } = await englishCustomer('locedit');
    const tpls = (await request(app.getHttpServer()).get('/message-templates').set(auth)).body as {
      id: string;
      code: string;
    }[];
    const tpl = tpls.find((t) => t.code === 'invoice_overdue_email')!;
    await request(app.getHttpServer())
      .patch(`/message-templates/${tpl.id}`)
      .set(auth)
      .send({ bodyText: 'Texto propio del tenant: factura {{invoice.number}} pendiente.' })
      .expect(200);

    const overdueId = await overdue(owner, auth, customerId);
    const comms = await request(app.getHttpServer())
      .get(`/communications?invoiceId=${overdueId}&source=dunning.email_reminder`)
      .set(auth)
      .expect(200);
    expect((comms.body as { bodyText: string }[])[0]!.bodyText).toContain(
      'Texto propio del tenant',
    );
  });
});
