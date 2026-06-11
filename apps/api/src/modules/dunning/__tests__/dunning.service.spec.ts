import { JOB_DUNNING_EXECUTE_ACTION } from '../../queues/queues.module';
import { DunningService } from '../dunning.service';

import type { AccessIntegrationsService } from '../../access/access-integrations.service';
import type { AuditService } from '../../auth/audit.service';
import type { CommunicationsService } from '../../communications/communications.service';
import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { Queue } from 'bullmq';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const INVOICE_ID = '019e3d20-bbbb-7c2f-bf37-6511065b9fc5';
const CUSTOMER_ID = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';
const ACTION_ID = '019e3d20-dddd-7c2f-bf37-6511065b9fc5';

interface AdminMock {
  dunningAction: { findUnique: jest.Mock; update: jest.Mock };
  invoice: { findUnique: jest.Mock };
  tenant: { findUnique: jest.Mock };
}

function buildService(admin: AdminMock, communications: { enqueue: jest.Mock }) {
  const queue = { add: jest.fn() } as unknown as Queue;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return new DunningService(
    queue,
    admin as unknown as PrismaAdminService,
    audit,
    communications as unknown as CommunicationsService,
    null as unknown as AccessIntegrationsService,
  );
}

function overdueInvoice(overrides: Record<string, unknown> = {}) {
  return {
    status: 'overdue',
    customerId: CUSTOMER_ID,
    invoiceNumber: 'A-2026-00042',
    total: 100,
    amountPaid: 20,
    amountRefunded: 0,
    dueDate: new Date('2026-05-01T00:00:00.000Z'),
    customer: {
      email: 'cliente@example.com',
      firstName: 'Ana',
      lastName: 'García',
      companyName: null,
      customerType: 'individual',
    },
    ...overrides,
  };
}

describe('DunningService.executeAction (email_reminder)', () => {
  it('encola el recordatorio via CommunicationsService y marca la accion executed', async () => {
    const admin: AdminMock = {
      dunningAction: {
        findUnique: jest.fn().mockResolvedValue({
          id: ACTION_ID,
          tenantId: TENANT,
          invoiceId: INVOICE_ID,
          actionType: 'email_reminder',
          status: 'scheduled',
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      invoice: { findUnique: jest.fn().mockResolvedValue(overdueInvoice()) },
      tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Trasteros SL' }) },
    };
    const communications = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = buildService(admin, communications);

    await service.handleJob(JOB_DUNNING_EXECUTE_ACTION, {
      tenantId: TENANT,
      actionId: ACTION_ID,
    });

    expect(communications.enqueue).toHaveBeenCalledTimes(1);
    const args = communications.enqueue.mock.calls[0][0];
    expect(args).toMatchObject({
      tenantId: TENANT,
      channel: 'email',
      recipient: 'cliente@example.com',
      templateCode: 'invoice_overdue_email',
      trigger: 'invoice_overdue',
      customerId: CUSTOMER_ID,
      source: 'dunning.email_reminder',
    });
    // amountPending = total(100) - amountPaid(20) - amountRefunded(0) = 80.00
    expect(args.variables.invoice.amountPending).toBe('80.00');
    expect(args.variables.invoice.number).toBe('A-2026-00042');
    expect(args.variables.customer.displayName).toBe('Ana García');
    expect(args.variables.tenant.name).toBe('Trasteros SL');

    expect(admin.dunningAction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACTION_ID },
        data: expect.objectContaining({
          status: 'executed',
          result: expect.objectContaining({ emailEnqueued: true }),
        }),
      }),
    );
  });

  it('no envia email cuando la factura no tiene customer/email (F2) pero marca executed', async () => {
    const admin: AdminMock = {
      dunningAction: {
        findUnique: jest.fn().mockResolvedValue({
          id: ACTION_ID,
          tenantId: TENANT,
          invoiceId: INVOICE_ID,
          actionType: 'email_reminder',
          status: 'scheduled',
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      invoice: {
        findUnique: jest
          .fn()
          .mockResolvedValue(overdueInvoice({ customerId: null, customer: null })),
      },
      tenant: { findUnique: jest.fn() },
    };
    const communications = { enqueue: jest.fn() };
    const service = buildService(admin, communications);

    await service.handleJob(JOB_DUNNING_EXECUTE_ACTION, {
      tenantId: TENANT,
      actionId: ACTION_ID,
    });

    expect(communications.enqueue).not.toHaveBeenCalled();
    expect(admin.dunningAction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'executed',
          result: expect.objectContaining({ emailEnqueued: false }),
        }),
      }),
    );
  });

  it('cancela la accion (sin enviar) si la factura ya esta pagada', async () => {
    const admin: AdminMock = {
      dunningAction: {
        findUnique: jest.fn().mockResolvedValue({
          id: ACTION_ID,
          tenantId: TENANT,
          invoiceId: INVOICE_ID,
          actionType: 'email_reminder',
          status: 'scheduled',
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      invoice: { findUnique: jest.fn().mockResolvedValue(overdueInvoice({ status: 'paid' })) },
      tenant: { findUnique: jest.fn() },
    };
    const communications = { enqueue: jest.fn() };
    const service = buildService(admin, communications);

    await service.handleJob(JOB_DUNNING_EXECUTE_ACTION, {
      tenantId: TENANT,
      actionId: ACTION_ID,
    });

    expect(communications.enqueue).not.toHaveBeenCalled();
    expect(admin.dunningAction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }),
    );
  });
});
