import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { OnboardingDto } from '@storageos/shared';

/**
 * Checklist de puesta en marcha del operador: deriva de los datos ya creados
 * (primer local, tipo, trastero, serie de facturación, inquilino, contrato) para
 * guiar al operador recién registrado hasta el «aha moment» (primer contrato).
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async getOnboarding(tenantId: string): Promise<OnboardingDto> {
    const [facilities, unitTypes, units, series, customers, contracts] =
      await this.prisma.withTenant(
        (tx) =>
          Promise.all([
            tx.facility.count({ where: { deletedAt: null } }),
            tx.unitType.count(),
            tx.unit.count(),
            tx.invoiceSeries.count(),
            tx.customer.count({ where: { deletedAt: null } }),
            tx.contract.count({ where: { deletedAt: null } }),
          ]),
        tenantId,
      );

    const steps = [
      { key: 'facility', label: 'Crea tu primer local', done: facilities > 0, href: '/facilities' },
      {
        key: 'unit_type',
        label: 'Define un tipo de trastero',
        done: unitTypes > 0,
        href: '/units',
      },
      { key: 'unit', label: 'Añade trasteros', done: units > 0, href: '/units' },
      {
        key: 'series',
        label: 'Configura la serie de facturación',
        done: series > 0,
        href: '/settings/billing',
      },
      { key: 'customer', label: 'Registra un inquilino', done: customers > 0, href: '/customers' },
      {
        key: 'contract',
        label: 'Crea tu primer contrato',
        done: contracts > 0,
        href: '/contracts/new',
      },
    ];
    const doneCount = steps.filter((s) => s.done).length;
    return {
      steps,
      progress: steps.length ? doneCount / steps.length : 1,
      completed: doneCount === steps.length,
    };
  }
}
