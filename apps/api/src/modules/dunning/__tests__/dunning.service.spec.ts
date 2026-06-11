import { DOMAIN_EVENTS } from '../../automations/domain-events';
import {
  JOB_DUNNING_EXECUTE_ACTION,
  JOB_DUNNING_PROCESS_INVOICE,
} from '../../queues/queues.module';
import { DunningService } from '../dunning.service';

import type { AccessIntegrationsService } from '../../access/access-integrations.service';
import type { AuditService } from '../../auth/audit.service';
import type { CommunicationsService } from '../../communications/communications.service';
import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const INVOICE_ID = '019e3d20-bbbb-7c2f-bf37-6511065b9fc5';
const CUSTOMER_ID = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';
const ACTION_ID = '019e3d20-dddd-7c2f-bf37-6511065b9fc5';

interface AdminMock {
  dunningAction: { findUnique: jest.Mock; update: jest.Mock; findMany?: jest.Mock };
  invoice: { findUnique: jest.Mock; findMany?: jest.Mock; updateMany?: jest.Mock };
  tenant: { findUnique: jest.Mock };
}

function buildService(
  admin: AdminMock,
  communications: { enqueue: jest.Mock },
  deps: { queue?: { add: jest.Mock }; events?: { emit: jest.Mock } } = {},
) {
  const queue = deps.queue ?? { add: jest.fn() };
  const events = deps.events ?? { emit: jest.fn() };
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return new DunningService(
    queue as unknown as Queue,
    admin as unknown as PrismaAdminService,
    audit,
    communications as unknown as CommunicationsService,
    events as unknown as EventEmitter2,
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

describe('DunningService.dailyTick (marcar overdue)', () => {
  it('marca overdue, encola process-invoice y emite domain.invoice_overdue por factura', async () => {
    const admin: AdminMock = {
      dunningAction: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]), // dispatchDueActions
      },
      invoice: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          {
            id: INVOICE_ID,
            tenantId: TENANT,
            dueDate: new Date('2026-06-01T00:00:00.000Z'),
            customerId: CUSTOMER_ID,
            invoiceNumber: 'A-2026-00042',
            total: 100,
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      tenant: { findUnique: jest.fn() },
    };
    const queue = { add: jest.fn() };
    const events = { emit: jest.fn() };
    const service = buildService(admin, { enqueue: jest.fn() }, { queue, events });

    await service.dailyTick();

    expect(admin.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'overdue' } }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      JOB_DUNNING_PROCESS_INVOICE,
      expect.objectContaining({ tenantId: TENANT, invoiceId: INVOICE_ID }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      DOMAIN_EVENTS.invoice_overdue,
      expect.objectContaining({
        tenantId: TENANT,
        entityType: 'invoice',
        entityId: INVOICE_ID,
        customerId: CUSTOMER_ID,
        scope: {
          invoice: expect.objectContaining({ number: 'A-2026-00042', total: '100.00' }),
        },
      }),
    );
  });

  it('sin facturas vencidas no emite ni encola', async () => {
    const admin: AdminMock = {
      dunningAction: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      invoice: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      tenant: { findUnique: jest.fn() },
    };
    const queue = { add: jest.fn() };
    const events = { emit: jest.fn() };
    const service = buildService(admin, { enqueue: jest.fn() }, { queue, events });

    await service.dailyTick();

    expect(admin.invoice.updateMany).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
