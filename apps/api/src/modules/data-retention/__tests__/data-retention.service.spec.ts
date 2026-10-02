import { DataRetentionService } from '../data-retention.service';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { ConfigService } from '@nestjs/config';

const RETENTION: Record<string, number> = {
  RETENTION_AUDIT_LOGS_DAYS: 730,
  RETENTION_ACCESS_LOGS_DAYS: 180,
  RETENTION_COMMUNICATIONS_DAYS: 180,
  RETENTION_NOTIFICATIONS_DAYS: 90,
  RETENTION_SEPA_PRENOTICE_DAYS: 430,
};

function build() {
  const admin = {
    auditLog: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
    accessLog: { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
    communication: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    notification: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    platformEmailLog: { deleteMany: jest.fn().mockResolvedValue({ count: 4 }) },
  };
  const config = {
    get: jest.fn((key: string) => RETENTION[key]),
  } as unknown as ConfigService;
  const service = new DataRetentionService(admin as unknown as PrismaAdminService, config as never);
  return { service, admin };
}

describe('DataRetentionService', () => {
  it('borra de las 4 tablas por su plazo de retención y suma los conteos', async () => {
    const { service, admin } = build();
    const before = Date.now();
    const result = await service.runCleanup();

    // Cada tabla se poda por su campo de fecha y su plazo (días → cutoff).
    const auditCutoff = admin.auditLog.deleteMany.mock.calls[0]![0].where.occurredAt.lt as Date;
    const expectedAudit = before - 730 * 24 * 60 * 60 * 1000;
    expect(Math.abs(auditCutoff.getTime() - expectedAudit)).toBeLessThan(5000);

    // access_logs y audit_logs usan `occurredAt`; communications/notifications `createdAt`.
    expect(admin.accessLog.deleteMany.mock.calls[0]![0].where.occurredAt.lt).toBeInstanceOf(Date);
    expect(admin.communication.deleteMany.mock.calls[0]![0].where.createdAt.lt).toBeInstanceOf(
      Date,
    );
    expect(admin.notification.deleteMany.mock.calls[0]![0].where.createdAt.lt).toBeInstanceOf(Date);

    // Los preavisos SEPA solo se borran pasado su propio plazo (430 días).
    const commsWhere = admin.communication.deleteMany.mock.calls[0]![0].where;
    expect(commsWhere.OR[1]).toEqual({
      source: { not: 'customer_email.sepa_prenotification' },
    });
    const prenoticeCutoff = commsWhere.OR[2].createdAt.lt as Date;
    expect(Math.abs(prenoticeCutoff.getTime() - (before - 430 * 86_400_000))).toBeLessThan(5000);

    expect(result).toEqual({
      auditLogs: 3,
      accessLogs: 5,
      communications: 2,
      notifications: 1,
      platformEmails: 4,
    });
  });
});
