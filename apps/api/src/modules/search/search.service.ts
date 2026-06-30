import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { SearchResultDto } from '@storageos/shared';

const PER_TYPE = 5;

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Búsqueda global del panel: localiza inquilinos, contratos, trasteros y
 * facturas por su identificador/nombre. `withTenant` (RLS) garantiza que solo
 * devuelve datos del tenant del usuario.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(tenantId: string, query: string): Promise<SearchResultDto[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const contains = { contains: q, mode: 'insensitive' as const };

    return this.prisma.withTenant(async (tx) => {
      const [customers, contracts, units, invoices] = await Promise.all([
        tx.customer.findMany({
          where: {
            deletedAt: null,
            OR: [
              { firstName: contains },
              { lastName: contains },
              { companyName: contains },
              { email: contains },
              { documentNumber: contains },
            ],
          },
          take: PER_TYPE,
          select: {
            id: true,
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
          },
        }),
        tx.contract.findMany({
          where: { contractNumber: contains },
          take: PER_TYPE,
          select: {
            id: true,
            contractNumber: true,
            unit: { select: { code: true } },
          },
        }),
        tx.unit.findMany({
          where: { code: contains },
          take: PER_TYPE,
          select: { id: true, code: true, facility: { select: { name: true } } },
        }),
        tx.invoice.findMany({
          where: { invoiceNumber: contains },
          take: PER_TYPE,
          select: { id: true, invoiceNumber: true, total: true },
        }),
      ]);

      const results: SearchResultDto[] = [];
      for (const c of customers) {
        results.push({
          type: 'customer',
          id: c.id,
          label: customerName(c),
          detail: c.email,
          href: `/customers/${c.id}`,
        });
      }
      for (const c of contracts) {
        results.push({
          type: 'contract',
          id: c.id,
          label: c.contractNumber,
          detail: c.unit?.code ?? null,
          href: `/contracts/${c.id}`,
        });
      }
      for (const u of units) {
        results.push({
          type: 'unit',
          id: u.id,
          label: u.code,
          detail: u.facility?.name ?? null,
          href: `/units/${u.id}`,
        });
      }
      for (const i of invoices) {
        results.push({
          type: 'invoice',
          id: i.id,
          label: i.invoiceNumber,
          detail: `${Number(i.total).toFixed(2)} €`,
          href: `/invoices/${i.id}`,
        });
      }
      return results;
    }, tenantId);
  }
}
