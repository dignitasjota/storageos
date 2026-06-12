import { NotFoundException } from '@nestjs/common';

import { AdminTenantsService } from '../admin-tenants.service';

import type { AuditService } from '../../auth/audit.service';
import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { SuperAdminAuditService } from '../super-admin-audit.service';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const USER_A = '019e3d20-1111-7c2f-bf37-6511065b9fc5';
const USER_B = '019e3d20-2222-7c2f-bf37-6511065b9fc5';
const SUPER_ADMIN = '019e3d20-9999-7c2f-bf37-6511065b9fc5';

interface TxMock {
  customer: { updateMany: jest.Mock };
  customerDocument: { deleteMany: jest.Mock };
  paymentMethod: { deleteMany: jest.Mock };
  lead: { updateMany: jest.Mock };
  communication: { updateMany: jest.Mock };
  user: { findMany: jest.Mock; update: jest.Mock };
  session: { deleteMany: jest.Mock };
  tenant: { update: jest.Mock };
}

function buildTx(): TxMock {
  return {
    customer: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    customerDocument: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    paymentMethod: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    lead: { updateMany: jest.fn().mockResolvedValue({ count: 4 }) },
    communication: { updateMany: jest.fn().mockResolvedValue({ count: 7 }) },
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: USER_A }, { id: USER_B }]),
      update: jest.fn().mockResolvedValue(undefined),
    },
    session: { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
    tenant: { update: jest.fn().mockResolvedValue(undefined) },
  };
}

function buildService(opts: { tx: TxMock; tenantFindUnique: jest.Mock }): {
  service: AdminTenantsService;
  audit: jest.Mock;
  superAudit: jest.Mock;
} {
  const admin = {
    tenant: { findUnique: opts.tenantFindUnique },
    $transaction: jest.fn().mockImplementation(async (cb: (tx: TxMock) => unknown) => cb(opts.tx)),
  } as unknown as PrismaAdminService;
  const audit = jest.fn().mockResolvedValue(undefined);
  const superAudit = jest.fn().mockResolvedValue(undefined);
  const service = new AdminTenantsService(
    admin,
    { write: audit } as unknown as AuditService,
    { record: superAudit } as unknown as SuperAdminAuditService,
  );
  return { service, audit, superAudit };
}

describe('AdminTenantsService.anonymize', () => {
  const meta = {
    superAdminId: SUPER_ADMIN,
    reason: 'baja RGPD',
    ipAddress: '1.2.3.4',
    userAgent: 'x',
  };

  it('anonimiza customers + staff + tenant y deja rastro de auditoria', async () => {
    const tx = buildTx();
    const { service, audit, superAudit } = buildService({
      tx,
      tenantFindUnique: jest.fn().mockResolvedValue({ id: TENANT, deletedAt: null }),
    });

    const result = await service.anonymize(TENANT, meta);

    // Customers: anonimizados (email null, placeholder, soft delete) preservando invoices.
    const customerData = tx.customer.updateMany.mock.calls[0][0].data;
    expect(customerData.email).toBeNull();
    expect(customerData.firstName).toBe('*** ANONIMIZADO ***');
    expect(customerData.deletedAt).toBeInstanceOf(Date);

    // Documentos y metodos de pago borrados.
    expect(tx.customerDocument.deleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
    expect(tx.paymentMethod.deleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });

    // Staff: un update por user, email unico + desactivado + 2FA off.
    expect(tx.user.update).toHaveBeenCalledTimes(2);
    const firstUserData = tx.user.update.mock.calls[0][0].data;
    expect(firstUserData.email).toBe(`anon-${USER_A}@anonymized.invalid`);
    expect(firstUserData.isActive).toBe(false);
    expect(firstUserData.twoFactorEnabled).toBe(false);
    expect(typeof firstUserData.passwordHash).toBe('string');
    expect(firstUserData.passwordHash).not.toBe('');

    // Leads anonimizados (PII fuera de customers) + soft delete.
    const leadData = tx.lead.updateMany.mock.calls[0][0].data;
    expect(leadData.email).toBeNull();
    expect(leadData.firstName).toBe('*** ANONIMIZADO ***');
    expect(leadData.deletedAt).toBeInstanceOf(Date);

    // Communications: recipient + cuerpos renderizados + variables purgados.
    const commData = tx.communication.updateMany.mock.calls[0][0].data;
    expect(commData.recipient).toBe('*** ANONIMIZADO ***');
    expect(commData.bodyText).toBe('*** ANONIMIZADO ***');
    expect(commData.bodyHtml).toBeNull();
    expect(commData.variables).toEqual({});

    // Sesiones revocadas.
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });

    // Tenant: cancelled + deletedAt + PII de contacto borrada.
    const tenantData = tx.tenant.update.mock.calls[0][0].data;
    expect(tenantData).toMatchObject({ status: 'cancelled', billingEmail: null, taxId: null });
    expect(tenantData.deletedAt).toBeInstanceOf(Date);

    // Auditoria en ambos logs.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.tenant.anonymized', tenantId: TENANT }),
    );
    expect(superAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.tenant.anonymized', targetTenantId: TENANT }),
    );

    expect(result).toEqual({ tenantId: TENANT, anonymizedCustomers: 3, anonymizedUsers: 2 });
  });

  it('lanza NotFound si el tenant no existe o ya esta borrado', async () => {
    const tx = buildTx();
    const { service } = buildService({
      tx,
      tenantFindUnique: jest.fn().mockResolvedValue({ id: TENANT, deletedAt: new Date() }),
    });

    await expect(service.anonymize(TENANT, meta)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.customer.updateMany).not.toHaveBeenCalled();
  });
});
