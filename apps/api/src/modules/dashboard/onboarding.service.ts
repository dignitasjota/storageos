import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ONBOARDING_SKIPPABLE_STEPS } from '@storageos/shared';

import { bookingReady, tenantReadiness, webPublished } from '../../common/tenant-readiness';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';
import type {
  OnboardingDto,
  OnboardingPath,
  OnboardingStepDto,
  OnboardingTestRunDto,
  UpdateOnboardingStateInput,
} from '@storageos/shared';

/** Texto del botón de los pasos que se pueden dar por resueltos. */
const SKIP_LABELS: Record<string, string> = {
  monthly_billing: 'Las emitiré a mano',
  customer: 'Aún no tengo inquilinos',
  contract: 'Aún no tengo contratos',
  branding: 'Más adelante',
  contract_template: 'Me valen las estándar',
  team: 'Trabajo solo',
  verifactu: 'Más adelante',
};

interface OnboardingState {
  skipped?: string[];
  path?: OnboardingPath;
  wizard?: 'done' | 'skipped';
  testRunAt?: string;
}

function skippedSteps(state: unknown): string[] {
  const list = (state as { skipped?: unknown } | null)?.skipped;
  return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
}

/**
 * Puesta en marcha del operador: lo imprescindible para operar (local, tipos,
 * trasteros, datos fiscales, cómo cobra, inquilinos y primer contrato) y lo
 * recomendado (marca, equipo, contrato, Veri*Factu). Se deduce de lo que ya ha
 * configurado; lo que no aplica a su negocio se puede dar por resuelto. Lo que
 * entra solo por la web (una reserva sin firmar) no cuenta como hecho por él.
 */
type Step = Omit<OnboardingStepDto, 'skippable' | 'skipped' | 'skipLabel'>;

@Injectable()
export class OnboardingService {
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true });
  }

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
            offlineCashEnabled: true,
            offlineTransferEnabled: true,
            offlineSepaEnabled: true,
            autoIssueRecurring: true,
            onboardingState: true,
            slug: true,
            customDomain: true,
            customDomainVerifiedAt: true,
            portalLogoUrl: true,
            portalBrandColor: true,
            contractClauses: true,
            invoicingMode: true,
          },
        }),
        tx.facility.findFirst({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, address: true, city: true },
        }),
        tx.unitType.count(),
        tx.unit.count({ where: { facility: { deletedAt: null } } }),
        tx.invoiceSeries.count({
          where: { isActive: true, isRectification: false, ownerId: null },
        }),
        // Una reserva online sin pagar lleva plazo: la crea la web, no el equipo.
        tx.customer.count({
          where: {
            deletedAt: null,
            isTest: false,
            NOT: { contracts: { some: { firstPaymentDeadline: { not: null } } } },
          },
        }),
        tx.contract.count({
          where: {
            deletedAt: null,
            status: { not: 'cancelled' },
            firstPaymentDeadline: null,
            customer: { isTest: false },
          },
        }),
        tx.user.count({ where: { isActive: true } }),
        tx.tenantAeatCredential.count({ where: { ownerId: null, revokedAt: null } }),
        tx.redsysSettings.count({ where: { enabled: true } }),
        tx.goCardlessSettings.count({ where: { enabled: true } }),
        tx.sepaSettings.count({ where: { enabled: true } }),
        tx.tenantStripeAccount.count({ where: { chargesEnabled: true } }),
      ]);
      const testContract = await tx.contract.findFirst({
        where: { deletedAt: null, status: { not: 'cancelled' }, customer: { isTest: true } },
        select: { id: true, customerId: true, status: true },
      });
      const testRun: OnboardingTestRunDto | null = testContract
        ? { customerId: testContract.customerId, contractId: testContract.id, signingUrl: null }
        : null;
      return {
        testRun,
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
    const skipped = new Set(skippedSteps(t?.onboardingState));
    const state = (t?.onboardingState ?? {}) as OnboardingState;
    const migrating = state.path === 'migrating';
    const facilityDone = !!(d.firstFacility?.address && d.firstFacility.city);

    const required: Step[] = [
      {
        key: 'facility',
        label: d.firstFacility ? 'Completa los datos de tu local' : 'Crea tu primer local',
        hint: 'Nombre, dirección y horario: salen en tu web y en los contratos.',
        done: facilityDone,
        group: 'required',
        href: d.firstFacility ? `/facilities/${d.firstFacility.id}?tab=settings` : '/facilities',
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
        label: migrating ? 'Importa tus trasteros' : 'Da de alta tus trasteros',
        hint: migrating
          ? 'Súbelos desde un Excel o CSV de tu programa actual.'
          : 'Uno a uno o todos de golpe desde un Excel o CSV.',
        done: d.units > 0,
        group: 'required',
        href: migrating ? '/units/import' : '/units',
        secondary: migrating
          ? { label: 'Dar de alta a mano', href: '/units' }
          : { label: 'Importar', href: '/units/import' },
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
        done:
          d.paymentGateways > 0 ||
          !!t?.transferIban ||
          !!t?.offlineCashEnabled ||
          !!t?.offlineTransferEnabled ||
          !!t?.offlineSepaEnabled,
        group: 'required',
        href: '/settings/payments',
      },
      {
        key: 'monthly_billing',
        label: 'Decide cómo se emiten las facturas de cada mes',
        hint: 'Actívalo para que salgan solas; si no, quedan en borrador hasta que las emitas tú.',
        done: !!t?.autoIssueRecurring,
        group: 'required',
        href: '/settings/billing',
      },
      {
        key: 'customer',
        label: migrating ? 'Importa a tus inquilinos' : 'Da de alta a tus inquilinos',
        hint: migrating
          ? 'Con sus datos de contacto, sin volver a escribirlos.'
          : 'Si vienes de otro programa, impórtalos con sus contratos.',
        done: d.customers > 0,
        group: state.path === 'opening' ? 'recommended' : 'required',
        href: migrating ? '/customers/import' : '/customers',
        secondary: migrating
          ? { label: 'Dar de alta a mano', href: '/customers' }
          : { label: 'Importar', href: '/customers/import' },
      },
      {
        key: 'contract',
        label: migrating ? 'Importa tus contratos' : 'Crea tu primer contrato',
        hint: migrating
          ? 'Después los activas en bloque, sin volver a firmarlos.'
          : 'El inquilino lo firma en el móvil o en el local y recibe su acceso al pagar.',
        done: d.contracts > 0,
        group: state.path === 'opening' ? 'recommended' : 'required',
        href: migrating ? '/contracts/import' : '/contracts/new',
        secondary: migrating
          ? { label: 'Crear uno a mano', href: '/contracts/new' }
          : { label: 'Importar', href: '/contracts/import' },
      },
    ];

    const recommended: Step[] = [
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

    // Con «abro pronto» aún no hay inquilinos: esos pasos pasan a recomendados.
    const moved = required.filter((s) => s.group === 'recommended');
    const requiredOnly = required.filter((s) => s.group === 'required');
    if (d.units > 0) {
      recommended.push({
        key: 'test_run',
        label: 'Prueba tu recorrido',
        hint: 'Un inquilino de prueba con tu email: firma y área de clientes, sin facturas.',
        done: !!state.testRunAt,
        group: 'recommended',
        href: '/settings/getting-started#prueba',
      });
    }
    const resolve = (s: Step): OnboardingStepDto => {
      const skippable = (ONBOARDING_SKIPPABLE_STEPS as readonly string[]).includes(s.key);
      const isSkipped = skippable && !s.done && skipped.has(s.key);
      return {
        ...s,
        done: s.done || isSkipped,
        skippable,
        skipped: isSkipped,
        ...(skippable ? { skipLabel: SKIP_LABELS[s.key] ?? 'No aplica' } : {}),
      };
    };
    const requiredSteps = requiredOnly.map(resolve);
    const recommendedSteps = [...moved, ...recommended].map(resolve);
    const requiredDone = requiredSteps.filter((s) => s.done).length;
    const readiness = await tenantReadiness(this.admin, tenantId);
    const missing = [
      ...(readiness.hasFacility ? [] : ['un local']),
      ...(readiness.hasCompany ? [] : ['los datos de tu empresa']),
      ...(readiness.hasPayment ? [] : ['una forma de cobro']),
    ];
    return {
      web: {
        url:
          t?.customDomain && t.customDomainVerifiedAt
            ? `https://${t.customDomain}`
            : `${this.webBaseUrl}/s/${t?.slug ?? ''}`,
        published: webPublished(readiness),
        bookable: bookingReady(readiness),
        missing,
      },
      path: state.path ?? null,
      wizardPending: !state.wizard && !d.firstFacility && d.units === 0,
      testRun: d.testRun,
      steps: [...requiredSteps, ...recommendedSteps],
      progress: requiredSteps.length ? requiredDone / requiredSteps.length : 1,
      completed: requiredDone === requiredSteps.length,
      requiredDone,
      requiredTotal: requiredSteps.length,
      recommendedDone: recommendedSteps.filter((s) => s.done).length,
      recommendedTotal: recommendedSteps.length,
    };
  }

  /** Punto de partida elegido y si ya pasó por el asistente. */
  async setState(tenantId: string, input: UpdateOnboardingStateInput): Promise<OnboardingDto> {
    await this.patchState(tenantId, {
      ...(input.path ? { path: input.path } : {}),
      ...(input.wizard ? { wizard: input.wizard } : {}),
    });
    return this.getOnboarding(tenantId);
  }

  async patchState(tenantId: string, patch: Partial<OnboardingState>): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { onboardingState: true },
      });
      const state = (tenant?.onboardingState ?? {}) as Record<string, unknown>;
      await tx.tenant.update({
        where: { id: tenantId },
        data: { onboardingState: { ...state, ...patch } as Prisma.InputJsonValue },
      });
    }, tenantId);
  }

  /** Da un paso por resuelto (o lo devuelve a pendiente). */
  async setSkipped(tenantId: string, key: string, skip: boolean): Promise<OnboardingDto> {
    if (!(ONBOARDING_SKIPPABLE_STEPS as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: 'step_not_skippable',
        message: 'Este paso no se puede omitir',
      });
    }
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { onboardingState: true },
    });
    const list = new Set(skippedSteps(tenant?.onboardingState));
    if (skip) list.add(key);
    else list.delete(key);
    await this.patchState(tenantId, { skipped: [...list] });
    return this.getOnboarding(tenantId);
  }
}
