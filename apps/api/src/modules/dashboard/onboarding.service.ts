import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { OnboardingDto, OnboardingStepDto } from '@storageos/shared';

/**
 * Puesta en marcha del operador: lo imprescindible para operar (local, tipos,
 * trasteros, datos fiscales, cómo cobra, inquilinos y primer contrato) y lo
 * recomendado (marca, equipo, contrato, Veri*Factu). Todo se deduce de lo que
 * ya ha configurado: no hay nada que marcar a mano.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async getOnboarding(tenantId: string): Promise<OnboardingDto> {
    const d = await this.prisma.withTenant(async (tx) => {
      const [
        tenant,
        firstFacility,
        unitTypes,
        units,
        series,
        customers,
        contracts,
        users,
        aeat,
        redsys,
        gocardless,
        sepa,
        stripe,
      ] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            taxId: true,
            billingLegalName: true,
            billingAddress: true,
            transferIban: true,
            portalLogoUrl: true,
            portalBrandColor: true,
            contractClauses: true,
            invoicingMode: true,
          },
        }),
        tx.facility.findFirst({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        }),
        tx.unitType.count(),
        tx.unit.count(),
        tx.invoiceSeries.count({
          where: { isActive: true, isRectification: false, ownerId: null },
        }),
        tx.customer.count({ where: { deletedAt: null } }),
        tx.contract.count({ where: { deletedAt: null } }),
        tx.user.count({ where: { isActive: true } }),
        tx.tenantAeatCredential.count({ where: { ownerId: null, revokedAt: null } }),
        tx.redsysSettings.count({ where: { enabled: true } }),
        tx.goCardlessSettings.count({ where: { enabled: true } }),
        tx.sepaSettings.count({ where: { enabled: true } }),
        tx.tenantStripeAccount.count({ where: { chargesEnabled: true } }),
      ]);
      return {
        tenant,
        firstFacility,
        unitTypes,
        units,
        series,
        customers,
        contracts,
        users,
        aeat,
        paymentGateways: redsys + gocardless + sepa + stripe,
      };
    }, tenantId);
    const t = d.tenant;

    const required: OnboardingStepDto[] = [
      {
        key: 'facility',
        label: 'Crea tu primer local',
        hint: 'Nombre, dirección y horario: salen en tu web y en los contratos.',
        done: !!d.firstFacility,
        group: 'required',
        href: '/facilities',
      },
      {
        key: 'unit_type',
        label: 'Define los tipos de trastero y sus precios',
        hint: 'Cada tipo lleva su precio y su fianza; tu web y la reserva online los usan.',
        done: d.unitTypes > 0,
        group: 'required',
        href: d.firstFacility ? `/facilities/${d.firstFacility.id}?tab=unit-types` : '/facilities',
      },
      {
        key: 'unit',
        label: 'Da de alta tus trasteros',
        hint: 'Uno a uno o todos de golpe desde un Excel o CSV.',
        done: d.units > 0,
        group: 'required',
        href: '/units',
        secondary: { label: 'Importar', href: '/units/import' },
      },
      {
        key: 'company',
        label: 'Completa los datos de tu empresa',
        hint: 'Razón social, NIF y domicilio fiscal: son obligatorios en tus facturas.',
        done: !!(t?.taxId && t.billingLegalName && t.billingAddress),
        group: 'required',
        href: '/settings/company',
      },
      // El registro ya crea la serie; solo se pide si alguien la borró o desactivó.
      ...(d.series === 0
        ? [
            {
              key: 'series',
              label: 'Crea tu serie de facturación',
              hint: 'Sin ella no se emiten facturas ni la primera de una reserva online.',
              done: false,
              group: 'required' as const,
              href: '/settings/billing',
            },
          ]
        : []),
      {
        key: 'payments',
        label: 'Elige cómo te pagan tus inquilinos',
        hint: 'Tarjeta o Bizum (Redsys o Stripe), domiciliación o transferencia a tu IBAN.',
        done: d.paymentGateways > 0 || !!t?.transferIban,
        group: 'required',
        href: '/settings/payments',
      },
      {
        key: 'customer',
        label: 'Da de alta a tus inquilinos',
        hint: 'Si vienes de otro programa, impórtalos con sus contratos.',
        done: d.customers > 0,
        group: 'required',
        href: '/customers',
        secondary: { label: 'Importar', href: '/customers/import' },
      },
      {
        key: 'contract',
        label: 'Crea tu primer contrato',
        hint: 'El inquilino lo firma en el móvil o en el local y recibe su acceso al pagar.',
        done: d.contracts > 0,
        group: 'required',
        href: '/contracts/new',
        secondary: { label: 'Importar', href: '/contracts/import' },
      },
    ];

    const recommended: OnboardingStepDto[] = [
      {
        key: 'branding',
        label: 'Pon tu logo y tu color',
        hint: 'Se usan en tu web, el área de clientes y los correos a tus inquilinos.',
        done: !!(t?.portalLogoUrl || t?.portalBrandColor),
        group: 'recommended',
        href: '/settings/branding',
      },
      {
        key: 'contract_template',
        label: 'Revisa las cláusulas de tu contrato',
        hint: 'Añade tus condiciones particulares; si no, se usan las estándar.',
        done: !!t?.contractClauses?.trim(),
        group: 'recommended',
        href: '/settings/contract-template',
      },
      {
        key: 'team',
        label: 'Invita a tu equipo',
        hint: 'Cada persona con su usuario y sus permisos (y, si quieres, solo sus locales).',
        done: d.users > 1,
        group: 'recommended',
        href: '/settings/users',
      },
      // Con Holded las facturas las registra Holded: no hace falta certificado propio.
      ...(t?.invoicingMode === 'holded'
        ? []
        : [
            {
              key: 'verifactu',
              label: 'Sube tu certificado para Veri*Factu',
              hint: 'Tus facturas se registran solas en la AEAT con tu certificado digital.',
              done: d.aeat > 0,
              group: 'recommended' as const,
              href: '/settings/billing/verifactu',
            },
          ]),
    ];

    const requiredDone = required.filter((s) => s.done).length;
    return {
      steps: [...required, ...recommended],
      progress: required.length ? requiredDone / required.length : 1,
      completed: requiredDone === required.length,
      requiredDone,
      requiredTotal: required.length,
      recommendedDone: recommended.filter((s) => s.done).length,
      recommendedTotal: recommended.length,
    };
  }
}
