import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@storageos/database';
import {
  LEAD_SOURCE_SUGGESTIONS,
  LEAD_STATUS_LABELS,
  LEAD_TRANSITIONS,
  leadDisplayName,
  leadScore,
  leadSourceLabel,
  phoneKey,
} from '@storageos/shared';

import { customerScopeWhere } from '../../common/customer-scope';
import { assertFacilityAllowed, type FacilityScope } from '../../common/facility-scope';
import { anonymizeLeadsTx } from '../../common/lead-anonymize';
import { leadReplyAddress } from '../../common/lead-reply-address';
import { leadScopeWhere } from '../../common/lead-scope';
import { applyMarketingOptOutByEmail } from '../../common/marketing/opt-out';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { isReservationOverlap } from '../../common/reservation-overlap';
import { unitHeldByOther } from '../../common/unit-holds';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { RequestMeta } from '../auth/auth.service';
import type { BookingExpiredPayload, DomainEventPayload } from '../automations/domain-events';
import type { Lead, LeadStatus } from '@storageos/database';
import type {
  ConvertLeadInput,
  CreateLeadInput,
  LeadDto,
  LeadLostReason,
  LeadStatusValue,
  TransitionLeadInput,
  UpdateLeadInput,
  WidgetLeadInput,
  CommunicationDto,
  LeadReplyInput,
} from '@storageos/shared';

export interface LeadListFilters {
  status?: LeadStatusValue;
  /** Un usuario, o `null` = sin responsable. */
  assignedToUserId?: string | null;
  source?: string;
  search?: string;
  /** Local que busca (o `none` = sin local). */
  facilityId?: string;
  /** Llegaron entre estas fechas (YYYY-MM-DD, ambas incluidas). */
  from?: string;
  to?: string;
  page?: PageRequest;
  scope?: FacilityScope;
}
type ListFilters = LeadListFilters;

/** Condiciones de la lista (también las usan los totales del tablero). */
export function leadListWhere(filters: LeadListFilters): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [{ deletedAt: null }, leadScopeWhere(filters.scope)];
  if (filters.status) and.push({ status: filters.status as LeadStatus });
  if (filters.assignedToUserId !== undefined) {
    and.push({ assignedToUserId: filters.assignedToUserId });
  }
  if (filters.source) and.push({ source: filters.source });
  if (filters.facilityId) {
    and.push({
      preferredFacilityId: filters.facilityId === 'none' ? null : filters.facilityId,
    });
  }
  if (filters.from) and.push({ createdAt: { gte: new Date(`${filters.from}T00:00:00Z`) } });
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    and.push({ createdAt: { lt: end } });
  }
  // Por palabras: «Ana García» encuentra a Ana con apellido García.
  const words = (filters.search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  for (const w of words) {
    const digits = w.replace(/\D/g, '');
    and.push({
      OR: [
        { firstName: { contains: w, mode: 'insensitive' } },
        { lastName: { contains: w, mode: 'insensitive' } },
        { companyName: { contains: w, mode: 'insensitive' } },
        { email: { contains: w, mode: 'insensitive' } },
        { phone: { contains: w, mode: 'insensitive' } },
        ...(digits.length >= 3 && digits !== w
          ? [{ phone: { contains: digits, mode: 'insensitive' as const } }]
          : []),
      ],
    });
  }
  return { AND: and };
}

const LEAD_INCLUDE = {
  preferredFacility: { select: { name: true } },
  preferredUnitType: { select: { name: true } },
  assignedTo: { select: { fullName: true } },
} satisfies Prisma.LeadInclude;

/** Lo que cuenta como haber atendido al contacto: fecha de la primera respuesta. */
function attendedData(lead: { status: string; contactedAt: Date | null }, at = new Date()) {
  return {
    returnedAt: null,
    // Lo ha tomado una persona: se acaba la secuencia automática de correos.
    nurtureStep: 3,
    ...(lead.contactedAt ? {} : { contactedAt: at }),
    ...(lead.status === 'new' ? { status: 'contacted' as const } : {}),
  };
}

type LeadWithIncludes = Lead & {
  preferredFacility?: { name: string } | null;
  preferredUnitType?: { name: string } | null;
  assignedTo?: { fullName: string } | null;
};

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly communications: CommunicationsService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Comprueba que el local, el tamaño y el responsable son de esta empresa (y
   * el local, de los que ve el usuario). Un id de otra empresa daba 201.
   */
  private async assertRefs(
    tenantId: string,
    refs: {
      preferredFacilityId?: string | null | undefined;
      preferredUnitTypeId?: string | null | undefined;
      assignedToUserId?: string | null | undefined;
    },
    scope: FacilityScope,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      if (refs.preferredFacilityId) {
        const f = await tx.facility.findFirst({
          where: { id: refs.preferredFacilityId, deletedAt: null },
          select: { id: true },
        });
        if (!f) {
          throw new BadRequestException({
            code: 'facility_not_found',
            message: 'El local no existe',
          });
        }
        assertFacilityAllowed(scope, f.id);
      }
      if (refs.preferredUnitTypeId) {
        const t = await tx.unitType.findFirst({
          where: { id: refs.preferredUnitTypeId },
          select: { id: true },
        });
        if (!t) {
          throw new BadRequestException({
            code: 'unit_type_not_found',
            message: 'El tamaño no existe',
          });
        }
      }
      if (refs.assignedToUserId) {
        const u = await tx.user.findFirst({
          where: { id: refs.assignedToUserId, isActive: true },
          select: { id: true },
        });
        if (!u) {
          throw new BadRequestException({
            code: 'user_not_found',
            message: 'Esa persona no está en tu equipo',
          });
        }
      }
    }, tenantId);
  }

  /** Avisa a la persona a la que se le asigna el contacto (no a todo el equipo). */
  private async notifyAssigned(
    tenantId: string,
    lead: { id: string; preferredFacilityId: string | null } & Parameters<
      typeof leadDisplayName
    >[0],
    userId: string,
  ): Promise<void> {
    await this.notifications
      .create(tenantId, {
        type: 'lead.assigned',
        title: `Te han asignado un contacto: ${leadDisplayName(lead)}`,
        link: `/leads?lead=${lead.id}`,
        facilityId: lead.preferredFacilityId,
        userId,
      })
      .catch(() => undefined);
  }

  /**
   * El equipo ha atendido al contacto fuera de la ficha (respondió por WhatsApp
   * o por el chat de la web): cuenta como primera respuesta.
   */
  async markAttended(tenantId: string, leadId: string): Promise<void> {
    await this.prisma
      .withTenant(async (tx) => {
        const lead = await tx.lead.findFirst({
          where: { id: leadId, deletedAt: null },
          select: { status: true, contactedAt: true },
        });
        if (!lead) return;
        await tx.lead.update({ where: { id: leadId }, data: attendedData(lead) });
      }, tenantId)
      .catch((err: unknown) =>
        this.logger.warn(`[leads] markAttended ${leadId}: ${(err as Error).message}`),
      );
  }

  /**
   * Responde al contacto por email desde el panel: sale con el remitente del
   * tenant (las respuestas le llegan a su correo) y queda en Comunicaciones
   * enlazada al lead. Si estaba sin contactar, pasa a «contactado».
   */
  async reply(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: LeadReplyInput;
    meta: RequestMeta;
    scope?: FacilityScope;
  }): Promise<CommunicationDto> {
    const lead = await this.findOrThrow(args.tenantId, args.id, false, args.scope);
    if (!lead.email) {
      throw new BadRequestException({
        code: 'lead_without_email',
        message: 'Este contacto no tiene email',
      });
    }
    const replyTo = await leadReplyAddress(
      this.admin,
      this.config.get<string>('INBOUND_EMAIL_DOMAIN'),
      lead.id,
    );
    const comm = await this.communications.enqueue({
      tenantId: args.tenantId,
      channel: 'email',
      recipient: lead.email,
      subject: args.input.subject,
      bodyText: args.input.body,
      leadId: lead.id,
      source: 'lead.reply',
      ...(replyTo ? { replyTo } : {}),
    });
    await this.prisma.withTenant(
      (tx) => tx.lead.update({ where: { id: lead.id }, data: attendedData(lead) }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.replied',
      entityType: 'Lead',
      entityId: lead.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return comm;
  }

  async list(tenantId: string, filters: ListFilters): Promise<LeadDto[]> {
    const where = leadListWhere(filters);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where,
          include: LEAD_INCLUDE,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          ...(filters.page ? pageArgs(filters.page) : { take: 500 }),
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string, scope?: FacilityScope): Promise<LeadDto> {
    const row = await this.findOrThrow(tenantId, id, true, scope);
    return this.toDto(row);
  }

  /**
   * Orígenes disponibles para el selector de alta: los sugeridos + los que el
   * tenant ya ha usado (para que un origen propio, creado al vuelo, reaparezca).
   */
  async listSources(tenantId: string): Promise<{ value: string; label: string }[]> {
    const used = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where: { deletedAt: null },
          distinct: ['source'],
          select: { source: true },
        }),
      tenantId,
    );
    const suggested = new Set(LEAD_SOURCE_SUGGESTIONS.map((s) => s.value));
    const custom = used
      .map((r) => r.source)
      .filter((s): s is string => !!s && !suggested.has(s))
      .sort()
      .map((value) => ({ value, label: leadSourceLabel(value) }));
    return [...LEAD_SOURCE_SUGGESTIONS, ...custom];
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateLeadInput;
    meta: RequestMeta;
    scope?: FacilityScope;
  }): Promise<LeadDto> {
    await this.assertRefs(args.tenantId, args.input, args.scope);
    const data = this.buildCreateData(args.tenantId, args.input);
    const created = await this.prisma.withTenant(
      (tx) => tx.lead.create({ data, include: LEAD_INCLUDE }),
      args.tenantId,
    );
    if (created.assignedToUserId && created.assignedToUserId !== args.userId) {
      await this.notifyAssigned(args.tenantId, created, created.assignedToUserId);
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.created',
      entityType: 'Lead',
      entityId: created.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    this.emitLeadCreated(args.tenantId, created);
    return this.toDto(created);
  }

  /**
   * Alta publica desde el widget. NO requiere auth (se llama desde el
   * controlador `/public/widget/...`). Aplica honeypot, deja origen
   * `widget`, asigna sin user (UserId = null en audit).
   */
  async createFromWidget(args: {
    tenantId: string;
    input: WidgetLeadInput;
    meta: RequestMeta;
  }): Promise<LeadDto> {
    if (args.input.hp) {
      this.logger.warn(`[widget] honeypot detectado tenant=${args.tenantId}, descartado`);
      throw new ConflictException({ code: 'invalid_payload', message: 'Solicitud invalida' });
    }
    const repeated = await this.mergeRepeatContact(args.tenantId, {
      email: args.input.email,
      phone: args.input.phone,
      message: args.input.message ?? null,
      channel: 'widget',
      marketingConsent: !!args.input.acceptsMarketing,
    });
    if (repeated) return repeated;
    // Del formulario público: un local o tamaño que no es de esta empresa se ignora.
    const [facility, unitType] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          args.input.preferredFacilityId
            ? tx.facility.findFirst({
                where: { id: args.input.preferredFacilityId, deletedAt: null },
                select: { id: true },
              })
            : null,
          args.input.preferredUnitTypeId
            ? tx.unitType.findFirst({
                where: { id: args.input.preferredUnitTypeId },
                select: { id: true },
              })
            : null,
        ]),
      args.tenantId,
    );
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.lead.create({
          data: {
            tenantId: args.tenantId,
            source: 'widget',
            firstName: args.input.firstName,
            lastName: args.input.lastName || null,
            email: args.input.email,
            phone: args.input.phone,
            message: args.input.message || null,
            preferredFacilityId: facility?.id ?? null,
            preferredUnitTypeId: unitType?.id ?? null,
            preferredStartDate: args.input.preferredStartDate
              ? new Date(args.input.preferredStartDate)
              : null,
            estimatedDurationMonths: args.input.estimatedDurationMonths ?? null,
            utmSource: args.input.utmSource ?? null,
            utmMedium: args.input.utmMedium ?? null,
            utmCampaign: args.input.utmCampaign ?? null,
            marketingConsentAt: args.input.acceptsMarketing ? new Date() : null,
            metadata: {
              acceptsMarketing: args.input.acceptsMarketing,
              acceptsTerms: args.input.acceptsTerms,
              userAgent: args.meta.userAgent ?? null,
              ipAddress: args.meta.ipAddress ?? null,
            } satisfies Prisma.InputJsonValue,
          },
          include: LEAD_INCLUDE,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      action: 'lead.widget_received',
      entityType: 'Lead',
      entityId: created.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    this.emitLeadCreated(args.tenantId, created);
    return this.toDto(created);
  }

  /**
   * Lead desde el formulario de contacto de la web pública (Web Premium). Como el
   * widget, pero source `web` y teléfono opcional. El honeypot lo filtra el
   * llamador (LandingService).
   */
  async createFromWebContact(args: {
    tenantId: string;
    input: {
      firstName: string;
      lastName?: string | undefined;
      email: string;
      phone?: string | undefined;
      message?: string | undefined;
      acceptsMarketing?: boolean | undefined;
      utmSource?: string | undefined;
      utmMedium?: string | undefined;
      utmCampaign?: string | undefined;
    };
    meta: RequestMeta;
  }): Promise<LeadDto> {
    const repeated = await this.mergeRepeatContact(args.tenantId, {
      email: args.input.email,
      phone: args.input.phone ?? null,
      message: args.input.message ?? null,
      channel: 'web',
      marketingConsent: !!args.input.acceptsMarketing,
    });
    if (repeated) return repeated;
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.lead.create({
          data: {
            tenantId: args.tenantId,
            source: 'web',
            utmSource: args.input.utmSource || null,
            utmMedium: args.input.utmMedium || null,
            utmCampaign: args.input.utmCampaign || null,
            firstName: args.input.firstName,
            lastName: args.input.lastName || null,
            email: args.input.email,
            phone: args.input.phone || null,
            message: args.input.message || null,
            marketingConsentAt: args.input.acceptsMarketing ? new Date() : null,
            metadata: {
              origin: 'web_contact',
              userAgent: args.meta.userAgent ?? null,
              ipAddress: args.meta.ipAddress ?? null,
            } satisfies Prisma.InputJsonValue,
          },
          include: LEAD_INCLUDE,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      action: 'lead.web_contact_received',
      entityType: 'Lead',
      entityId: created.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    this.emitLeadCreated(args.tenantId, created);
    return this.toDto(created);
  }

  /**
   * Contacto nuevo que escribe al WhatsApp Business del tenant. Lo crea el
   * webhook (sin usuario); avisa igual que un contacto de la web.
   */
  async createFromWhatsapp(args: {
    tenantId: string;
    phone: string;
    name: string | null;
    message: string;
  }): Promise<{ id: string }> {
    const repeated = await this.mergeRepeatContact(args.tenantId, {
      email: null,
      phone: args.phone,
      message: args.message.slice(0, 2000),
      channel: 'whatsapp',
      marketingConsent: false,
    });
    if (repeated) return { id: repeated.id };
    const [firstName, ...rest] = (args.name ?? '').trim().split(/\s+/).filter(Boolean);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.lead.create({
          data: {
            tenantId: args.tenantId,
            source: 'whatsapp',
            firstName: firstName ?? null,
            lastName: rest.length > 0 ? rest.join(' ') : null,
            phone: args.phone,
            message: args.message.slice(0, 2000),
            metadata: { origin: 'whatsapp' } satisfies Prisma.InputJsonValue,
          },
          include: LEAD_INCLUDE,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      action: 'lead.whatsapp_received',
      entityType: 'Lead',
      entityId: created.id,
    });
    this.emitLeadCreated(args.tenantId, created);
    return { id: created.id };
  }

  /**
   * Contacto que deja sus datos en el chat con IA de la web pública. Lo crea
   * el asistente (sin usuario); si ya existe con el mismo email o teléfono,
   * se suma a él.
   */
  /**
   * Formulario de una landing de promoción: crea el contacto (origen `landing`)
   * con el tamaño y el local que pide y la campaña de la landing. Un contacto
   * abierto con el mismo teléfono o email se completa en vez de duplicarse.
   */
  async createFromPromoLanding(args: {
    tenantId: string;
    landingName: string;
    name: string;
    phone: string;
    email: string | null;
    unitTypeId: string | null;
    facilityId: string | null;
    acceptsMarketing: boolean;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string;
    meta: RequestMeta;
  }): Promise<{ id: string }> {
    const message = `Solicitud desde la landing «${args.landingName}».`;
    const repeated = await this.mergeRepeatContact(args.tenantId, {
      email: args.email,
      phone: args.phone,
      message,
      channel: 'landing',
      marketingConsent: args.acceptsMarketing,
    });
    if (repeated) return { id: repeated.id };
    const [firstName, ...rest] = args.name.trim().split(/\s+/).filter(Boolean);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.lead.create({
          data: {
            tenantId: args.tenantId,
            source: 'landing',
            utmSource: args.utmSource,
            utmMedium: args.utmMedium,
            utmCampaign: args.utmCampaign,
            firstName: firstName ?? null,
            lastName: rest.length > 0 ? rest.join(' ') : null,
            email: args.email,
            phone: args.phone,
            message,
            preferredUnitTypeId: args.unitTypeId,
            preferredFacilityId: args.facilityId,
            marketingConsentAt: args.acceptsMarketing ? new Date() : null,
            metadata: {
              origin: 'promo_landing',
              userAgent: args.meta.userAgent ?? null,
              ipAddress: args.meta.ipAddress ?? null,
            } satisfies Prisma.InputJsonValue,
          },
          include: LEAD_INCLUDE,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      action: 'lead.promo_landing_received',
      entityType: 'Lead',
      entityId: created.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    this.emitLeadCreated(args.tenantId, created);
    return { id: created.id };
  }

  async createFromWebChat(args: {
    tenantId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    message: string;
    meta: RequestMeta;
    /** Origen de la visita del que escribe (Instagram, Google Ads…). */
    utm?: { utmSource: string | null; utmMedium: string | null; utmCampaign: string | null } | null;
  }): Promise<{ id: string }> {
    const repeated = await this.mergeRepeatContact(args.tenantId, {
      email: args.email,
      phone: args.phone,
      message: args.message.slice(0, 2000),
      channel: 'web_chat',
      marketingConsent: false,
    });
    if (repeated) return { id: repeated.id };
    const [firstName, ...rest] = (args.name ?? '').trim().split(/\s+/).filter(Boolean);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.lead.create({
          data: {
            tenantId: args.tenantId,
            // El canal es el chat (`source`); el origen, el de su visita.
            source: 'web_chat',
            utmSource: args.utm?.utmSource ?? null,
            utmMedium: args.utm?.utmMedium ?? null,
            utmCampaign: args.utm?.utmCampaign ?? null,
            firstName: firstName ?? null,
            lastName: rest.length > 0 ? rest.join(' ') : null,
            email: args.email,
            phone: args.phone,
            message: args.message.slice(0, 2000),
            metadata: {
              origin: 'web_chat',
              userAgent: args.meta.userAgent ?? null,
              ipAddress: args.meta.ipAddress ?? null,
            } satisfies Prisma.InputJsonValue,
          },
          include: LEAD_INCLUDE,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      action: 'lead.web_chat_received',
      entityType: 'Lead',
      entityId: created.id,
    });
    this.emitLeadCreated(args.tenantId, created);
    return { id: created.id };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateLeadInput;
    meta: RequestMeta;
    scope?: FacilityScope;
  }): Promise<LeadDto> {
    const before = await this.findOrThrow(args.tenantId, args.id, false, args.scope);
    await this.assertRefs(args.tenantId, args.input, args.scope);
    const data: Prisma.LeadUncheckedUpdateInput = {};
    const set = <K extends keyof UpdateLeadInput>(key: K) => {
      const v = args.input[key];
      if (v !== undefined) (data as Record<string, unknown>)[key] = v ?? null;
    };
    set('firstName');
    set('lastName');
    set('companyName');
    set('email');
    set('phone');
    set('message');
    set('preferredFacilityId');
    set('preferredUnitTypeId');
    set('estimatedDurationMonths');
    set('budgetMonthly');
    set('assignedToUserId');
    set('source');
    if (args.input.preferredStartDate !== undefined) {
      data.preferredStartDate = args.input.preferredStartDate
        ? new Date(args.input.preferredStartDate)
        : null;
    }
    if (args.input.metadata !== undefined)
      data.metadata = args.input.metadata as Prisma.InputJsonValue;
    const updated = await this.prisma.withTenant(
      (tx) => tx.lead.update({ where: { id: args.id }, data, include: LEAD_INCLUDE }),
      args.tenantId,
    );
    if (
      updated.assignedToUserId &&
      updated.assignedToUserId !== before.assignedToUserId &&
      updated.assignedToUserId !== args.userId
    ) {
      await this.notifyAssigned(args.tenantId, updated, updated.assignedToUserId);
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.updated',
      entityType: 'Lead',
      entityId: args.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(updated);
  }

  async transition(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: TransitionLeadInput;
    meta: RequestMeta;
    scope?: FacilityScope;
  }): Promise<LeadDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id, false, args.scope);
    // «Ganado» = convertido en cliente: un contacto ganado sin ficha de
    // inquilino contaba como venta en analítica y marketing sin serlo.
    if (args.input.status === 'won') {
      throw new ConflictException({
        code: 'lead_use_convert',
        message: 'Para marcarlo como ganado, conviértelo en cliente.',
      });
    }
    const from = existing.status as LeadStatusValue;
    if (from === args.input.status)
      return this.toDto(await this.findOrThrow(args.tenantId, args.id, true));
    if (!LEAD_TRANSITIONS[from].includes(args.input.status)) {
      throw new ConflictException({
        code: 'invalid_lead_transition',
        message: `No se puede pasar de «${LEAD_STATUS_LABELS[from]}» a «${LEAD_STATUS_LABELS[args.input.status]}»`,
      });
    }
    const now = new Date();
    const data: Prisma.LeadUncheckedUpdateInput = {
      status: args.input.status,
      returnedAt: null,
      // Moverlo de fase es atenderlo: se acaba la secuencia automática.
      nurtureStep: 3,
    };
    // La primera respuesta no se pisa: volver a «Contactado» no la mueve.
    if (
      (args.input.status === 'contacted' || args.input.status === 'qualified') &&
      !existing.contactedAt
    ) {
      data.contactedAt = now;
    }
    if (args.input.status === 'qualified' && !existing.qualifiedAt) data.qualifiedAt = now;
    if (args.input.status === 'lost') {
      data.lostAt = now;
      data.lostReason = args.input.reason || null;
      data.lostReasonCode = args.input.lostReasonCode ?? 'other';
    }
    // Reabierto: deja de contar como perdido (precios e informes).
    if (existing.status === 'lost' && args.input.status !== 'lost') {
      data.lostAt = null;
      data.lostReason = null;
      data.lostReasonCode = null;
    }
    const updated = await this.prisma.withTenant(async (tx) => {
      // Perdido: sus recordatorios pendientes ya no tienen sentido.
      if (args.input.status === 'lost') {
        await tx.leadFollowup.updateMany({
          where: { leadId: args.id, status: 'pending' },
          data: { status: 'cancelled', completedAt: now },
        });
      }
      return tx.lead.update({ where: { id: args.id }, data, include: LEAD_INCLUDE });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: `lead.${args.input.status}`,
      entityType: 'Lead',
      entityId: args.id,
      ...(args.input.reason ? { changes: { reason: args.input.reason } } : {}),
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(updated);
  }

  /**
   * Convierte el lead en customer y, opcionalmente, en reservation.
   * Si `customerId` no se pasa, se crea uno nuevo con los datos del lead.
   * Cierra el lead como `won`. Atomic en `$transaction`.
   */
  async convert(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: ConvertLeadInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<LeadDto> {
    await this.findOrThrow(args.tenantId, args.id, false, args.facilityScope);
    let createdCustomer: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      email: string | null;
      phone: string | null;
    } | null = null;
    const result = await this.prisma.withTenant(async (tx) => {
      // La fila bloqueada: dos clics a la vez no crean dos inquilinos.
      await tx.$queryRaw`SELECT id FROM leads WHERE id = ${args.id}::uuid FOR UPDATE`;
      const existing = await tx.lead.findFirstOrThrow({ where: { id: args.id } });
      if (existing.status === 'won') {
        throw new ConflictException({
          code: 'lead_already_won',
          message: 'Este contacto ya es cliente',
        });
      }
      let customerId = args.input.customerId ?? null;
      if (customerId) {
        const chosen = await tx.customer.findFirst({
          where: {
            id: customerId,
            deletedAt: null,
            ...customerScopeWhere(args.facilityScope ?? null),
          },
          select: { id: true },
        });
        if (!chosen) {
          throw new NotFoundException({
            code: 'customer_not_found',
            message: 'Inquilino no encontrado',
          });
        }
      }
      // Si ya hay un inquilino con ese email, se enlaza a él (como la reserva
      // online, que trata el email como identidad) en vez de duplicarlo.
      if (!customerId && existing.email) {
        const same = await tx.customer.findFirst({
          where: { email: { equals: existing.email, mode: 'insensitive' }, deletedAt: null },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        customerId = same?.id ?? null;
      }
      if (!customerId) {
        const customer = await tx.customer.create({
          data: {
            tenantId: args.tenantId,
            customerType: existing.companyName ? 'business' : 'individual',
            firstName: existing.firstName,
            lastName: existing.lastName,
            companyName: existing.companyName,
            email: existing.email,
            phone: existing.phone,
            // Si se dio de baja de las ofertas, sigue de baja como inquilino.
            marketingOptOutAt: existing.marketingOptOutAt,
          },
        });
        customerId = customer.id;
        createdCustomer = customer;
      } else if (existing.marketingOptOutAt) {
        await tx.customer.updateMany({
          where: { id: customerId, marketingOptOutAt: null },
          data: { marketingOptOutAt: existing.marketingOptOutAt },
        });
      }
      let reservationId: string | null = null;
      if (args.input.reservation) {
        const wanted = args.input.reservation;
        const unit = await tx.unit.findFirst({
          where: { id: wanted.unitId, facility: { deletedAt: null } },
          select: { id: true, status: true, facilityId: true },
        });
        if (!unit) {
          throw new NotFoundException({
            code: 'unit_not_found',
            message: 'Trastero no encontrado',
          });
        }
        assertFacilityAllowed(args.facilityScope, unit.facilityId);
        if (['occupied', 'maintenance', 'blocked'].includes(unit.status)) {
          throw new ConflictException({
            code: 'unit_not_reservable',
            message: 'Ese trastero no se puede reservar ahora',
          });
        }
        if (await unitHeldByOther(tx, { unitId: unit.id, customerId, ignoreReservations: true })) {
          throw new ConflictException({
            code: 'unit_held_by_other',
            message: 'Este trastero está guardado para otra persona',
          });
        }
        try {
          const reservation = await tx.reservation.create({
            data: {
              tenantId: args.tenantId,
              unitId: wanted.unitId,
              customerId,
              status: 'pending',
              validFrom: new Date(wanted.validFrom),
              validUntil: new Date(wanted.validUntil),
              depositAmount: wanted.depositAmount,
            },
          });
          reservationId = reservation.id;
        } catch (err) {
          if (isReservationOverlap(err)) {
            throw new ConflictException({
              code: 'reservation_overlap',
              message: 'Ya existe una reserva activa que solapa con esas fechas',
            });
          }
          throw err;
        }
      }
      return tx.lead.update({
        where: { id: args.id },
        data: {
          status: 'won',
          wonAt: new Date(),
          convertedCustomerId: customerId,
          convertedReservationId: reservationId,
          // Ya no está perdido: sin motivo de pérdida.
          lostAt: null,
          lostReason: null,
          lostReasonCode: null,
          returnedAt: null,
        },
        include: LEAD_INCLUDE,
      });
    }, args.tenantId);
    if (createdCustomer) this.emitCustomerCreated(args.tenantId, createdCustomer);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.converted',
      entityType: 'Lead',
      entityId: args.id,
      changes: {
        customerId: result.convertedCustomerId,
        reservationId: result.convertedReservationId,
      },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(result);
  }

  /**
   * Borra el contacto y sus datos (derecho al olvido): nombre, email, teléfono,
   * mensajes, actividad, seguimientos, correos, WhatsApp y chat de la web.
   */
  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
    scope?: FacilityScope;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id, false, args.scope);
    const { mediaKeys } = await this.prisma.withTenant(
      (tx) => anonymizeLeadsTx(tx, [args.id]),
      args.tenantId,
    );
    if (mediaKeys.length > 0) {
      await this.files.deleteObjects('uploads', mediaKeys).catch(() => undefined);
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.deleted',
      entityType: 'Lead',
      entityId: args.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  // -----------------------------------------------------------------

  /**
   * Consentimiento comercial del lead (lo marca el staff, p. ej. si lo dio por
   * teléfono). `false` = se da de baja.
   */
  async setMarketing(args: {
    tenantId: string;
    userId: string;
    id: string;
    consent: boolean;
    meta: RequestMeta;
    scope?: FacilityScope;
  }): Promise<LeadDto> {
    await this.findOrThrow(args.tenantId, args.id, false, args.scope);
    const now = new Date();
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.lead.update({
        where: { id: args.id },
        data: args.consent
          ? { marketingConsentAt: now, marketingOptOutAt: null }
          : { marketingOptOutAt: now },
        include: LEAD_INCLUDE,
      });
      // La baja va por email: también las otras fichas con la misma dirección.
      await applyMarketingOptOutByEmail(tx, args.tenantId, row.email, args.consent ? null : now);
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.consent ? 'lead.marketing_consent_given' : 'lead.marketing_opted_out',
      entityType: 'Lead',
      entityId: args.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(updated);
  }

  /**
   * Un contacto que vuelve a escribir (mismo email o teléfono, aún abierto)
   * no crea otro: se añade su mensaje al existente. Devuelve null si es nuevo.
   */
  private async mergeRepeatContact(
    tenantId: string,
    c: {
      email: string | null | undefined;
      phone: string | null | undefined;
      message: string | null;
      channel: string;
      marketingConsent: boolean;
    },
  ): Promise<LeadDto | null> {
    const email = c.email?.trim().toLowerCase() || null;
    const phone = c.phone?.replace(/\s+/g, '') || null;
    // El teléfono se compara por sus 9 últimas cifras («600 555 444» = «+34600555444»).
    const key = phoneKey(phone);
    if (!email && !key) return null;
    const match = await this.prisma.withTenant(
      (tx) => tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM leads
         WHERE deleted_at IS NULL
           AND status IN ('new', 'contacted', 'qualified')
           AND (
             ${email ? Prisma.sql`lower(email) = ${email}` : Prisma.sql`FALSE`}
             OR ${
               key
                 ? Prisma.sql`right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 9) = ${key}`
                 : Prisma.sql`FALSE`
             }
           )
         ORDER BY updated_at DESC
         LIMIT 1`,
      tenantId,
    );
    const existing = match[0]
      ? await this.prisma.withTenant(
          (tx) => tx.lead.findFirst({ where: { id: match[0]!.id } }),
          tenantId,
        )
      : null;
    if (!existing) return null;
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);
    const note = c.message?.trim()
      ? `[${stamp} · ${c.channel}] ${c.message.trim()}`
      : `[${stamp} · ${c.channel}] Ha vuelto a contactar.`;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.lead.update({
          where: { id: existing.id },
          data: {
            message: existing.message ? `${existing.message}\n\n${note}`.slice(-8000) : note,
            ...(email && !existing.email ? { email } : {}),
            ...(phone && !existing.phone ? { phone } : {}),
            ...(c.marketingConsent && !existing.marketingConsentAt && !existing.marketingOptOutAt
              ? { marketingConsentAt: now }
              : {}),
            // Se marca en la tarjeta hasta que alguien le atienda.
            returnedAt: now,
          },
          include: LEAD_INCLUDE,
        }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      action: 'lead.repeat_contact',
      entityType: 'Lead',
      entityId: existing.id,
      changes: { channel: c.channel },
    });
    // Aviso a su responsable (o al equipo si no tiene).
    await this.notifications
      .create(tenantId, {
        type: 'lead.returned',
        title: `${leadDisplayName(existing)} ha vuelto a escribir`,
        ...(c.message?.trim() ? { body: c.message.trim().slice(0, 200) } : {}),
        link: `/leads?lead=${existing.id}`,
        facilityId: existing.preferredFacilityId,
        ...(existing.assignedToUserId ? { userId: existing.assignedToUserId } : {}),
      })
      .catch(() => undefined);
    return this.toDto(updated);
  }

  /**
   * Al firmar el primer contrato de un contacto que el equipo convirtió a mano,
   * se enlaza el contrato al contacto: así cuenta en el rendimiento de su canal
   * (antes solo lo enlazaba la reserva online).
   */
  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onContractSigned(p: DomainEventPayload): Promise<void> {
    const customerId = p.customerId;
    if (!customerId || p.entityType !== 'contract') return;
    try {
      await this.prisma.withTenant(async (tx) => {
        // Reserva online: el contacto se gana al firmar.
        await tx.lead.updateMany({
          where: { convertedContractId: p.entityId, status: { not: 'won' }, deletedAt: null },
          data: {
            status: 'won',
            wonAt: new Date(),
            convertedCustomerId: customerId,
            lostAt: null,
            lostReason: null,
            lostReasonCode: null,
          },
        });
        await tx.lead.updateMany({
          where: {
            convertedCustomerId: customerId,
            convertedContractId: null,
            status: 'won',
            deletedAt: null,
          },
          data: { convertedContractId: p.entityId },
        });
      }, p.tenantId);
    } catch (err) {
      this.logger.warn(
        `[leads] no se pudo enlazar el contrato ${p.entityId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * La reserva online caducó sin firmar o sin pagar: el contacto vuelve a estar
   * abierto, con una nota, y se avisa a su responsable para llamarle.
   */
  @OnEvent(DOMAIN_EVENTS.booking_expired, { async: true, promisify: true })
  async onBookingExpired(p: BookingExpiredPayload): Promise<void> {
    try {
      const leads = await this.prisma.withTenant(
        (tx) =>
          tx.lead.findMany({
            where: { convertedContractId: p.contractId, deletedAt: null },
          }),
        p.tenantId,
      );
      const stamp = new Date().toISOString().slice(0, 10);
      for (const lead of leads) {
        const note = `[${stamp} · reserva] La reserva online caducó sin completarse.`;
        await this.prisma.withTenant(
          (tx) =>
            tx.lead.update({
              where: { id: lead.id },
              data: {
                status: 'qualified',
                qualifiedAt: lead.qualifiedAt ?? new Date(),
                wonAt: null,
                convertedCustomerId: null,
                message: lead.message ? `${lead.message}\n\n${note}`.slice(-8000) : note,
              },
            }),
          p.tenantId,
        );
        await this.notifications
          .create(p.tenantId, {
            type: 'lead.booking_expired',
            title: `Reserva caducada: llama a ${leadDisplayName(lead)}`,
            body: 'Empezó una reserva online y no la terminó.',
            link: `/leads?lead=${lead.id}`,
            facilityId: lead.preferredFacilityId,
            ...(lead.assignedToUserId ? { userId: lead.assignedToUserId } : {}),
          })
          .catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(
        `[leads] reserva caducada ${p.contractId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async findOrThrow(
    tenantId: string,
    id: string,
    includeRelations = false,
    scope?: FacilityScope,
  ): Promise<LeadWithIncludes> {
    const where = { id, deletedAt: null, ...leadScopeWhere(scope) };
    const row = await this.prisma.withTenant(
      (tx) =>
        includeRelations
          ? tx.lead.findFirst({ where, include: LEAD_INCLUDE })
          : tx.lead.findFirst({ where }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'lead_not_found', message: 'Lead no encontrado' });
    }
    return row as LeadWithIncludes;
  }

  private buildCreateData(
    tenantId: string,
    input: CreateLeadInput,
  ): Prisma.LeadUncheckedCreateInput {
    return {
      tenantId,
      source: input.source,
      marketingConsentAt: input.marketingConsent ? new Date() : null,
      firstName: input.firstName || null,
      lastName: input.lastName || null,
      companyName: input.companyName || null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      message: input.message || null,
      preferredFacilityId: input.preferredFacilityId ?? null,
      preferredUnitTypeId: input.preferredUnitTypeId ?? null,
      preferredStartDate: input.preferredStartDate ? new Date(input.preferredStartDate) : null,
      estimatedDurationMonths: input.estimatedDurationMonths ?? null,
      budgetMonthly: input.budgetMonthly ?? null,
      assignedToUserId: input.assignedToUserId ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      metadata: input.metadata as Prisma.InputJsonValue,
    };
  }

  /** El contacto pasa a ser inquilino: salta la bienvenida y las automatizaciones de alta. */
  private emitCustomerCreated(
    tenantId: string,
    c: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      email: string | null;
      phone: string | null;
    },
  ): void {
    const payload: DomainEventPayload = {
      tenantId,
      entityType: 'customer',
      entityId: c.id,
      recipientEmail: c.email,
      recipientPhone: c.phone,
      customerId: c.id,
      scope: {
        customer: {
          firstName: c.firstName ?? '',
          lastName: c.lastName ?? '',
          displayName: leadDisplayName(c),
          email: c.email ?? '',
          phone: c.phone ?? '',
        },
      },
    };
    this.events.emit(DOMAIN_EVENTS.customer_created, payload);
  }

  private emitLeadCreated(tenantId: string, lead: Lead): void {
    const displayName = leadDisplayName(lead);
    const payload: DomainEventPayload = {
      tenantId,
      entityType: 'lead',
      entityId: lead.id,
      recipientEmail: lead.email,
      recipientPhone: lead.phone,
      leadId: lead.id,
      scope: {
        lead: {
          firstName: lead.firstName ?? '',
          lastName: lead.lastName ?? '',
          displayName,
          email: lead.email ?? '',
          phone: lead.phone ?? '',
        },
      },
    };
    this.events.emit(DOMAIN_EVENTS.lead_created, payload);
  }

  private toDto(l: LeadWithIncludes): LeadDto {
    const displayName = leadDisplayName(l);
    const scored = leadScore({
      status: l.status,
      source: l.source,
      email: l.email,
      phone: l.phone,
      message: l.message,
      preferredFacilityId: l.preferredFacilityId,
      preferredUnitTypeId: l.preferredUnitTypeId,
      preferredStartDate: l.preferredStartDate?.toISOString().slice(0, 10) ?? null,
      budgetMonthly: l.budgetMonthly ? Number(l.budgetMonthly) : null,
      createdAt: l.createdAt.toISOString(),
    });
    return {
      id: l.id,
      marketingConsentAt: l.marketingConsentAt?.toISOString() ?? null,
      marketingOptOutAt: l.marketingOptOutAt?.toISOString() ?? null,
      status: l.status,
      source: l.source,
      firstName: l.firstName,
      lastName: l.lastName,
      companyName: l.companyName,
      displayName,
      email: l.email,
      phone: l.phone,
      message: l.message,
      preferredFacilityId: l.preferredFacilityId,
      preferredFacilityName: l.preferredFacility?.name ?? null,
      preferredUnitTypeId: l.preferredUnitTypeId,
      preferredUnitTypeName: l.preferredUnitType?.name ?? null,
      preferredStartDate: l.preferredStartDate?.toISOString().slice(0, 10) ?? null,
      estimatedDurationMonths: l.estimatedDurationMonths,
      budgetMonthly: l.budgetMonthly ? Number(l.budgetMonthly) : null,
      assignedToUserId: l.assignedToUserId,
      assignedToName: l.assignedTo?.fullName ?? null,
      contactedAt: l.contactedAt?.toISOString() ?? null,
      qualifiedAt: l.qualifiedAt?.toISOString() ?? null,
      wonAt: l.wonAt?.toISOString() ?? null,
      lostAt: l.lostAt?.toISOString() ?? null,
      lostReason: l.lostReason,
      lostReasonCode: (l.lostReasonCode as LeadLostReason | null) ?? null,
      convertedCustomerId: l.convertedCustomerId,
      convertedContractId: l.convertedContractId,
      convertedReservationId: l.convertedReservationId,
      bookedAt: l.bookedAt?.toISOString() ?? null,
      returnedAt: l.returnedAt?.toISOString() ?? null,
      utmSource: l.utmSource,
      utmMedium: l.utmMedium,
      utmCampaign: l.utmCampaign,
      score: scored.score,
      scoreReasons: scored.reasons,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };
  }
}
