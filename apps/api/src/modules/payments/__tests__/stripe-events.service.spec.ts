import { Prisma } from '@storageos/database';

import { StripeEventsService } from '../stripe-events.service';

import type { PrismaAdminService } from '../../database/prisma-admin.service';

const EVENT_ID = 'evt_3QxTest123';

interface AdminMock {
  processedStripeEvent: { create: jest.Mock; deleteMany: jest.Mock };
}

function buildService(admin: AdminMock) {
  return new StripeEventsService(admin as unknown as PrismaAdminService);
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('StripeEventsService (dedup de webhooks entrantes)', () => {
  it('markProcessed devuelve true la primera vez e inserta el event.id', async () => {
    const admin: AdminMock = {
      processedStripeEvent: {
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn(),
      },
    };
    const service = buildService(admin);

    await expect(service.markProcessed(EVENT_ID, 'charge.refunded')).resolves.toBe(true);
    expect(admin.processedStripeEvent.create).toHaveBeenCalledWith({
      data: { id: EVENT_ID, eventType: 'charge.refunded' },
    });
  });

  it('markProcessed devuelve false para un event.id duplicado (P2002)', async () => {
    const admin: AdminMock = {
      processedStripeEvent: {
        create: jest.fn().mockRejectedValue(uniqueViolation()),
        deleteMany: jest.fn(),
      },
    };
    const service = buildService(admin);

    await expect(service.markProcessed(EVENT_ID, 'charge.refunded')).resolves.toBe(false);
  });

  it('markProcessed propaga errores que no son P2002', async () => {
    const admin: AdminMock = {
      processedStripeEvent: {
        create: jest.fn().mockRejectedValue(new Error('db down')),
        deleteMany: jest.fn(),
      },
    };
    const service = buildService(admin);

    await expect(service.markProcessed(EVENT_ID, 'charge.refunded')).rejects.toThrow('db down');
  });

  it('release borra el event.id para permitir el retry de Stripe', async () => {
    const admin: AdminMock = {
      processedStripeEvent: {
        create: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = buildService(admin);

    await service.release(EVENT_ID);
    expect(admin.processedStripeEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: EVENT_ID },
    });
  });
});
