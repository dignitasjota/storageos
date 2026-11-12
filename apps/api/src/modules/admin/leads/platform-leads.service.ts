import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_STAGE_LABELS,
  PLATFORM_LEAD_TRIAL_RECONTACT_DAYS,
  PLATFORM_LEAD_UNATTENDED_HOURS,
  platformLeadName,
  renderAdminEmail,
} from '@storageos/shared';

import { todayInTimezone } from '../../../common/format';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { EmailService } from '../../email/email.service';
import { PlatformService } from '../../platform/platform.service';
import { AdminQuoteService } from '../admin-quote.service';
import { AdminTenantInteractionsService } from '../admin-tenant-interactions.service';
import { AdminTenantToolsService } from '../admin-tenant-tools.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import type {
  PlatformLeadInboundEvent,
  PlatformTenantRegisteredEvent,
} from '../../../common/platform-lead-events';
import type {
  AdminCreateTenantInput,
  CreatePlatformLeadActivityInput,
  CreatePlatformLeadFollowupInput,
  CreatePlatformLeadInput,
  LosePlatformLeadInput,
  MovePlatformLeadInput,
  PlatformLeadActivityDto,
  PlatformLeadActivityType,
  PlatformLeadBoardDto,
  PlatformLeadDetailDto,
  PlatformLeadDto,
  PlatformLeadFollowupDto,
  PlatformLeadLostReason,
  PlatformLeadsQuery,
  PlatformLeadSource,
  PlatformLeadStage,
  PlatformLeadStatsDto,
  PlatformLeadTenantRefDto,
  SendAdminQuoteInput,
  SendPlatformLeadEmailInput,
  UpdatePlatformLeadFollowupInput,
  UpdatePlatformLeadInput,
} from '@storageos/shared';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MANUAL_ACTIVITY_TYPES = new Set(['note', 'call', 'demo', 'meeting', 'whatsapp']);
/** Lo que cuenta como haberle respondido (y le pasa de «Nuevo» a «Contactado»). */
const CONTACT_ACTIVITY_TYPES = new Set(['call', 'demo', 'meeting', 'whatsapp']);
const STAGE_RANK: Record<string, number> = {
  new: 0,
  contacted: 1,
  interested: 2,
  trial: 3,
  customer: 4,
};

const LEAD_INCLUDE = {
  assignedTo: { select: { fullName: true } },
  tenant: { select: { id: true, name: true, slug: true } },
  followups: {
    where: { status: 'pending' },
    orderBy: { dueDate: 'asc' },
    take: 1,
    select: { id: true, title: true, dueDate: true },
  },
  activities: { orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
} satisfies Prisma.PlatformLeadInclude;
type LeadRow = Prisma.PlatformLeadGetPayload<{ include: typeof LEAD_INCLUDE }>;

const FOLLOWUP_INCLUDE = {
  assignedTo: { select: { fullName: true } },
  lead: { select: { companyName: true, contactName: true, email: true } },
} satisfies Prisma.PlatformLeadFollowupInclude;
type FollowupRow = Prisma.PlatformLeadFollowupGetPayload<{ include: typeof FOLLOWUP_INCLUDE }>;

export interface LeadActor {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const madridToday = (now = new Date()) => isoDate(todayInTimezone('Europe/Madrid', now));
const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

export function toLeadFollowupDto(r: FollowupRow): PlatformLeadFollowupDto {
  return {
    id: r.id,
    leadId: r.leadId,
    leadName: platformLeadName(r.lead),
    title: r.title,
    note: r.note,
    dueDate: isoDate(r.dueDate),
    status: r.status === 'done' ? 'done' : 'pending',
    completedAt: r.completedAt?.toISOString() ?? null,
    assignedToId: r.assignedToId,
    assignedToName: r.assignedTo?.fullName ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Leads del panel admin: quien se interesa por TrasterOS. Entran por el
 * formulario de la web, al registrarse o a mano; el equipo los trabaja
 * (conversación, actividad, seguimientos, propuesta) y pasan a «En prueba» al
 * tener cuenta y a «Cliente» con el primer pago.
 */
@Injectable()
export class PlatformLeadsService {
  private readonly logger = new Logger(PlatformLeadsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly platform: PlatformService,
    private readonly tools: AdminTenantToolsService,
    private readonly quotes: AdminQuoteService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ------------------------------------------------------------- lectura

  private listWhere(q: PlatformLeadsQuery, superAdminId: string): Prisma.PlatformLeadWhereInput {
    const where: Prisma.PlatformLeadWhereInput = { discardedAt: null };
    if (q.source) where.source = q.source;
    if (q.assignedTo === 'me') where.assignedToId = superAdminId;
    else if (q.assignedTo === 'none') where.assignedToId = null;
    else if (q.assignedTo && /^[0-9a-f-]{36}$/i.test(q.assignedTo)) {
      where.assignedToId = q.assignedTo;
    }
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
    return where;
  }

  async board(q: PlatformLeadsQuery, superAdminId: string): Promise<PlatformLeadBoardDto> {
    const where = this.listWhere(q, superAdminId);
    const [open, customers, lost, groups] = await Promise.all([
      this.admin.platformLead.findMany({
        where: { ...where, status: { in: ['new', 'contacted', 'interested', 'trial'] } },
        include: LEAD_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 500,
      }),
      this.admin.platformLead.findMany({
        where: { ...where, status: 'customer' },
        include: LEAD_INCLUDE,
        orderBy: [{ customerAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
      this.admin.platformLead.findMany({
        where: { ...where, status: 'lost' },
        include: LEAD_INCLUDE,
        orderBy: [{ lostAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
      this.admin.platformLead.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    const counts = {
      new: 0,
      contacted: 0,
      interested: 0,
      trial: 0,
      customer: 0,
      lost: 0,
    } as Record<PlatformLeadStage, number>;
    for (const g of groups) {
      if (g.status in counts) counts[g.status as PlatformLeadStage] = g._count._all;
    }
    return { items: await this.toDtos([...open, ...customers, ...lost]), counts };
  }

  async detail(id: string): Promise<PlatformLeadDetailDto> {
    const row = await this.admin.platformLead.findUnique({ where: { id }, include: LEAD_INCLUDE });
    if (!row || row.discardedAt) throw this.notFound();
    const [[dto], activities, followups, offers] = await Promise.all([
      this.toDtos([row]),
      this.admin.platformLeadActivity.findMany({
        where: { leadId: id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 300,
        include: { superAdmin: { select: { fullName: true } } },
      }),
      this.admin.platformLeadFollowup.findMany({
        where: { leadId: id },
        orderBy: [{ status: 'desc' }, { dueDate: 'asc' }],
        include: FOLLOWUP_INCLUDE,
      }),
      this.quotes.listOffers({ leadId: id, tenantId: row.tenantId }),
    ]);
    return {
      ...dto!,
      activities: activities.map(
        (a): PlatformLeadActivityDto => ({
          id: a.id,
          type: a.type as PlatformLeadActivityType,
          subject: a.subject,
          content: a.content,
          occurredAt: a.occurredAt.toISOString(),
          superAdminName: a.superAdmin?.fullName ?? null,
        }),
      ),
      followups: followups.map(toLeadFollowupDto),
      quoteOffers: offers.items,
    };
  }

  private async toDtos(rows: LeadRow[]): Promise<PlatformLeadDto[]> {
    if (rows.length === 0) return [];
    const slugs = [...new Set(rows.map((r) => r.planSlug).filter((s): s is string => !!s))];
    const emails = [
      ...new Set(rows.filter((r) => !r.tenantId && r.email).map((r) => r.email!.toLowerCase())),
    ];
    const [plans, owners] = await Promise.all([
      slugs.length
        ? this.admin.subscriptionPlan.findMany({
            where: { slug: { in: slugs } },
            select: { slug: true, name: true },
          })
        : [],
      emails.length
        ? this.admin.user.findMany({
            where: {
              email: { in: emails },
              role: 'owner',
              tenant: { deletedAt: null },
            },
            select: { email: true, tenant: { select: { id: true, name: true, slug: true } } },
          })
        : [],
    ]);
    const planName = new Map(plans.map((p) => [p.slug, p.name]));
    const ownerOf = new Map<string, PlatformLeadTenantRefDto>();
    for (const o of owners) {
      if (!ownerOf.has(o.email.toLowerCase())) ownerOf.set(o.email.toLowerCase(), o.tenant);
    }
    return rows.map((r) => ({
      id: r.id,
      status: r.status as PlatformLeadStage,
      source: r.source as PlatformLeadSource,
      displayName: platformLeadName(r),
      companyName: r.companyName,
      contactName: r.contactName,
      email: r.email,
      phone: r.phone,
      units: r.units,
      facilities: r.facilities,
      profile: r.profile,
      currentSoftware: r.currentSoftware,
      city: r.city,
      planSlug: r.planSlug,
      planName: r.planSlug ? (planName.get(r.planSlug) ?? null) : null,
      message: r.message,
      assignedToId: r.assignedToId,
      assignedToName: r.assignedTo?.fullName ?? null,
      tenant: r.tenant ?? null,
      existingTenant: !r.tenantId && r.email ? (ownerOf.get(r.email.toLowerCase()) ?? null) : null,
      utmSource: r.utmSource,
      utmMedium: r.utmMedium,
      utmCampaign: r.utmCampaign,
      contactedAt: r.contactedAt?.toISOString() ?? null,
      interestedAt: r.interestedAt?.toISOString() ?? null,
      trialAt: r.trialAt?.toISOString() ?? null,
      customerAt: r.customerAt?.toISOString() ?? null,
      lostAt: r.lostAt?.toISOString() ?? null,
      lostReasonCode: (r.lostReasonCode as PlatformLeadLostReason | null) ?? null,
      lostReason: r.lostReason,
      firstResponseAt: r.firstResponseAt?.toISOString() ?? null,
      lastActivityAt: r.activities[0]?.occurredAt.toISOString() ?? null,
      nextFollowup: r.followups[0]
        ? {
            id: r.followups[0].id,
            title: r.followups[0].title,
            dueDate: isoDate(r.followups[0].dueDate),
          }
        : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  private notFound() {
    return new NotFoundException({ code: 'lead_not_found', message: 'Lead no encontrado' });
  }

  private async leadOrThrow(id: string) {
    const row = await this.admin.platformLead.findUnique({ where: { id } });
    if (!row || row.discardedAt) throw this.notFound();
    return row;
  }

  private async assertAssignee(id: string | null | undefined): Promise<void> {
    if (!id) return;
    const found = await this.admin.superAdmin.findFirst({
      where: { id, isActive: true },
      select: { id: true },
    });
    if (!found) {
      throw new BadRequestException({
        code: 'invalid_assignee',
        message: 'Ese administrador no existe o está desactivado',
      });
    }
  }

  /** Otro lead (no descartado) con el mismo email o teléfono. */
  private async findDuplicate(
    email: string | null,
    phone: string | null,
    exceptId?: string,
  ): Promise<{ id: string; companyName: string | null; contactName: string | null } | null> {
    if (email) {
      const byEmail = await this.admin.platformLead.findFirst({
        where: {
          discardedAt: null,
          email: { equals: email, mode: 'insensitive' },
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, companyName: true, contactName: true },
      });
      if (byEmail) return byEmail;
    }
    const tail = digits(phone).slice(-9);
    if (tail.length === 9) {
      const rows = await this.admin.$queryRaw<
        { id: string; company_name: string | null; contact_name: string | null }[]
      >`
        SELECT id, company_name, contact_name FROM platform_leads
        WHERE discarded_at IS NULL AND phone IS NOT NULL
          AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ${tail}
          ${exceptId ? Prisma.sql`AND id <> ${exceptId}::uuid` : Prisma.empty}
        ORDER BY created_at DESC LIMIT 1`;
      const r = rows[0];
      if (r) return { id: r.id, companyName: r.company_name, contactName: r.contact_name };
    }
    return null;
  }

  // ------------------------------------------------------------ escritura

  async create(input: CreatePlatformLeadInput, actor: LeadActor): Promise<PlatformLeadDetailDto> {
    const email = clean(input.email)?.toLowerCase() ?? null;
    const phone = clean(input.phone);
    const dup = await this.findDuplicate(email, phone);
    if (dup) {
      throw new ConflictException({
        code: 'lead_exists',
        message: `Ya hay un lead con ese email o teléfono: ${platformLeadName(dup)}`,
        details: { leadId: dup.id },
      });
    }
    const assignedToId = input.assignedToId === undefined ? actor.superAdminId : input.assignedToId;
    await this.assertAssignee(assignedToId);
    const lead = await this.admin.platformLead.create({
      data: {
        status: 'new',
        source: input.source,
        companyName: clean(input.companyName),
        contactName: clean(input.contactName),
        email,
        phone,
        units: clean(input.units),
        facilities: clean(input.facilities),
        profile: clean(input.profile),
        currentSoftware: clean(input.currentSoftware),
        city: clean(input.city),
        planSlug: clean(input.planSlug),
        message: clean(input.message),
        assignedToId: assignedToId ?? null,
        createdById: actor.superAdminId,
      },
    });
    if (clean(input.message)) {
      await this.addActivity(lead.id, 'note', clean(input.message)!, actor.superAdminId);
    }
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.platform_lead.created',
      targetType: 'platform_lead',
      targetId: lead.id,
      changes: { source: input.source },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return this.detail(lead.id);
  }

  async update(id: string, input: UpdatePlatformLeadInput): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    const email =
      input.email !== undefined ? (clean(input.email)?.toLowerCase() ?? null) : lead.email;
    const phone = input.phone !== undefined ? clean(input.phone) : lead.phone;
    if (!email && !phone) {
      throw new BadRequestException({
        code: 'contact_required',
        message: 'Deja al menos un email o un teléfono',
      });
    }
    if (input.assignedToId !== undefined) await this.assertAssignee(input.assignedToId);
    const data: Prisma.PlatformLeadUncheckedUpdateInput = {};
    for (const key of [
      'companyName',
      'contactName',
      'units',
      'facilities',
      'profile',
      'currentSoftware',
      'city',
      'planSlug',
    ] as const) {
      if (input[key] !== undefined) data[key] = clean(input[key]);
    }
    if (input.email !== undefined) data.email = email;
    if (input.phone !== undefined) data.phone = phone;
    if (input.source) data.source = input.source;
    if (input.assignedToId !== undefined) data.assignedToId = input.assignedToId;
    await this.admin.platformLead.update({ where: { id }, data });
    return this.detail(id);
  }

  /** Mover a mano entre Nuevo, Contactado e Interesado (también reabre un perdido). */
  async move(
    id: string,
    input: MovePlatformLeadInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.status === 'trial' || lead.status === 'customer') {
      throw new BadRequestException({
        code: 'stage_automatic',
        message: 'Este lead ya tiene cuenta: su fase la marca su cuenta (prueba o pago)',
      });
    }
    if (lead.status === input.status) return this.detail(id);
    const now = new Date();
    await this.admin.platformLead.update({
      where: { id },
      data: {
        status: input.status,
        ...(input.status !== 'new'
          ? { contactedAt: lead.contactedAt ?? now, firstResponseAt: lead.firstResponseAt ?? now }
          : {}),
        ...(input.status === 'interested' ? { interestedAt: lead.interestedAt ?? now } : {}),
        ...(lead.status === 'lost' ? { lostAt: null, lostReasonCode: null, lostReason: null } : {}),
      },
    });
    await this.addActivity(
      id,
      'system',
      `${lead.status === 'lost' ? 'Reabierto' : 'Pasa'} a ${PLATFORM_LEAD_STAGE_LABELS[input.status]}`,
      actor.superAdminId,
    );
    return this.detail(id);
  }

  async lose(
    id: string,
    input: LosePlatformLeadInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.status === 'customer') {
      throw new BadRequestException({
        code: 'lead_is_customer',
        message: 'Ya es cliente: si se da de baja, se gestiona desde su ficha de tenant',
      });
    }
    await this.admin.platformLead.update({
      where: { id },
      data: {
        status: 'lost',
        lostAt: new Date(),
        lostReasonCode: input.reasonCode,
        lostReason: clean(input.reason),
      },
    });
    await this.addActivity(
      id,
      'system',
      `Perdido: ${PLATFORM_LEAD_LOST_REASON_LABELS[input.reasonCode]}${clean(input.reason) ? ` — ${clean(input.reason)}` : ''}`,
      actor.superAdminId,
    );
    if (clean(input.recontactOn)) {
      await this.admin.platformLeadFollowup.create({
        data: {
          leadId: id,
          superAdminId: actor.superAdminId,
          assignedToId: lead.assignedToId ?? actor.superAdminId,
          title: 'Volver a contactar',
          note: clean(input.reason),
          dueDate: new Date(`${input.recontactOn}T00:00:00Z`),
        },
      });
    }
    return this.detail(id);
  }

  /** Reabre un perdido: si tiene cuenta, su fase la marca la cuenta; si no, «Contactado». */
  async reopen(id: string, actor: LeadActor): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.status !== 'lost') return this.detail(id);
    if (lead.tenantId) {
      await this.admin.platformLead.update({
        where: { id },
        data: { status: 'trial', lostAt: null, lostReasonCode: null, lostReason: null },
      });
      await this.addActivity(id, 'system', 'Reabierto', actor.superAdminId);
      await this.syncFromTenants();
      return this.detail(id);
    }
    return this.move(id, { status: 'contacted' }, actor);
  }

  /** «No es un lead»: sale del tablero y de las cifras (spam, soporte, proveedores…). */
  async discard(id: string, actor: LeadActor): Promise<void> {
    await this.leadOrThrow(id);
    await this.admin.platformLead.update({ where: { id }, data: { discardedAt: new Date() } });
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.platform_lead.discarded',
      targetType: 'platform_lead',
      targetId: id,
    });
  }

  async remove(id: string, actor: LeadActor): Promise<void> {
    const lead = await this.admin.platformLead.findUnique({ where: { id }, select: { id: true } });
    if (!lead) throw this.notFound();
    await this.admin.$transaction([
      // Sus propuestas que aún no son de ningún tenant se van con él.
      this.admin.platformQuoteOffer.deleteMany({ where: { leadId: id, tenantId: null } }),
      this.admin.platformLead.delete({ where: { id } }),
    ]);
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.platform_lead.deleted',
      targetType: 'platform_lead',
      targetId: id,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  // ---------------------------------------------------------- actividad

  private async addActivity(
    leadId: string,
    type: PlatformLeadActivityType,
    content: string,
    superAdminId: string | null,
    extra: { subject?: string | null; occurredAt?: Date } = {},
  ): Promise<void> {
    await this.admin.platformLeadActivity.create({
      data: {
        leadId,
        type,
        content,
        superAdminId,
        subject: extra.subject ?? null,
        ...(extra.occurredAt ? { occurredAt: extra.occurredAt } : {}),
      },
    });
  }

  /** Marca que ya se le ha respondido (y saca de «Nuevo»). */
  private async markResponded(leadId: string, now = new Date()): Promise<void> {
    await this.admin.platformLead.updateMany({
      where: { id: leadId, firstResponseAt: null },
      data: { firstResponseAt: now },
    });
    await this.admin.platformLead.updateMany({
      where: { id: leadId, status: 'new' },
      data: { status: 'contacted', contactedAt: now },
    });
  }

  async createActivity(
    id: string,
    input: CreatePlatformLeadActivityInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    await this.leadOrThrow(id);
    await this.addActivity(id, input.type, input.content, actor.superAdminId, {
      ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
    });
    if (CONTACT_ACTIVITY_TYPES.has(input.type)) await this.markResponded(id);
    return this.detail(id);
  }

  async deleteActivity(id: string, activityId: string): Promise<PlatformLeadDetailDto> {
    const activity = await this.admin.platformLeadActivity.findFirst({
      where: { id: activityId, leadId: id },
      select: { type: true },
    });
    if (!activity) {
      throw new NotFoundException({
        code: 'activity_not_found',
        message: 'Actividad no encontrada',
      });
    }
    if (!MANUAL_ACTIVITY_TYPES.has(activity.type)) {
      throw new BadRequestException({
        code: 'activity_locked',
        message: 'Los correos, mensajes y avisos automáticos no se borran',
      });
    }
    await this.admin.platformLeadActivity.delete({ where: { id: activityId } });
    return this.detail(id);
  }

  // -------------------------------------------------------- seguimientos

  async createFollowup(
    id: string,
    input: CreatePlatformLeadFollowupInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    const assignedToId =
      input.assignedToId === undefined
        ? (lead.assignedToId ?? actor.superAdminId)
        : input.assignedToId;
    await this.assertAssignee(assignedToId);
    await this.admin.platformLeadFollowup.create({
      data: {
        leadId: id,
        superAdminId: actor.superAdminId,
        assignedToId: assignedToId ?? null,
        title: input.title,
        note: clean(input.note),
        dueDate: new Date(`${input.dueDate}T00:00:00Z`),
      },
    });
    return this.detail(id);
  }

  /** Pendientes de todos los leads, por fecha (`mine`: los de ese super admin). */
  async pendingFollowups(mine: string | null = null): Promise<PlatformLeadFollowupDto[]> {
    const rows = await this.admin.platformLeadFollowup.findMany({
      where: {
        status: 'pending',
        lead: { discardedAt: null },
        ...(mine ? { assignedToId: mine } : {}),
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      take: 300,
      include: FOLLOWUP_INCLUDE,
    });
    return rows.map(toLeadFollowupDto);
  }

  /** Los de hoy o atrasados (para «Hoy»). */
  async followupsDue(now = new Date()): Promise<PlatformLeadFollowupDto[]> {
    const today = madridToday(now);
    return (await this.pendingFollowups()).filter((f) => f.dueDate <= today);
  }

  async updateFollowup(
    followupId: string,
    input: UpdatePlatformLeadFollowupInput,
  ): Promise<PlatformLeadFollowupDto> {
    const row = await this.admin.platformLeadFollowup.findUnique({ where: { id: followupId } });
    if (!row) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    if (input.assignedToId !== undefined) await this.assertAssignee(input.assignedToId);
    const updated = await this.admin.platformLeadFollowup.update({
      where: { id: followupId },
      data: {
        ...(input.status
          ? { status: input.status, completedAt: input.status === 'done' ? new Date() : null }
          : {}),
        ...(input.dueDate ? { dueDate: new Date(`${input.dueDate}T00:00:00Z`) } : {}),
        ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
      },
      include: FOLLOWUP_INCLUDE,
    });
    return toLeadFollowupDto(updated);
  }

  async deleteFollowup(followupId: string): Promise<void> {
    const { count } = await this.admin.platformLeadFollowup.deleteMany({
      where: { id: followupId },
    });
    if (count === 0) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
  }

  // --------------------------------------------------------------- correo

  async sendEmail(
    id: string,
    input: SendPlatformLeadEmailInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (!lead.email) {
      throw new BadRequestException({
        code: 'lead_without_email',
        message: 'Este lead no tiene email',
      });
    }
    await this.deliver(lead.email, lead.contactName, input.subject, input.body);
    await this.addActivity(id, 'email_out', input.body, actor.superAdminId, {
      subject: input.subject,
    });
    await this.markResponded(id);
    return this.detail(id);
  }

  private async deliver(
    to: string,
    name: string | null,
    subject: string,
    markdown: string,
  ): Promise<void> {
    const website = await this.admin.platformWebsite.findFirst({ select: { contactEmail: true } });
    const mail = renderAdminEmail(markdown);
    const result = await this.email.sendRendered({
      to,
      subject,
      html: mail.html,
      text: mail.text,
      ...(website?.contactEmail ? { replyTo: { email: website.contactEmail } } : {}),
      kind: 'web_contact',
      tags: { type: 'platform_lead' },
    });
    if (result.suppressed) {
      throw new BadRequestException({
        code: 'email_suppressed',
        message: `${name ?? to} tiene la dirección bloqueada (rebotes o quejas): no se le puede escribir`,
      });
    }
  }

  // -------------------------------------------------------------- cuenta

  /** Une el lead a un tenant que ya existe (se registró por su cuenta). */
  async link(id: string, tenantId: string, actor: LeadActor): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.tenantId && lead.tenantId !== tenantId) {
      throw new ConflictException({
        code: 'lead_already_linked',
        message: 'Este lead ya tiene una cuenta vinculada',
      });
    }
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true, platformLead: { select: { id: true } } },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    if (tenant.platformLead && tenant.platformLead.id !== id) {
      throw new ConflictException({
        code: 'tenant_already_linked',
        message: 'Ese tenant ya es de otro lead',
        details: { leadId: tenant.platformLead.id },
      });
    }
    await this.applyLink(id, tenantId, actor.superAdminId, 'manual');
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.platform_lead.linked',
      targetType: 'platform_lead',
      targetId: id,
      targetTenantId: tenantId,
    });
    return this.detail(id);
  }

  /**
   * Vincula y pone la fase según la cuenta (cliente si ya ha pagado, en prueba
   * si no), pasa al tenant sus propuestas y deja en la ficha del tenant el
   * enlace al historial del lead.
   */
  private async applyLink(
    leadId: string,
    tenantId: string,
    superAdminId: string | null,
    how: 'manual' | 'signup' | 'admin',
  ): Promise<void> {
    const [lead, tenant, paid] = await Promise.all([
      this.admin.platformLead.findUniqueOrThrow({ where: { id: leadId } }),
      this.admin.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, slug: true },
      }),
      this.firstPaidAt([tenantId]),
    ]);
    const now = new Date();
    const paidAt = paid.get(tenantId) ?? null;
    await this.admin.platformLead.update({
      where: { id: leadId },
      data: {
        tenantId,
        status: paidAt ? 'customer' : 'trial',
        trialAt: lead.trialAt ?? now,
        ...(paidAt ? { customerAt: lead.customerAt ?? paidAt } : {}),
        lostAt: null,
        lostReasonCode: null,
        lostReason: null,
      },
    });
    await this.admin.platformQuoteOffer.updateMany({
      where: { leadId, tenantId: null },
      data: { tenantId },
    });
    const text =
      how === 'signup'
        ? `Se ha registrado: cuenta «${tenant.name}» (${tenant.slug})`
        : how === 'admin'
          ? `Cuenta creada desde el panel: «${tenant.name}» (${tenant.slug})`
          : `Vinculado a la cuenta «${tenant.name}» (${tenant.slug})`;
    await this.addActivity(leadId, how === 'manual' ? 'system' : 'signup', text, superAdminId);
    const source = PLATFORM_LEAD_SOURCE_LABELS[lead.source as PlatformLeadSource] ?? lead.source;
    await this.interactions
      .create({
        tenantId,
        superAdminId,
        input: {
          type: 'note',
          content: `Viene del lead «${platformLeadName(lead)}» (origen: ${source}). Lo hablado antes de tener cuenta está en su ficha de lead.`,
        },
        link: `/admin/leads?lead=${leadId}`,
      })
      .catch((err: unknown) =>
        this.logger.warn(`Nota del lead en el tenant ${tenantId}: ${String(err)}`),
      );
  }

  /** Crea su cuenta (el alta de tenant de siempre) y la vincula al lead. */
  async createTenant(
    id: string,
    input: AdminCreateTenantInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.tenantId) {
      throw new ConflictException({
        code: 'lead_already_linked',
        message: 'Este lead ya tiene una cuenta vinculada',
      });
    }
    const created = await this.tools.createTenant(
      input,
      {
        superAdminId: actor.superAdminId,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
      { leadId: id },
    );
    // Por si el aviso del alta no llegó a vincularlo.
    const after = await this.admin.platformLead.findUnique({
      where: { id },
      select: { tenantId: true },
    });
    if (!after?.tenantId) await this.applyLink(id, created.tenantId, actor.superAdminId, 'admin');
    if (input.planSlug && !lead.planSlug) {
      await this.admin.platformLead.update({ where: { id }, data: { planSlug: input.planSlug } });
    }
    return this.detail(id);
  }

  // ----------------------------------------------------------- propuesta

  async sendQuote(
    id: string,
    input: SendAdminQuoteInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    const meta = {
      superAdminId: actor.superAdminId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    };
    let summary: string;
    let planSlug: string | null = null;
    if (lead.tenantId) {
      // Ya tiene cuenta: la propuesta de siempre, a sus propietarios.
      const res = await this.quotes.send(lead.tenantId, input, meta);
      summary = quoteSummary(res.quote);
    } else {
      if (!lead.email) {
        throw new BadRequestException({
          code: 'lead_without_email',
          message: 'Este lead no tiene email',
        });
      }
      const { quote, registerUrl } = await this.quotes.createLeadOffer(
        { id, email: lead.email, companyName: lead.companyName, contactName: lead.contactName },
        input,
        actor.superAdminId,
      );
      summary = quoteSummary(quote);
      const money = (n: number) =>
        n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
      const period = quote.cycle === 'yearly' ? 'al año' : 'al mes';
      const hello = lead.contactName?.trim().split(/\s+/)[0];
      const body = [
        `Hola${hello ? ` ${hello}` : ''}:`,
        '',
        ...(input.message ? [input.message, ''] : []),
        `Esta es la propuesta de TrasterOS${lead.companyName ? ` para ${lead.companyName}` : ''}:`,
        '',
        ...quote.lines.map((l) => `- ${l.label}: ${money(l.amount)}`),
        ...(quote.discount > 0
          ? [`- Descuento (${quote.couponCode}): -${money(quote.discount)}`]
          : []),
        '',
        `Base: ${money(quote.base)} · IVA (${quote.taxRate} %): ${money(quote.vat)}`,
        `**Total: ${money(quote.total)} ${period}**${quote.cycle === 'yearly' ? ` (${money(quote.monthlyEquivalent)} al mes)` : ''}`,
        '',
        'Para empezar, crea tu cuenta (tienes la prueba gratis) y, cuando quieras contratar, la propuesta te estará esperando en «Suscripción».',
        '',
        `[[boton: Crear mi cuenta | ${registerUrl}]]`,
        '',
        'Si tienes dudas, responde a este correo.',
        '',
        'El equipo de TrasterOS',
      ].join('\n');
      await this.deliver(
        lead.email,
        lead.contactName,
        `Tu propuesta de TrasterOS: ${money(quote.total)} ${period}`,
        body,
      );
      if (input.followupDays > 0) {
        await this.admin.platformLeadFollowup.create({
          data: {
            leadId: id,
            superAdminId: actor.superAdminId,
            assignedToId: lead.assignedToId ?? actor.superAdminId,
            title: 'Llamar por la propuesta',
            dueDate: new Date(
              `${isoDate(new Date(Date.now() + input.followupDays * DAY))}T00:00:00Z`,
            ),
          },
        });
      }
    }
    const plan = await this.admin.subscriptionPlan.findUnique({
      where: { id: input.planId },
      select: { slug: true },
    });
    planSlug = plan?.slug ?? null;
    await this.addActivity(
      id,
      'quote',
      `${summary}${input.message ? `\n\n${input.message}` : ''}`,
      actor.superAdminId,
    );
    const now = new Date();
    await this.admin.platformLead.updateMany({
      where: { id, status: { in: ['new', 'contacted'] } },
      data: {
        status: 'interested',
        interestedAt: now,
        contactedAt: lead.contactedAt ?? now,
      },
    });
    await this.admin.platformLead.update({
      where: { id },
      data: { firstResponseAt: lead.firstResponseAt ?? now, ...(planSlug ? { planSlug } : {}) },
    });
    return this.detail(id);
  }

  // ------------------------------------------------- entradas automáticas

  /** Un mensaje del formulario de la web: lead nuevo, o se suma al que ya hay. */
  async ingestContact(e: PlatformLeadInboundEvent): Promise<string> {
    const email = e.email.trim().toLowerCase();
    const existing = await this.findDuplicate(email, e.phone);
    const now = new Date();
    if (existing) {
      const lead = await this.admin.platformLead.findUniqueOrThrow({ where: { id: existing.id } });
      await this.admin.platformLead.update({
        where: { id: lead.id },
        data: {
          companyName: lead.companyName ?? clean(e.company),
          contactName: lead.contactName ?? clean(e.name),
          email: lead.email ?? email,
          phone: lead.phone ?? clean(e.phone),
          units: lead.units ?? clean(e.units),
          profile: lead.profile ?? clean(e.profile),
          // Un perdido que vuelve a escribir se atiende de nuevo.
          ...(lead.status === 'lost' && !lead.tenantId
            ? {
                status: 'new',
                lostAt: null,
                lostReasonCode: null,
                lostReason: null,
                unattendedNotifiedAt: null,
              }
            : {}),
        },
      });
      await this.addActivity(lead.id, 'web_form', e.message, null, { occurredAt: now });
      return lead.id;
    }
    const lead = await this.admin.platformLead.create({
      data: {
        status: 'new',
        source: e.source,
        companyName: clean(e.company),
        contactName: clean(e.name),
        email,
        phone: clean(e.phone),
        units: clean(e.units),
        profile: clean(e.profile),
        message: e.message,
        utmSource: clean(e.utmSource),
        utmMedium: clean(e.utmMedium),
        utmCampaign: clean(e.utmCampaign),
      },
    });
    await this.addActivity(lead.id, 'web_form', e.message, null, { occurredAt: now });
    return lead.id;
  }

  /**
   * Se ha creado la cuenta de un tenant: si venía de un lead (el de la ficha o
   * uno abierto con su email) se vincula; si no, entra como lead nuevo en
   * «En prueba».
   */
  async ingestTenant(e: PlatformTenantRegisteredEvent): Promise<void> {
    const already = await this.admin.platformLead.findUnique({ where: { tenantId: e.tenantId } });
    if (already) return;
    const email = e.email.trim().toLowerCase();
    let lead = e.leadId
      ? await this.admin.platformLead.findFirst({
          where: { id: e.leadId, tenantId: null, discardedAt: null },
        })
      : null;
    if (!lead) {
      lead = await this.admin.platformLead.findFirst({
        where: {
          tenantId: null,
          discardedAt: null,
          email: { equals: email, mode: 'insensitive' },
        },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (lead) {
      await this.applyLink(
        lead.id,
        e.tenantId,
        e.superAdminId,
        e.source === 'admin' ? 'admin' : 'signup',
      );
      if (!lead.utmSource && (e.utmSource || e.utmCampaign)) {
        await this.admin.platformLead.update({
          where: { id: lead.id },
          data: {
            utmSource: clean(e.utmSource),
            utmMedium: clean(e.utmMedium),
            utmCampaign: clean(e.utmCampaign),
          },
        });
      }
      if (e.source === 'signup') {
        await this.platform.notify({
          type: 'platform_lead.signed_up',
          title: `${platformLeadName(lead)} se ha registrado`,
          body: `Ha creado la cuenta «${e.tenantName}». Ya está en prueba.`,
          link: `/admin/leads?lead=${lead.id}`,
        });
      }
      return;
    }
    const now = new Date();
    const created = await this.admin.platformLead.create({
      data: {
        status: 'trial',
        source: e.source === 'admin' ? 'admin' : 'signup',
        companyName: clean(e.tenantName),
        contactName: clean(e.fullName),
        email,
        tenantId: e.tenantId,
        trialAt: now,
        assignedToId: e.superAdminId,
        createdById: e.superAdminId,
        utmSource: clean(e.utmSource),
        utmMedium: clean(e.utmMedium),
        utmCampaign: clean(e.utmCampaign),
      },
    });
    await this.addActivity(
      created.id,
      'signup',
      e.source === 'admin'
        ? `Cuenta creada desde el panel: «${e.tenantName}»`
        : `Se ha registrado en la web: «${e.tenantName}»`,
      e.superAdminId,
    );
  }

  // ------------------------------------------------ fases automáticas

  private async firstPaidAt(tenantIds: string[]): Promise<Map<string, Date>> {
    if (tenantIds.length === 0) return new Map();
    const rows = await this.admin.tenantSubscriptionPayment.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: 'paid', amount: { gt: 0 } },
      _min: { paidAt: true, createdAt: true },
    });
    return new Map(
      rows.map((r) => [r.tenantId, r._min.paidAt ?? r._min.createdAt ?? new Date()] as const),
    );
  }

  /**
   * Pasa a «Cliente» a quien ya ha pagado y a «Perdido» (no contrató tras la
   * prueba) a quien acabó la prueba sin pagar, con un seguimiento para volver a
   * llamarle. Idempotente: cada cambio solo se aplica desde la fase anterior.
   */
  async syncFromTenants(now = new Date()): Promise<{ customers: number; lost: number }> {
    const candidates = await this.admin.platformLead.findMany({
      where: {
        discardedAt: null,
        tenantId: { not: null },
        status: { in: ['new', 'contacted', 'interested', 'trial', 'lost'] },
      },
      select: {
        id: true,
        tenantId: true,
        status: true,
        assignedToId: true,
        tenant: {
          select: { trialEndedAt: true, deletedAt: true, status: true, billingExempt: true },
        },
      },
    });
    const paid = await this.firstPaidAt(candidates.map((c) => c.tenantId!));
    let customers = 0;
    let lost = 0;
    for (const c of candidates) {
      const paidAt = paid.get(c.tenantId!);
      if (paidAt) {
        const { count } = await this.admin.platformLead.updateMany({
          where: { id: c.id, status: c.status },
          data: {
            status: 'customer',
            customerAt: paidAt,
            lostAt: null,
            lostReasonCode: null,
            lostReason: null,
          },
        });
        if (count === 1) {
          customers += 1;
          await this.addActivity(c.id, 'system', 'Primer pago: ya es cliente', null);
        }
        continue;
      }
      const t = c.tenant;
      if (c.status !== 'trial' || !t || t.billingExempt) continue;
      const trialOver =
        (t.trialEndedAt && t.trialEndedAt.getTime() < now.getTime() - DAY) ||
        t.deletedAt !== null ||
        t.status === 'cancelled';
      if (!trialOver) continue;
      const { count } = await this.admin.platformLead.updateMany({
        where: { id: c.id, status: 'trial' },
        data: { status: 'lost', lostAt: now, lostReasonCode: 'no_conversion', lostReason: null },
      });
      if (count !== 1) continue;
      lost += 1;
      await this.addActivity(
        c.id,
        'system',
        `Perdido: ${PLATFORM_LEAD_LOST_REASON_LABELS.no_conversion}`,
        null,
      );
      await this.admin.platformLeadFollowup.create({
        data: {
          leadId: c.id,
          assignedToId: c.assignedToId,
          title: 'Volver a contactar: acabó la prueba sin contratar',
          dueDate: new Date(
            `${isoDate(new Date(now.getTime() + PLATFORM_LEAD_TRIAL_RECONTACT_DAYS * DAY))}T00:00:00Z`,
          ),
        },
      });
    }
    return { customers, lost };
  }

  /**
   * Leads nuevos de la última semana que llevan horas sin que nadie les
   * responda: un aviso por lead (panel, móvil y, si está activado, chat).
   */
  async unattended(now = new Date()): Promise<{ id: string; name: string; hours: number }[]> {
    const rows = await this.admin.platformLead.findMany({
      where: {
        discardedAt: null,
        status: 'new',
        firstResponseAt: null,
        unattendedNotifiedAt: null,
        createdAt: {
          lt: new Date(now.getTime() - PLATFORM_LEAD_UNATTENDED_HOURS * HOUR),
          gte: new Date(now.getTime() - 7 * DAY),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const claimed: { id: string; name: string; hours: number }[] = [];
    for (const r of rows) {
      const { count } = await this.admin.platformLead.updateMany({
        where: { id: r.id, unattendedNotifiedAt: null },
        data: { unattendedNotifiedAt: now },
      });
      if (count !== 1) continue;
      const hours = Math.floor((now.getTime() - r.createdAt.getTime()) / HOUR);
      const name = platformLeadName(r);
      claimed.push({ id: r.id, name, hours });
      await this.platform.notify({
        type: 'platform_lead.unattended',
        title: `${name} lleva ${hours} h sin atender`,
        ...(r.message ? { body: r.message.slice(0, 200) } : {}),
        link: `/admin/leads?lead=${r.id}`,
      });
    }
    return claimed;
  }

  // -------------------------------------------------------------- cifras

  async stats(months: number, now = new Date()): Promise<PlatformLeadStatsDto> {
    const m = Math.min(Math.max(Math.round(months) || 6, 1), 24);
    const from = new Date(now);
    from.setUTCMonth(from.getUTCMonth() - m);
    const leads = await this.admin.platformLead.findMany({
      where: { discardedAt: null, createdAt: { gte: from } },
      select: {
        status: true,
        source: true,
        tenantId: true,
        contactedAt: true,
        interestedAt: true,
        trialAt: true,
        customerAt: true,
        lostReasonCode: true,
        firstResponseAt: true,
        createdAt: true,
      },
    });
    const reached = (l: (typeof leads)[number]): number => {
      let r = l.status === 'lost' ? 0 : (STAGE_RANK[l.status] ?? 0);
      if (l.contactedAt) r = Math.max(r, 1);
      if (l.interestedAt) r = Math.max(r, 2);
      if (l.trialAt) r = Math.max(r, 3);
      if (l.customerAt) r = Math.max(r, 4);
      return r;
    };
    const customerTenants = leads
      .filter((l) => l.status === 'customer' && l.tenantId)
      .map((l) => l.tenantId!);
    const mrrOf = await this.mrrByTenant(customerTenants);

    const bySourceMap = new Map<
      string,
      { leads: number; trials: number; customers: number; mrr: number }
    >();
    const reasons = new Map<string, number>();
    const responseHours: number[] = [];
    const daysToCustomer: number[] = [];
    let lostCount = 0;
    const funnel = [0, 0, 0, 0, 0];
    for (const l of leads) {
      const r = reached(l);
      for (let i = 0; i <= r; i += 1) funnel[i]! += 1;
      const s = bySourceMap.get(l.source) ?? { leads: 0, trials: 0, customers: 0, mrr: 0 };
      s.leads += 1;
      if (r >= 3) s.trials += 1;
      if (r >= 4) s.customers += 1;
      if (l.status === 'customer' && l.tenantId) s.mrr += mrrOf.get(l.tenantId) ?? 0;
      bySourceMap.set(l.source, s);
      if (l.status === 'lost') {
        lostCount += 1;
        const code = l.lostReasonCode ?? 'other';
        reasons.set(code, (reasons.get(code) ?? 0) + 1);
      }
      if (l.firstResponseAt && l.source !== 'signup') {
        responseHours.push((l.firstResponseAt.getTime() - l.createdAt.getTime()) / HOUR);
      }
      if (l.customerAt) {
        daysToCustomer.push((l.customerAt.getTime() - l.createdAt.getTime()) / DAY);
      }
    }
    responseHours.sort((a, b) => a - b);
    const median = responseHours.length
      ? responseHours.length % 2
        ? responseHours[(responseHours.length - 1) / 2]!
        : (responseHours[responseHours.length / 2 - 1]! +
            responseHours[responseHours.length / 2]!) /
          2
      : null;
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const bySource = [...bySourceMap.entries()]
      .map(([source, s]) => ({
        source: source as PlatformLeadSource,
        leads: s.leads,
        trials: s.trials,
        customers: s.customers,
        mrr: Math.round(s.mrr * 100) / 100,
        conversionPct: s.leads ? round1((s.customers / s.leads) * 100) : null,
      }))
      .sort((a, b) => b.customers - a.customers || b.leads - a.leads);
    return {
      months: m,
      from: from.toISOString(),
      leads: leads.length,
      funnel: (['new', 'contacted', 'interested', 'trial', 'customer'] as const).map(
        (stage, i) => ({ stage, reached: funnel[i]! }),
      ),
      lost: lostCount,
      bySource,
      lostReasons: [...reasons.entries()]
        .map(([code, count]) => ({ code: code as PlatformLeadLostReason, count }))
        .sort((a, b) => b.count - a.count),
      medianFirstResponseHours: median === null ? null : round1(median),
      avgDaysToCustomer: daysToCustomer.length
        ? round1(daysToCustomer.reduce((a, b) => a + b, 0) / daysToCustomer.length)
        : null,
      mrr: Math.round(bySource.reduce((a, s) => a + s.mrr, 0) * 100) / 100,
    };
  }

  /** Lo que paga al mes cada tenant que paga: plan + extras activos. */
  private async mrrByTenant(tenantIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tenantIds.length === 0) return out;
    const [subs, addons] = await Promise.all([
      this.admin.tenantSubscription.findMany({
        where: {
          tenantId: { in: tenantIds },
          status: 'active',
          tenant: { deletedAt: null, billingExempt: false, status: { not: 'suspended' } },
        },
        select: { tenantId: true, plan: { select: { priceMonthly: true } } },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId: { in: tenantIds }, suspendedAt: null },
        select: { tenantId: true, priceMonthly: true, quantity: true },
      }),
    ]);
    for (const s of subs) out.set(s.tenantId, Number(s.plan.priceMonthly));
    for (const a of addons) {
      if (!out.has(a.tenantId)) continue;
      out.set(a.tenantId, out.get(a.tenantId)! + Number(a.priceMonthly) * a.quantity);
    }
    return out;
  }

  async exportCsv(q: PlatformLeadsQuery, superAdminId: string): Promise<string> {
    const rows = await this.admin.platformLead.findMany({
      where: this.listWhere(q, superAdminId),
      include: LEAD_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const items = await this.toDtos(rows);
    const cell = (v: string | null | undefined) => {
      const t = (v ?? '').replace(/\r?\n/g, ' ');
      return /[";]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const date = (d: string | null) =>
      d ? new Date(d).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' }) : '';
    const header = [
      'Alta',
      'Empresa',
      'Persona',
      'Email',
      'Teléfono',
      'Trasteros',
      'Locales',
      'Perfil',
      'Programa actual',
      'Ciudad',
      'Origen',
      'Campaña',
      'Fase',
      'Responsable',
      'Cuenta',
      'Motivo de pérdida',
      'Plan',
      'Primera respuesta',
      'Cliente desde',
    ];
    const lines = items.map((l) =>
      [
        date(l.createdAt),
        l.companyName,
        l.contactName,
        l.email,
        l.phone,
        l.units,
        l.facilities,
        l.profile,
        l.currentSoftware,
        l.city,
        PLATFORM_LEAD_SOURCE_LABELS[l.source] ?? l.source,
        [l.utmSource, l.utmCampaign].filter(Boolean).join(' / '),
        PLATFORM_LEAD_STAGE_LABELS[l.status],
        l.assignedToName,
        l.tenant ? `${l.tenant.name} (${l.tenant.slug})` : '',
        l.lostReasonCode
          ? `${PLATFORM_LEAD_LOST_REASON_LABELS[l.lostReasonCode]}${l.lostReason ? ` — ${l.lostReason}` : ''}`
          : '',
        l.planName ?? l.planSlug,
        date(l.firstResponseAt),
        date(l.customerAt),
      ]
        .map(cell)
        .join(';'),
    );
    return `${String.fromCharCode(0xfeff)}${[header.join(';'), ...lines].join('\r\n')}`;
  }
}

function quoteSummary(q: {
  lines: { label: string }[];
  total: number;
  cycle: 'monthly' | 'yearly';
}): string {
  return `Propuesta: ${q.lines.map((l) => l.label).join(' + ')} → ${q.total
    .toFixed(2)
    .replace('.', ',')} € ${q.cycle === 'yearly' ? 'al año' : 'al mes'}`;
}
