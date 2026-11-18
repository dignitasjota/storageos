import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import {
  cadenceDueDates,
  FEATURE_LABELS,
  platformLeadName,
  SALES_CADENCE_CHANNEL_LABELS,
  SALES_CALL_OUTCOME_LABELS,
  SALES_OUTCOME_FOLLOWUP_DAYS,
  SALES_OUTCOME_FOLLOWUP_TITLES,
  SALES_TEMPERATURE_LABELS,
  salesMonth,
  salesSignupUrl,
  salesLandingUrl,
  SalesCadenceStepSchema,
  type CreatePlatformLeadActivityInput,
  type CreatePlatformLeadFollowupInput,
  type CreateSalesProspectInput,
  type LosePlatformLeadInput,
  type MovePlatformLeadInput,
  type PlatformLeadFollowupDto,
  type SalesAccountDto,
  type SalesAccountSummaryDto,
  type SalesCadenceEnrollmentDto,
  type SalesCallOutcomeInput,
  type SalesClientRowDto,
  type SalesClientSheetDto,
  type SalesImportInput,
  type SalesImportResultDto,
  type SalesImportRowDto,
  type SalesLeadDto,
  type SalesLeadListDto,
  type SalesRepProfileDto,
  type SalesTodayDto,
  type SalesTodayRowDto,
  type SendPlatformLeadEmailInput,
  type TenantFeature,
  type UpdatePlatformLeadFollowupInput,
  type UpdateSalesLeadInput,
  type UpdateSalesMeInput,
  type UpdateSalesProfileInput,
} from '@storageos/shared';

import { AI_PROVIDER, type AiProvider } from '../../ai/ai-provider';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { normalizeHeader, parseRaw } from '../../imports/import-engine';
import { PlanLimitsService } from '../../plan-limits/plan-limits.service';
import { AdminOpportunitiesService } from '../admin-opportunities.service';
import { AdminTenantsService } from '../admin-tenants.service';
import { PlatformLeadsService, type LeadEmailSender } from '../leads/platform-leads.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { SalesAppointmentsService } from './sales-appointments.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { SalesCommissionsService } from './sales-commissions.service';
import {
  addDaysIso,
  clean,
  DAY,
  daysUntil,
  madridToday,
  phoneTail,
  profileDto,
  round2,
  type SalesActor,
} from './sales-common';

import type { Env } from '../../../config/env.schema';

const NO_CONTACT_DAYS = 14;
const CONTACT_TYPES = new Set(['call', 'whatsapp', 'meeting', 'demo']);

const IMPORT_ALIASES: Record<
  string,
  'companyName' | 'contactName' | 'email' | 'phone' | 'city' | 'units' | 'note'
> = {
  empresa: 'companyName',
  company: 'companyName',
  companyname: 'companyName',
  negocio: 'companyName',
  nombreempresa: 'companyName',
  contacto: 'contactName',
  contact: 'contactName',
  contactname: 'contactName',
  nombre: 'contactName',
  persona: 'contactName',
  email: 'email',
  correo: 'email',
  mail: 'email',
  telefono: 'phone',
  phone: 'phone',
  movil: 'phone',
  tel: 'phone',
  ciudad: 'city',
  city: 'city',
  localidad: 'city',
  trasteros: 'units',
  units: 'units',
  notas: 'note',
  nota: 'note',
  notes: 'note',
  observaciones: 'note',
};

/**
 * La cartera de un comercial: sus leads (prospectos y cuentas), sus clientes,
 * la ficha de llamada, lo que hace con cada uno y su «Hoy». Todo se filtra por
 * su cartera: lo de otro comercial no existe para él (404).
 */
@Injectable()
export class SalesAccountsService {
  private readonly logger = new Logger(SalesAccountsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly leads: PlatformLeadsService,
    private readonly assignment: SalesAssignmentService,
    private readonly commissions: SalesCommissionsService,
    private readonly tenants: AdminTenantsService,
    private readonly opportunities: AdminOpportunitiesService,
    private readonly limits: PlanLimitsService,
    private readonly audit: SuperAdminAuditService,
    private readonly config: ConfigService<Env, true>,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly appointments: SalesAppointmentsService,
  ) {}

  private actor(a: SalesActor) {
    return {
      superAdminId: a.repId,
      ipAddress: a.ipAddress ?? null,
      userAgent: a.userAgent ?? null,
    };
  }

  // ---------------------------------------------------------------- perfil

  async rep(repId: string) {
    const rep = await this.admin.superAdmin.findUnique({
      where: { id: repId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        whatsapp: true,
        bookingUrl: true,
        salesCode: true,
      },
    });
    if (!rep)
      throw new NotFoundException({ code: 'rep_not_found', message: 'Comercial no encontrado' });
    return rep;
  }

  /** Remitente de sus correos: a su nombre, las respuestas a su email. */
  async sender(repId: string): Promise<LeadEmailSender> {
    const rep = await this.rep(repId);
    const lines = [rep.fullName, 'TrasterOS', rep.phone, rep.email].filter(Boolean);
    return {
      fromName: `${rep.fullName} · TrasterOS`,
      replyTo: { email: rep.email, name: rep.fullName },
      signature: lines.join('  \n'),
    };
  }

  async me(repId: string): Promise<SalesRepProfileDto> {
    const code = await this.assignment.ensureCode(repId);
    const [rep, settings] = await Promise.all([this.rep(repId), this.assignment.settings()]);
    const site = this.config.get('WEB_BASE_URL', { infer: true });
    return {
      id: rep.id,
      fullName: rep.fullName,
      email: rep.email,
      salesCode: code,
      phone: rep.phone,
      whatsapp: rep.whatsapp,
      bookingUrl: rep.bookingUrl,
      signupUrl: salesSignupUrl(site, code),
      landingUrl: salesLandingUrl(site, code),
      extraTrialDays: settings.signupExtraTrialDays,
      limits: {
        trialExtensionDays: settings.repTrialExtensionDays,
        addonTrialDays: settings.repAddonTrialDays,
      },
    };
  }

  async updateMe(repId: string, input: UpdateSalesMeInput): Promise<SalesRepProfileDto> {
    await this.admin.superAdmin.update({
      where: { id: repId },
      data: {
        ...(input.phone !== undefined ? { phone: clean(input.phone) } : {}),
        ...(input.whatsapp !== undefined ? { whatsapp: clean(input.whatsapp) } : {}),
        ...(input.bookingUrl !== undefined ? { bookingUrl: clean(input.bookingUrl) } : {}),
      },
    });
    return this.me(repId);
  }

  // ----------------------------------------------------------------- leads

  async listLeads(
    repId: string,
    q: { search?: string; status?: string; filter?: string },
    now = new Date(),
  ): Promise<SalesLeadListDto> {
    const where: Prisma.PlatformLeadWhereInput = { salesRepId: repId };
    if (q.status) where.status = q.status;
    if (q.search) {
      const contains = { contains: q.search, mode: 'insensitive' as const };
      where.OR = [
        { companyName: contains },
        { contactName: contains },
        { email: contains },
        { phone: contains },
        { city: contains },
      ];
    }
    // Los filtros van en la consulta: con más de 500 leads no se quedan cortos.
    const cutoffDate = new Date(now.getTime() - NO_CONTACT_DAYS * DAY);
    if (q.filter === 'no_contact') {
      where.AND = [
        { status: { notIn: ['customer', 'lost'] } },
        {
          OR: [
            { salesProfile: { is: { lastContactAt: { lt: cutoffDate } } } },
            {
              AND: [
                {
                  OR: [
                    { salesProfile: { is: null } },
                    { salesProfile: { is: { lastContactAt: null } } },
                  ],
                },
                { activities: { none: { occurredAt: { gte: cutoffDate } } } },
              ],
            },
          ],
        },
      ];
    } else if (q.filter === 'trial_ending') {
      where.tenant = { status: 'trial', trialEndsAt: { lte: new Date(now.getTime() + 7 * DAY) } };
    } else if (q.filter === 'pending') {
      where.tenantId = { not: null };
      where.tenant = { OR: [{ salesRepId: null }, { salesRepId: { not: repId } }] };
    }
    const [dtos, groups] = await Promise.all([
      this.leads.listDtos(where, 500),
      this.admin.platformLead.groupBy({
        by: ['status'],
        where: { salesRepId: repId, discardedAt: null },
        _count: { _all: true },
      }),
    ]);
    const ids = dtos.map((d) => d.id);
    const tenantIds = dtos.map((d) => d.tenant?.id).filter((x): x is string => !!x);
    const [profiles, tenants] = await Promise.all([
      ids.length ? this.admin.salesAccountProfile.findMany({ where: { leadId: { in: ids } } }) : [],
      tenantIds.length
        ? this.admin.tenant.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, status: true, trialEndsAt: true, salesRepId: true },
          })
        : [],
    ]);
    const profileOf = new Map(profiles.map((p) => [p.leadId, p]));
    const tenantOf = new Map(tenants.map((t) => [t.id, t]));
    let items: SalesLeadDto[] = dtos.map((d) => ({
      ...d,
      salesProfile: profileDto(profileOf.get(d.id)),
      tenantStatus: d.tenant ? (tenantOf.get(d.tenant.id)?.status ?? null) : null,
    }));
    const cutoff = now.getTime() - NO_CONTACT_DAYS * DAY;
    if (q.filter === 'no_contact') {
      items = items.filter((l) => {
        if (l.status === 'customer' || l.status === 'lost') return false;
        const last = l.salesProfile?.lastContactAt ?? l.lastActivityAt;
        return !last || new Date(last).getTime() < cutoff;
      });
    } else if (q.filter === 'trial_ending') {
      items = items.filter((l) => {
        const t = l.tenant ? tenantOf.get(l.tenant.id) : null;
        const left = daysUntil(t?.trialEndsAt, now);
        return t?.status === 'trial' && left !== null && left <= 7;
      });
    } else if (q.filter === 'pending') {
      items = items.filter((l) => l.tenant && tenantOf.get(l.tenant.id)?.salesRepId !== repId);
    }
    const counts: Record<string, number> = {};
    for (const g of groups) counts[g.status] = g._count._all;
    return { items, counts };
  }

  async createProspect(
    repId: string,
    input: CreateSalesProspectInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    const email = clean(input.email)?.toLowerCase() ?? null;
    const phone = clean(input.phone);
    const detail = await this.withContactLock(async () => {
      await this.assertNewContact(email, phone);
      const lead = await this.leads.create(
        {
          source: 'admin',
          companyName: input.companyName ?? '',
          contactName: input.contactName ?? '',
          email: email ?? '',
          phone: phone ?? '',
          city: input.city ?? '',
          units: input.units ?? '',
          facilities: input.facilities ?? '',
          currentSoftware: input.currentSoftware ?? '',
          profile: input.profile ?? '',
          planSlug: '',
          message: input.note ?? '',
          assignedToId: repId,
        },
        this.actor(actor),
      );
      await this.assignment.assign({
        leadId: lead.id,
        repId,
        source: 'lead',
        byId: repId,
        quiet: true,
      });
      return lead;
    });
    return this.account(repId, detail.id, actor);
  }

  /**
   * Las altas de contactos nuevos van de una en una: dos comerciales (o dos
   * clics) con el mismo contacto a la vez no lo dan de alta dos veces.
   */
  private async withContactLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sales-new-contact'))`;
        return fn();
      },
      { maxWait: 30_000, timeout: 180_000 },
    );
  }

  /**
   * Un contacto que ya está en TrasterOS (lead o cuenta) no se puede dar de
   * alta otra vez. No se dice de quién es: lo decide la dirección.
   */
  private async assertNewContact(
    email: string | null,
    phone: string | null,
    exceptLeadId?: string,
  ): Promise<void> {
    const conflict = () =>
      new ConflictException({
        code: 'lead_exists',
        message:
          'Este contacto ya está en TrasterOS. Si crees que es tuyo, pídeselo a la dirección.',
      });
    if (email) {
      const [lead, owner] = await Promise.all([
        this.admin.platformLead.findFirst({
          where: {
            discardedAt: null,
            email: { equals: email, mode: 'insensitive' },
            ...(exceptLeadId ? { id: { not: exceptLeadId } } : {}),
          },
          select: { id: true },
        }),
        this.admin.user.findFirst({
          where: {
            email: { equals: email, mode: 'insensitive' },
            role: 'owner',
            tenant: { deletedAt: null },
          },
          select: { id: true },
        }),
      ]);
      if (lead || owner) throw conflict();
    }
    const tail = phoneTail(phone);
    if (tail) {
      const rows = await this.admin.$queryRaw<{ id: string }[]>`
        SELECT id FROM platform_leads
         WHERE discarded_at IS NULL AND phone IS NOT NULL
           AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ${tail}
           AND id <> ${exceptLeadId ?? '00000000-0000-0000-0000-000000000000'}::uuid
         LIMIT 1`;
      if (rows.length > 0) throw conflict();
    }
  }

  async updateLead(
    repId: string,
    leadId: string,
    input: UpdateSalesLeadInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    const current = await this.assignment.leadOf(repId, leadId);
    const email =
      input.email !== undefined ? (clean(input.email)?.toLowerCase() ?? null) : undefined;
    const phone = input.phone !== undefined ? clean(input.phone) : undefined;
    const emailChanged = email !== undefined && email !== (current.email?.toLowerCase() ?? null);
    const phoneChanged =
      phone !== undefined && phoneTail(phone) !== phoneTail(current.phone ?? null);
    if (emailChanged || phoneChanged) {
      // Con su cuenta ya creada, el email de su propietario sí es el suyo.
      const ownEmail =
        emailChanged && email && current.tenantId
          ? await this.admin.user.findFirst({
              where: {
                tenantId: current.tenantId,
                email: { equals: email, mode: 'insensitive' },
              },
              select: { id: true },
            })
          : null;
      await this.assertNewContact(
        emailChanged && !ownEmail ? (email ?? null) : null,
        phoneChanged ? (phone ?? null) : null,
        leadId,
      );
    }
    await this.leads.update(leadId, {
      ...(input.companyName !== undefined ? { companyName: input.companyName } : {}),
      ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.units !== undefined ? { units: input.units } : {}),
      ...(input.facilities !== undefined ? { facilities: input.facilities } : {}),
      ...(input.currentSoftware !== undefined ? { currentSoftware: input.currentSoftware } : {}),
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
    });
    return this.account(repId, leadId, actor);
  }

  async move(repId: string, leadId: string, input: MovePlatformLeadInput, actor: SalesActor) {
    await this.assignment.leadOf(repId, leadId);
    await this.leads.move(leadId, input, this.actor(actor));
    return this.account(repId, leadId, actor);
  }

  async lose(repId: string, leadId: string, input: LosePlatformLeadInput, actor: SalesActor) {
    await this.assignment.leadOf(repId, leadId);
    await this.leads.lose(leadId, input, this.actor(actor));
    return this.account(repId, leadId, actor);
  }

  async reopen(repId: string, leadId: string, actor: SalesActor) {
    await this.assignment.leadOf(repId, leadId);
    await this.leads.reopen(leadId, this.actor(actor));
    return this.account(repId, leadId, actor);
  }

  // ------------------------------------------------------------- la ficha

  async account(repId: string, leadId: string, actor?: SalesActor): Promise<SalesAccountDto> {
    const lead = await this.assignment.leadOf(repId, leadId);
    const [detail, profile, tenant, cadence] = await Promise.all([
      this.leads.detail(leadId),
      this.admin.salesAccountProfile.findUnique({ where: { leadId } }),
      lead.tenantId
        ? this.admin.tenant.findUnique({
            where: { id: lead.tenantId },
            select: { salesRepId: true },
          })
        : null,
      this.enrollmentOf(leadId),
    ]);
    const pendingAssignment = !!lead.tenantId && tenant?.salesRepId !== repId;
    const client =
      lead.tenantId && !pendingAssignment ? await this.clientSheet(lead.tenantId) : null;
    if (actor && lead.tenantId && !pendingAssignment) {
      await this.audit.record({
        superAdminId: repId,
        action: 'admin.sales.account_viewed',
        targetType: 'tenant',
        targetId: lead.tenantId,
        targetTenantId: lead.tenantId,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
    }
    return {
      // Pendiente de asignar: no ve las propuestas de la cuenta (pueden ser de otros).
      lead: pendingAssignment ? { ...detail, quoteOffers: [] } : detail,
      profile: profileDto(profile),
      client,
      cadence,
      pendingAssignment,
    };
  }

  /** Lo que ve el comercial de la cuenta de un cliente (sin inquilinos ni facturación). */
  async clientSheet(tenantId: string, now = new Date()): Promise<SalesClientSheetDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        trialEndsAt: true,
        subscription: {
          select: {
            status: true,
            billingMode: true,
            currentPeriodEnd: true,
            plan: { select: { name: true, slug: true } },
          },
        },
        users: {
          where: { role: 'owner', isActive: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { fullName: true, email: true, phone: true },
        },
        subscriptionAddons: {
          select: {
            id: true,
            addonId: true,
            quantity: true,
            priceMonthly: true,
            suspendedAt: true,
            addon: { select: { name: true } },
          },
        },
      },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Cliente no encontrado' });
    const since = new Date(now.getTime() - 90 * DAY);
    const [
      effective,
      units,
      facilities,
      users,
      contracts,
      lastLogin,
      onboarding,
      health,
      interest,
      firstPaid,
      opportunities,
      monthly,
    ] = await Promise.all([
      this.limits.resolveLimits(tenantId),
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
      this.admin.contract.count({
        where: { tenantId, deletedAt: null, status: { in: ['active', 'ending'] } },
      }),
      this.admin.user.aggregate({
        where: { tenantId, isActive: true },
        _max: { lastLoginAt: true },
      }),
      this.tenants.getOnboarding(tenantId).catch(() => null),
      this.tenants.getTenantHealth(tenantId).catch(() => null),
      this.admin.featureInterestEvent.groupBy({
        by: ['feature'],
        where: { tenantId, createdAt: { gte: since } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.commissions.firstPaidByTenant([tenantId]),
      this.opportunities.opportunities(now, [tenantId]).catch(() => []),
      this.commissions.monthlyByTenant([tenantId]),
    ]);
    const owner = tenant.users[0];
    return {
      tenantId: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      pastDue: tenant.subscription?.status === 'past_due',
      createdAt: tenant.createdAt.toISOString(),
      planName: tenant.subscription?.plan.name ?? null,
      planSlug: tenant.subscription?.plan.slug ?? null,
      billingMode: tenant.subscription?.billingMode ?? null,
      monthly: monthly.get(tenantId) ?? 0,
      trialEndsAt: tenant.status === 'trial' ? (tenant.trialEndsAt?.toISOString() ?? null) : null,
      trialDaysLeft: tenant.status === 'trial' ? daysUntil(tenant.trialEndsAt, now) : null,
      nextChargeAt:
        tenant.status === 'trial'
          ? null
          : (tenant.subscription?.currentPeriodEnd.toISOString() ?? null),
      firstPaidAt: firstPaid.get(tenantId)?.toISOString() ?? null,
      owner: owner ? { name: owner.fullName, email: owner.email, phone: owner.phone } : null,
      addons: tenant.subscriptionAddons.map((a) => ({
        id: a.id,
        addonId: a.addonId,
        name: a.addon.name,
        quantity: a.quantity,
        monthly: round2(Number(a.priceMonthly) * a.quantity),
        suspended: !!a.suspendedAt,
      })),
      usage: {
        units,
        unitsLimit: effective.units,
        facilities,
        facilitiesLimit: effective.facilities,
        users,
        usersLimit: effective.users,
        contracts,
      },
      onboarding: onboarding
        ? {
            completed: onboarding.completed,
            total: onboarding.total,
            pending: onboarding.items.filter((i) => !i.done).map((i) => i.label),
          }
        : { completed: 0, total: 0, pending: [] },
      health: health ? { score: health.score, level: health.level } : null,
      lastLoginAt: lastLogin._max.lastLoginAt?.toISOString() ?? null,
      featureInterest: interest
        .map((i) => ({
          feature: i.feature,
          label: FEATURE_LABELS[i.feature as TenantFeature] ?? i.feature,
          count: i._count._all,
          lastAt: (i._max.createdAt ?? now).toISOString(),
        }))
        .sort((a, b) => b.count - a.count),
      opportunities: opportunities
        .map((o) => ({ ...o, candidates: o.candidates.filter((c) => c.tenantId === tenantId) }))
        .filter((o) => o.candidates.length > 0),
    };
  }

  async upsertProfile(
    repId: string,
    leadId: string,
    input: UpdateSalesProfileInput,
  ): Promise<SalesAccountDto> {
    await this.assignment.leadOf(repId, leadId);
    const data = {
      ...(input.pinnedNote !== undefined ? { pinnedNote: clean(input.pinnedNote) } : {}),
      ...(input.status !== undefined ? { status: clean(input.status) } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.decisionMaker !== undefined ? { decisionMaker: clean(input.decisionMaker) } : {}),
      ...(input.bestTime !== undefined ? { bestTime: clean(input.bestTime) } : {}),
      ...(input.nextAction !== undefined ? { nextAction: clean(input.nextAction) } : {}),
      updatedById: repId,
    };
    await this.admin.salesAccountProfile.upsert({
      where: { leadId },
      create: { leadId, ...data },
      update: data,
    });
    return this.account(repId, leadId);
  }

  // ------------------------------------------------------ actividad y llamada

  async addActivity(
    repId: string,
    leadId: string,
    input: CreatePlatformLeadActivityInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    await this.assignment.leadOf(repId, leadId);
    if (input.occurredAt && new Date(input.occurredAt).getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException({
        code: 'activity_in_future',
        message: 'Lo que anotas ya ha pasado: para lo que vas a hacer, crea un seguimiento',
      });
    }
    await this.leads.createActivity(leadId, input, this.actor(actor));
    if (CONTACT_TYPES.has(input.type)) await this.touchContact(leadId, repId, null);
    return this.account(repId, leadId);
  }

  async touchContact(leadId: string, repId: string, outcome: string | null): Promise<void> {
    const now = new Date();
    await this.admin.salesAccountProfile.upsert({
      where: { leadId },
      create: { leadId, lastContactAt: now, lastOutcome: outcome, updatedById: repId },
      update: {
        lastContactAt: now,
        ...(outcome ? { lastOutcome: outcome } : {}),
        updatedById: repId,
      },
    });
  }

  /**
   * Resultado de una llamada (o un WhatsApp) en un toque: queda en el
   * historial, cierra lo que tocaba hoy y crea el siguiente seguimiento.
   */
  async callOutcome(
    repId: string,
    leadId: string,
    input: SalesCallOutcomeInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    const lead = await this.assignment.leadOf(repId, leadId);
    const label = SALES_CALL_OUTCOME_LABELS[input.outcome];
    const type = input.channel === 'email' ? 'note' : input.channel;
    const prefix =
      input.channel === 'email' ? 'Correo: ' : input.channel === 'whatsapp' ? 'WhatsApp: ' : '';
    await this.leads.createActivity(
      leadId,
      {
        type: type as CreatePlatformLeadActivityInput['type'],
        content: `${prefix}${label}${input.note ? ` — ${input.note}` : ''}`,
      },
      this.actor(actor),
    );
    const today = madridToday();
    // Lo que tocaba hasta hoy queda hecho.
    await this.admin.platformLeadFollowup.updateMany({
      where: {
        leadId,
        status: 'pending',
        dueDate: { lte: new Date(`${today}T00:00:00Z`) },
      },
      data: { status: 'done', completedAt: new Date() },
    });
    const days = SALES_OUTCOME_FOLLOWUP_DAYS[input.outcome];
    // null = «Ninguno»; sin fecha = la de por defecto del resultado.
    const date =
      input.followupDate === null
        ? null
        : (input.followupDate ?? (days != null ? addDaysIso(today, days) : null));
    if (date) {
      await this.leads.createFollowup(
        leadId,
        {
          title: SALES_OUTCOME_FOLLOWUP_TITLES[input.outcome] || 'Seguimiento',
          note: input.note ?? '',
          dueDate: date,
          assignedToId: repId,
        },
        this.actor(actor),
      );
    }
    if (
      (input.outcome === 'interested' || input.outcome === 'demo_booked') &&
      (lead.status === 'new' || lead.status === 'contacted')
    ) {
      await this.leads.move(leadId, { status: 'interested' }, this.actor(actor));
    }
    if (input.outcome === 'not_interested' && !lead.tenantId && lead.status !== 'lost') {
      await this.leads.lose(
        leadId,
        { reasonCode: 'other', reason: input.note ?? 'No le interesa' },
        this.actor(actor),
      );
    }
    await this.touchContact(leadId, repId, input.outcome);
    const temperature =
      input.outcome === 'interested' || input.outcome === 'demo_booked'
        ? 'hot'
        : input.outcome === 'not_interested'
          ? 'cold'
          : null;
    if (temperature) {
      await this.admin.salesAccountProfile.update({
        where: { leadId },
        data: { temperature },
      });
    }
    return this.account(repId, leadId);
  }

  // ------------------------------------------------------------ seguimientos

  async createFollowup(
    repId: string,
    leadId: string,
    input: CreatePlatformLeadFollowupInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    await this.assignment.leadOf(repId, leadId);
    await this.leads.createFollowup(leadId, { ...input, assignedToId: repId }, this.actor(actor));
    return this.account(repId, leadId);
  }

  private async followupOf(repId: string, followupId: string) {
    const row = await this.admin.platformLeadFollowup.findFirst({
      where: { id: followupId, lead: { salesRepId: repId, discardedAt: null } },
      select: { id: true, leadId: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    return row;
  }

  async updateFollowup(
    repId: string,
    followupId: string,
    input: UpdatePlatformLeadFollowupInput,
  ): Promise<PlatformLeadFollowupDto> {
    await this.followupOf(repId, followupId);
    return this.leads.updateFollowup(followupId, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    });
  }

  async deleteFollowup(repId: string, followupId: string): Promise<void> {
    await this.followupOf(repId, followupId);
    await this.leads.deleteFollowup(followupId);
  }

  // ------------------------------------------------------- correo y cuenta

  async sendEmail(
    repId: string,
    leadId: string,
    input: SendPlatformLeadEmailInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    const lead = await this.assignment.leadOf(repId, leadId);
    // Con cuenta, al propietario (es la dirección que enseña la ficha).
    const owner = lead.tenantId
      ? await this.admin.user.findFirst({
          where: { tenantId: lead.tenantId, role: 'owner', isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { email: true, fullName: true },
        })
      : null;
    await this.leads.sendEmail(
      leadId,
      input,
      this.actor(actor),
      await this.sender(repId),
      owner ? { email: owner.email, name: owner.fullName } : undefined,
    );
    await this.touchContact(leadId, repId, null);
    return this.account(repId, leadId);
  }

  /** Correo con su enlace de registro (lleva su código: la cuenta será suya). */
  async sendRegistrationLink(
    repId: string,
    leadId: string,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    const lead = await this.assignment.leadOf(repId, leadId);
    if (lead.tenantId) {
      throw new ConflictException({ code: 'lead_already_linked', message: 'Ya tiene cuenta' });
    }
    const code = await this.assignment.ensureCode(repId);
    const params = new URLSearchParams();
    if (lead.email) params.set('email', lead.email);
    if (lead.companyName) params.set('company', lead.companyName);
    if (lead.contactName) params.set('name', lead.contactName);
    const url = `${salesSignupUrl(this.config.get('WEB_BASE_URL', { infer: true }), code)}&${params.toString()}`;
    const sender = await this.sender(repId);
    const hello = lead.contactName?.trim().split(/\s+/)[0];
    const body = [
      `Hola${hello ? ` ${hello}` : ''}:`,
      '',
      `Como hablamos, aquí tienes el enlace para crear la cuenta de TrasterOS${lead.companyName ? ` de ${lead.companyName}` : ''}. La prueba es gratis y sin tarjeta.`,
      '',
      `[[boton: Crear mi cuenta | ${url}]]`,
      '',
      'Cuando la tengas, te ayudo a dejarla lista.',
      '',
      sender.signature ?? '',
    ].join('\n');
    await this.leads.sendEmail(
      leadId,
      { subject: 'Tu cuenta de TrasterOS', body },
      this.actor(actor),
      sender,
    );
    await this.touchContact(leadId, repId, null);
    return this.account(repId, leadId);
  }

  /** Crea su cuenta con la prueba estándar; queda en su cartera. */
  async createTenant(
    repId: string,
    leadId: string,
    input: { tenantName: string; ownerName: string; ownerEmail: string },
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    const lead = await this.assignment.leadOf(repId, leadId);
    if (lead.tenantId) {
      throw new ConflictException({ code: 'lead_already_linked', message: 'Ya tiene cuenta' });
    }
    const owner = await this.admin.user.findFirst({
      where: {
        email: { equals: input.ownerEmail, mode: 'insensitive' },
        role: 'owner',
        tenant: { deletedAt: null },
      },
      select: { id: true },
    });
    if (owner) {
      throw new ConflictException({
        code: 'tenant_exists',
        message: 'Ya hay una cuenta con ese email. Si crees que es tuya, pídesela a la dirección.',
      });
    }
    await this.leads.createTenant(
      leadId,
      {
        tenantName: input.tenantName,
        ownerName: input.ownerName,
        ownerEmail: input.ownerEmail,
        planSlug: 'starter',
        trialDays: 30,
      },
      this.actor(actor),
    );
    const after = await this.admin.platformLead.findUnique({
      where: { id: leadId },
      select: { tenantId: true },
    });
    if (after?.tenantId) {
      await this.assignment.assign({
        leadId,
        tenantId: after.tenantId,
        repId,
        source: 'created',
        byId: repId,
        quiet: true,
      });
    }
    return this.account(repId, leadId, actor);
  }

  // ---------------------------------------------------------------- clientes

  async listClients(
    repId: string,
    filter: string | undefined,
    now = new Date(),
  ): Promise<SalesClientRowDto[]> {
    const tenants = await this.admin.tenant.findMany({
      where: { salesRepId: repId, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        trialEndsAt: true,
        salesSource: true,
        salesAssignedAt: true,
        subscription: { select: { status: true, plan: { select: { name: true } } } },
        subscriptionAddons: {
          where: { suspendedAt: null },
          select: { addon: { select: { name: true } } },
        },
        platformLead: {
          select: {
            id: true,
            salesProfile: true,
            followups: {
              where: { status: 'pending' },
              orderBy: { dueDate: 'asc' },
              take: 1,
              select: { id: true, title: true, dueDate: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    // Cuentas antiguas sin lead: se les crea para poder llevarlas.
    for (const t of tenants.filter((x) => !x.platformLead)) {
      await this.assignment.ensureLeadForTenant(t.id);
    }
    const ids = tenants.map((t) => t.id);
    if (ids.length === 0) return [];
    const [monthly, firstPaid, units, contracts, logins, health, effectiveLimits] =
      await Promise.all([
        this.commissions.monthlyByTenant(ids),
        this.commissions.firstPaidByTenant(ids),
        this.admin.unit.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids } },
          _count: { _all: true },
        }),
        this.admin.contract.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids }, deletedAt: null, status: { in: ['active', 'ending'] } },
          _count: { _all: true },
        }),
        this.admin.user.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids }, isActive: true },
          _max: { lastLoginAt: true },
        }),
        this.tenants.getTenantsHealth().catch(() => []),
        Promise.all(ids.map(async (id) => [id, await this.limits.resolveLimits(id)] as const)),
      ]);
    const leadIds = await this.admin.platformLead.findMany({
      where: { tenantId: { in: ids } },
      select: { id: true, tenantId: true },
    });
    const leadOf = new Map(leadIds.map((l) => [l.tenantId!, l.id]));
    const unitsOf = new Map(units.map((u) => [u.tenantId, u._count._all]));
    const contractsOf = new Map(contracts.map((c) => [c.tenantId, c._count._all]));
    const loginOf = new Map(logins.map((l) => [l.tenantId, l._max.lastLoginAt]));
    const healthOf = new Map(health.map((h) => [h.tenantId, h]));
    const limitOf = new Map(effectiveLimits);
    let rows: SalesClientRowDto[] = tenants.map((t) => {
      const f = t.platformLead?.followups[0];
      const h = healthOf.get(t.id);
      return {
        leadId: t.platformLead?.id ?? leadOf.get(t.id) ?? '',
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        pastDue: t.subscription?.status === 'past_due',
        planName: t.subscription?.plan.name ?? null,
        monthly: monthly.get(t.id) ?? 0,
        trialEndsAt: t.status === 'trial' ? (t.trialEndsAt?.toISOString() ?? null) : null,
        trialDaysLeft: t.status === 'trial' ? daysUntil(t.trialEndsAt, now) : null,
        healthScore: h?.score ?? null,
        healthLevel: h?.level ?? null,
        lastLoginAt: loginOf.get(t.id)?.toISOString() ?? null,
        units: unitsOf.get(t.id) ?? 0,
        unitsLimit: limitOf.get(t.id)?.units ?? null,
        contracts: contractsOf.get(t.id) ?? 0,
        addons: t.subscriptionAddons.map((a) => a.addon.name),
        firstPaidAt: firstPaid.get(t.id)?.toISOString() ?? null,
        salesSource: t.salesSource,
        assignedAt: t.salesAssignedAt?.toISOString() ?? null,
        nextFollowup: f
          ? { id: f.id, title: f.title, dueDate: f.dueDate.toISOString().slice(0, 10) }
          : null,
        profile: profileDto(t.platformLead?.salesProfile ?? null),
      };
    });
    const cutoff = now.getTime() - NO_CONTACT_DAYS * DAY;
    if (filter === 'trial') rows = rows.filter((r) => r.status === 'trial');
    else if (filter === 'paying')
      rows = rows.filter((r) => !!r.firstPaidAt && r.status === 'active');
    else if (filter === 'past_due') rows = rows.filter((r) => r.pastDue);
    else if (filter === 'trial_ending') {
      rows = rows.filter((r) => r.trialDaysLeft !== null && r.trialDaysLeft <= 7);
    } else if (filter === 'onboarding')
      rows = rows.filter((r) => r.units === 0 || r.contracts === 0);
    else if (filter === 'no_contact') {
      rows = rows.filter((r) => {
        const last = r.profile?.lastContactAt;
        return !last || new Date(last).getTime() < cutoff;
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------- cadencias

  private async enrollmentOf(leadId: string): Promise<SalesCadenceEnrollmentDto | null> {
    const row = await this.admin.salesCadenceEnrollment.findFirst({
      where: { leadId },
      orderBy: { startedAt: 'desc' },
      include: { cadence: { select: { name: true } } },
    });
    if (!row) return null;
    const followups = row.followupIds.length
      ? await this.admin.platformLeadFollowup.findMany({
          where: { id: { in: row.followupIds } },
          select: { id: true, title: true, dueDate: true, status: true },
          orderBy: { dueDate: 'asc' },
        })
      : [];
    let status = row.status as SalesCadenceEnrollmentDto['status'];
    if (
      status === 'active' &&
      followups.length > 0 &&
      followups.every((f) => f.status === 'done')
    ) {
      status = 'done';
      await this.admin.salesCadenceEnrollment.update({
        where: { id: row.id },
        data: { status: 'done', finishedAt: new Date() },
      });
    }
    return {
      id: row.id,
      cadenceId: row.cadenceId,
      cadenceName: row.cadence.name,
      status,
      startedAt: row.startedAt.toISOString(),
      steps: followups.map((f) => ({
        followupId: f.id,
        title: f.title,
        dueDate: f.dueDate.toISOString().slice(0, 10),
        done: f.status === 'done',
      })),
    };
  }

  async enrollCadence(
    repId: string,
    leadId: string,
    cadenceId: string,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    await this.assignment.leadOf(repId, leadId);
    const cadence = await this.admin.salesCadence.findFirst({
      where: { id: cadenceId, isActive: true },
    });
    if (!cadence)
      throw new NotFoundException({ code: 'cadence_not_found', message: 'Cadencia no encontrada' });
    const active = await this.admin.salesCadenceEnrollment.findFirst({
      where: { leadId, status: 'active' },
      select: { id: true },
    });
    if (active) {
      throw new ConflictException({
        code: 'cadence_active',
        message: 'Ya tiene una cadencia en marcha: párala antes de empezar otra',
      });
    }
    const steps = SalesCadenceStepSchema.array().parse(cadence.steps);
    const dates = cadenceDueDates(madridToday(), steps);
    // Alta y seguimientos juntos: un doble clic no deja seguimientos sueltos.
    try {
      await this.admin.$transaction(async (tx) => {
        const enrollment = await tx.salesCadenceEnrollment.create({
          data: { cadenceId, leadId, repId, followupIds: [] },
          select: { id: true },
        });
        const ids: string[] = [];
        for (const [i, step] of steps.entries()) {
          const row = await tx.platformLeadFollowup.create({
            data: {
              leadId,
              superAdminId: actor.repId,
              assignedToId: repId,
              title: `${SALES_CADENCE_CHANNEL_LABELS[step.channel]}: ${step.title}`.slice(0, 200),
              note: `Cadencia «${cadence.name}»`,
              dueDate: new Date(`${dates[i]}T00:00:00Z`),
            },
            select: { id: true },
          });
          ids.push(row.id);
        }
        await tx.salesCadenceEnrollment.update({
          where: { id: enrollment.id },
          data: { followupIds: ids },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'cadence_active',
          message: 'Ya tiene una cadencia en marcha: párala antes de empezar otra',
        });
      }
      throw err;
    }
    return this.account(repId, leadId);
  }

  async stopCadence(repId: string, leadId: string): Promise<SalesAccountDto> {
    await this.assignment.leadOf(repId, leadId);
    const active = await this.admin.salesCadenceEnrollment.findFirst({
      where: { leadId, status: 'active' },
    });
    if (active) {
      await this.admin.platformLeadFollowup.deleteMany({
        where: { id: { in: active.followupIds }, status: 'pending' },
      });
      await this.admin.salesCadenceEnrollment.update({
        where: { id: active.id },
        data: { status: 'stopped', finishedAt: new Date() },
      });
    }
    return this.account(repId, leadId);
  }

  // ---------------------------------------------------------------- resumen

  /**
   * Resumen para preparar la llamada: lo esencial en frases (siempre) y, si se
   * pide y hay IA, un párrafo redactado con lo que conviene hablar.
   */
  async summary(
    repId: string,
    leadId: string,
    withAi: boolean,
    now = new Date(),
  ): Promise<SalesAccountSummaryDto> {
    const account = await this.account(repId, leadId);
    const { lead, profile, client } = account;
    const lines: string[] = [];
    lines.push(`${lead.displayName}${lead.city ? ` (${lead.city})` : ''}.`);
    if (profile?.pinnedNote) lines.push(`Nota: ${profile.pinnedNote}`);
    if (profile?.status) lines.push(`Estado comercial: ${profile.status}.`);
    if (profile?.temperature)
      lines.push(`Temperatura: ${SALES_TEMPERATURE_LABELS[profile.temperature]}.`);
    if (profile?.decisionMaker) lines.push(`Decide: ${profile.decisionMaker}.`);
    if (profile?.bestTime) lines.push(`Mejor hora: ${profile.bestTime}.`);
    if (profile?.lastContactAt) {
      const days = Math.floor((now.getTime() - new Date(profile.lastContactAt).getTime()) / DAY);
      lines.push(
        `Último contacto hace ${days} días${profile.lastOutcome ? `: ${SALES_CALL_OUTCOME_LABELS[profile.lastOutcome]}` : ''}.`,
      );
    } else {
      lines.push('Aún no hay contactos anotados.');
    }
    if (lead.units) lines.push(`Trasteros: ${lead.units}.`);
    if (lead.currentSoftware) lines.push(`Usa ahora: ${lead.currentSoftware}.`);
    if (client) {
      if (client.status === 'trial') {
        lines.push(
          `En prueba${client.trialDaysLeft !== null ? `: le quedan ${client.trialDaysLeft} días` : ''}.`,
        );
      } else if (client.pastDue) {
        lines.push('Tiene un pago pendiente.');
      } else if (client.firstPaidAt) {
        lines.push(
          `Cliente de pago: ${client.planName ?? 'plan'} · ${client.monthly.toFixed(2)} € al mes.`,
        );
      }
      lines.push(
        `Puesta en marcha: ${client.onboarding.completed} de ${client.onboarding.total}${client.onboarding.pending.length ? ` (falta: ${client.onboarding.pending.slice(0, 3).join(', ')})` : ''}.`,
      );
      if (client.usage.unitsLimit) {
        lines.push(`Trasteros: ${client.usage.units} de ${client.usage.unitsLimit} de su plan.`);
      }
      if (client.featureInterest.length) {
        lines.push(
          `Ha intentado usar: ${client.featureInterest
            .slice(0, 3)
            .map((f) => f.label)
            .join(', ')}.`,
        );
      }
      for (const o of client.opportunities.slice(0, 2)) {
        lines.push(
          `Le podría interesar ${o.addonName}: ${o.candidates[0]?.reasons.join(', ') ?? ''}.`,
        );
      }
    }
    const openOffer = lead.quoteOffers.find((o) => o.status === 'sent' && !o.expired);
    if (openOffer) {
      lines.push(
        `Propuesta enviada (${openOffer.total.toFixed(2)} €)${openOffer.openedAt ? ', ya la ha abierto' : ', aún sin abrir'}.`,
      );
    }
    const next = lead.followups.find((f) => f.status === 'pending');
    if (next) lines.push(`Siguiente paso: ${next.title} (${next.dueDate}).`);
    const recent = lead.activities
      .filter((a) => a.type !== 'system')
      .slice(0, 3)
      .map((a) => `${a.occurredAt.slice(0, 10)}: ${a.content.slice(0, 140)}`);

    let aiText: string | null = null;
    if (withAi && this.ai.available) {
      try {
        const completion = await this.ai.createMessage({
          system:
            'Eres un jefe de ventas de TrasterOS (programa de gestión de trasteros para empresas). ' +
            'Con los datos de una cuenta, escribe en español y en 4-6 frases cortas: en qué punto está, ' +
            'qué preguntarle y qué ofrecerle en la próxima llamada. No inventes datos.',
          messages: [
            {
              role: 'user',
              content: [...lines, ...(recent.length ? ['Últimas notas:', ...recent] : [])].join(
                '\n',
              ),
            },
          ],
          tools: [],
        });
        aiText =
          completion.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim() || null;
      } catch (err) {
        this.logger.warn(`[sales] resumen con IA: ${String(err)}`);
      }
    }
    return { lines, aiText, aiAvailable: this.ai.available };
  }

  // ---------------------------------------------------------------- importar

  /** Lista de prospectos (CSV): revisa y, al confirmar, los da de alta en su cartera. */
  async importProspects(
    repId: string,
    input: SalesImportInput,
    actor: SalesActor,
  ): Promise<SalesImportResultDto> {
    // Al confirmar, se revisa y se da de alta sin que otra alta se cuele en medio.
    return input.commit
      ? this.withContactLock(() => this.runImport(repId, input, actor))
      : this.runImport(repId, input, actor);
  }

  private async runImport(
    repId: string,
    input: SalesImportInput,
    actor: SalesActor,
  ): Promise<SalesImportResultDto> {
    const { columns, records } = parseRaw(input.csv);
    const map = new Map<string, keyof typeof fieldsTemplate>();
    const fieldsTemplate = {
      companyName: '',
      contactName: '',
      email: '',
      phone: '',
      city: '',
      units: '',
      note: '',
    };
    for (const col of columns) {
      const field = IMPORT_ALIASES[normalizeHeader(col)];
      if (field) map.set(col, field);
    }
    if (records.length > 500) {
      throw new BadRequestException({
        code: 'too_many_rows',
        message: 'Como mucho 500 prospectos por fichero',
      });
    }
    const rows: (SalesImportRowDto & { units: string | null; note: string | null })[] = [];
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();
    for (const [i, rec] of records.entries()) {
      const f = { ...fieldsTemplate };
      for (const [col, field] of map) f[field] = (rec[col] ?? '').trim();
      const email = f.email ? f.email.toLowerCase() : null;
      const phone = f.phone || null;
      let error: string | null = null;
      if (!f.companyName && !f.contactName) error = 'Falta la empresa o la persona';
      else if (!email && !phone) error = 'Falta un email o un teléfono';
      else if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = 'Email no válido';
      let duplicate = false;
      if (!error) {
        const tail = phoneTail(phone);
        if ((email && seenEmails.has(email)) || (tail && seenPhones.has(tail))) duplicate = true;
        if (!duplicate) {
          try {
            await this.assertNewContact(email, phone);
          } catch {
            duplicate = true;
          }
        }
        if (email) seenEmails.add(email);
        if (tail) seenPhones.add(tail);
      }
      rows.push({
        line: i + 2,
        companyName: f.companyName || null,
        contactName: f.contactName || null,
        email,
        phone,
        city: f.city || null,
        units: f.units || null,
        note: f.note || null,
        duplicate,
        error,
      });
    }
    let created = 0;
    if (input.commit) {
      for (const r of rows) {
        if (r.error || r.duplicate) continue;
        const lead = await this.admin.platformLead.create({
          data: {
            status: 'new',
            source: 'admin',
            companyName: r.companyName,
            contactName: r.contactName,
            email: r.email,
            phone: r.phone,
            city: r.city,
            units: r.units,
            assignedToId: repId,
            createdById: repId,
          },
          select: { id: true },
        });
        if (r.note) {
          await this.admin.platformLeadActivity.create({
            data: { leadId: lead.id, type: 'note', content: r.note, superAdminId: repId },
          });
        }
        await this.assignment.assign({
          leadId: lead.id,
          repId,
          source: 'import',
          byId: repId,
          quiet: true,
        });
        created += 1;
      }
      await this.audit.record({
        superAdminId: repId,
        action: 'admin.sales.prospects_imported',
        targetType: 'platform_lead',
        targetId: null,
        changes: { created },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
    }
    return {
      rows: rows.map(({ units: _u, note: _n, ...r }) => r),
      valid: rows.filter((r) => !r.error && !r.duplicate).length,
      duplicates: rows.filter((r) => r.duplicate).length,
      errors: rows.filter((r) => !!r.error).length,
      created,
    };
  }

  // ---------------------------------------------------------------- «Hoy»

  async today(repId: string, now = new Date()): Promise<SalesTodayDto> {
    const today = madridToday(now);
    const todayDate = new Date(`${today}T00:00:00Z`);
    const in7 = new Date(now.getTime() + 7 * DAY);
    const month = salesMonth(now);
    const [followups, clients, leadsCount, offers, newSignups, commission, target, achieved] =
      await Promise.all([
        this.admin.platformLeadFollowup.findMany({
          where: {
            status: 'pending',
            dueDate: { lte: todayDate },
            lead: { salesRepId: repId, discardedAt: null },
          },
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
          take: 100,
          include: { lead: { select: { companyName: true, contactName: true, email: true } } },
        }),
        this.listClients(repId, undefined, now),
        this.admin.platformLead.groupBy({
          by: ['status'],
          where: { salesRepId: repId, discardedAt: null },
          _count: { _all: true },
        }),
        this.admin.platformQuoteOffer.findMany({
          where: {
            superAdminId: repId,
            status: 'sent',
            // Las caducadas solo dos semanas; y solo de cuentas que siguen siendo suyas.
            OR: [{ expiresAt: null }, { expiresAt: { gte: new Date(now.getTime() - 14 * DAY) } }],
            AND: [
              { OR: [{ tenantId: null }, { tenant: { salesRepId: repId, deletedAt: null } }] },
              { OR: [{ leadId: null }, { lead: { salesRepId: repId, discardedAt: null } }] },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            tenant: { select: { name: true } },
            lead: { select: { id: true, companyName: true, contactName: true, email: true } },
          },
        }),
        this.admin.tenant.findMany({
          where: {
            salesRepId: repId,
            deletedAt: null,
            salesSource: { in: ['link', 'code'] },
            salesAssignedAt: { gte: new Date(now.getTime() - 7 * DAY) },
          },
          select: {
            id: true,
            name: true,
            salesAssignedAt: true,
            platformLead: { select: { id: true } },
          },
        }),
        this.commissions.commissionByRep(month),
        this.admin.salesTarget.findUnique({ where: { repId_month: { repId, month } } }),
        this.commissions.monthAchievements(month),
      ]);
    const row = (c: SalesClientRowDto, detail: string, date: string | null): SalesTodayRowDto => ({
      leadId: c.leadId,
      tenantId: c.tenantId,
      name: c.name,
      detail,
      date,
    });
    const trialsEnding = clients
      .filter((c) => c.trialDaysLeft !== null && c.trialDaysLeft <= 7)
      .sort((a, b) => (a.trialDaysLeft ?? 0) - (b.trialDaysLeft ?? 0))
      .map((c) =>
        row(
          c,
          c.trialDaysLeft !== null && c.trialDaysLeft <= 0
            ? 'La prueba acaba hoy'
            : `Le quedan ${c.trialDaysLeft} días de prueba`,
          c.trialEndsAt,
        ),
      );
    const pastDue = clients.filter((c) => c.pastDue).map((c) => row(c, 'Pago pendiente', null));
    const stuck = clients
      .filter((c) => c.status === 'trial' && (c.units === 0 || c.contracts === 0))
      .map((c) =>
        row(
          c,
          c.units === 0 ? 'Aún no ha creado trasteros' : 'Aún no tiene contratos',
          c.assignedAt,
        ),
      );
    const cutoff = now.getTime() - NO_CONTACT_DAYS * DAY;
    // Las cuentas recién llegadas ya salen en «Altas con tu código».
    const noContact = clients
      .filter((c) => {
        const ref = c.profile?.lastContactAt ?? c.assignedAt;
        return !ref || new Date(ref).getTime() < cutoff;
      })
      .slice(0, 20)
      .map((c) =>
        row(
          c,
          c.profile?.lastContactAt
            ? `Sin hablar desde el ${c.profile.lastContactAt.slice(0, 10).split('-').reverse().join('/')}`
            : 'Aún no hay contactos anotados',
          c.profile?.lastContactAt ?? null,
        ),
      );
    const offersPending: SalesTodayRowDto[] = offers
      .filter((o) => o.openedAt || (o.expiresAt && o.expiresAt.getTime() < in7.getTime()))
      .map((o) => ({
        leadId: o.lead?.id ?? o.leadId ?? '',
        tenantId: o.tenantId,
        name: o.tenant?.name ?? (o.lead ? platformLeadName(o.lead) : 'Propuesta'),
        detail:
          o.expiresAt && o.expiresAt.getTime() < now.getTime()
            ? 'La propuesta ha caducado'
            : o.openedAt
              ? 'Ha abierto tu propuesta y no la ha aceptado'
              : 'Tu propuesta caduca pronto',
        date: o.expiresAt?.toISOString() ?? null,
      }))
      .filter((o) => !!o.leadId);
    const counts: Record<string, number> = {};
    for (const g of leadsCount) counts[g.status] = g._count._all;
    const mine = achieved.get(repId) ?? { newClients: 0, newMrr: 0 };
    const appointments = await this.appointments.todayForRep(repId, now);
    return {
      date: today,
      appointments,
      followups: followups.map((f) => ({
        id: f.id,
        leadId: f.leadId,
        leadName: platformLeadName(f.lead),
        title: f.title,
        note: f.note,
        dueDate: f.dueDate.toISOString().slice(0, 10),
        overdue: f.dueDate.getTime() < todayDate.getTime(),
      })),
      trialsEnding,
      pastDue,
      newSignups: newSignups.map((t) => ({
        leadId: t.platformLead?.id ?? '',
        tenantId: t.id,
        name: t.name,
        detail: 'Se ha registrado con tu código',
        date: t.salesAssignedAt?.toISOString() ?? null,
      })),
      stuckOnboarding: stuck,
      offersPending,
      noContact,
      kpis: {
        prospects: (counts.new ?? 0) + (counts.contacted ?? 0) + (counts.interested ?? 0),
        trials: clients.filter((c) => c.status === 'trial').length,
        customers: clients.filter((c) => !!c.firstPaidAt && c.status === 'active').length,
        mrr: round2(
          clients
            .filter((c) => !!c.firstPaidAt && c.status === 'active')
            .reduce((s, c) => s + c.monthly, 0),
        ),
        newClientsMonth: mine.newClients,
        newMrrMonth: mine.newMrr,
        commissionMonth: commission.get(repId) ?? 0,
        target: target ? { newClients: target.newClients, newMrr: Number(target.newMrr) } : null,
      },
    };
  }
}
