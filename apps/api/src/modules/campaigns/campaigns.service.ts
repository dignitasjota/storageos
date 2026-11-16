import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import {
  campaignMarkupToHtml,
  campaignMarkupToText,
  campaignTemplateVariables,
  type CampaignChannel,
  type CampaignWhatsappTemplate,
} from '@storageos/shared';

import { type FacilityScope, assertFacilityAllowed } from '../../common/facility-scope';
import { formerCustomerWhere, noDebtWhere } from '../../common/marketing/audience';
import { buildClickToken, clickKey, extractLinks } from '../../common/marketing/click-token';
import { blockedMarketingEmails } from '../../common/marketing/opt-out';
import { assertTemplateTexts } from '../../common/marketing/template-check';
import { respondThenRun } from '../../common/security/respond-then-run';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { renderText } from '../communications/template-engine';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { WhatsappCampaignSender, whatsappId } from '../whatsapp-business/whatsapp-campaign.sender';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type {
  CampaignDto,
  CampaignPreviewDto,
  CampaignSegmentInput,
  CreateCampaignInput,
  UpdateCampaignInput,
} from '@storageos/shared';

interface Recipient {
  /** Dirección (correo) o móvil (WhatsApp) a la que va. */
  address: string;
  name: string;
  customerId?: string;
  leadId?: string;
  /** Inquilino en inglés. */
  english: boolean;
  scope: Record<string, unknown>;
}

/** Lo que hace falta de una campaña para comprobar y preparar sus textos. */
interface CampaignTexts {
  channel: CampaignChannel;
  subject: string;
  bodyText: string;
  subjectEn: string | null;
  bodyTextEn: string | null;
  couponCode: string | null;
  whatsappTemplate: CampaignWhatsappTemplate | null;
  segment: CampaignSegmentInput;
}

const DAY_MS = 86_400_000;
/** Recibió otra comunicación comercial en estos días (aviso en la vista previa). */
const RECENT_DAYS = 7;

/** Quién hace la acción (para el alcance por local y el registro). */
export interface CampaignActor {
  userId: string;
  scope: FacilityScope;
  meta: RequestMeta;
}

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/** Variables que se pueden usar según a quién va la campaña y si ofrece un cupón. */
export function campaignVariables(
  segment: CampaignSegmentInput,
  couponCode?: string | null,
): readonly string[] {
  return campaignTemplateVariables(segment.audience, !!couponCode);
}

function emptyToNull(v: string | null | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

/** Quien solo ve unos locales no cambia lo que es de toda la empresa. */
export function assertWholeBusiness(scope: FacilityScope, what: string): void {
  if (scope) {
    throw new ForbiddenException({
      code: 'facility_not_in_scope',
      message: `${what} es de toda la empresa: pídeselo a quien ve todos los locales`,
    });
  }
}

type CampaignRow = Prisma.CampaignGetPayload<object>;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly whatsapp: WhatsappCampaignSender,
  ) {}

  /**
   * Enlaces de la campaña con su id (se crean la primera vez). Cada destinatario
   * recibe una versión con seguimiento que pasa por `/public/campaign-click`.
   */
  private async trackedLinks(
    tenantId: string,
    campaignId: string,
    bodyText: string,
  ): Promise<Array<{ id: string; url: string }>> {
    const urls = extractLinks(bodyText);
    if (urls.length === 0) return [];
    await this.admin.campaignLink.createMany({
      data: urls.map((url, position) => ({ tenantId, campaignId, url, position })),
      skipDuplicates: true,
    });
    return this.admin.campaignLink.findMany({
      where: { campaignId },
      select: { id: true, url: true },
    });
  }

  /**
   * A dónde lleva cada enlace del correo de un destinatario: su versión con
   * seguimiento. El destinatario ve el texto o la dirección que escribió el
   * negocio; el texto plano y el historial guardan la dirección original.
   */
  private trackedHref(
    links: Array<{ id: string; url: string }>,
    recipient: { customerId?: string; leadId?: string },
  ): (url: string) => string {
    const kind = recipient.customerId ? 'c' : recipient.leadId ? 'l' : null;
    const id = recipient.customerId ?? recipient.leadId;
    const byUrl = new Map(links.map((l) => [l.url, l.id]));
    const key = clickKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    const api = this.config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    return (url) => {
      const linkId = byUrl.get(url);
      return linkId && kind && id
        ? `${api}/v1/public/campaign-click/${buildClickToken(key, linkId, kind, id)}`
        : url;
    };
  }

  private toDto(c: CampaignRow, createdByName: string | null = null): CampaignDto {
    return {
      id: c.id,
      name: c.name,
      channel: c.channel === 'whatsapp' ? 'whatsapp' : 'email',
      subject: c.subject,
      bodyText: c.bodyText,
      subjectEn: c.subjectEn,
      bodyTextEn: c.bodyTextEn,
      couponCode: c.couponCode,
      whatsappTemplate: (c.whatsappTemplate as CampaignWhatsappTemplate | null) ?? null,
      createdByName,
      segment: (c.segment as CampaignSegmentInput) ?? {
        audience: 'customers',
        contractStatus: 'any',
        overdueOnly: false,
      },
      status: c.status as CampaignDto['status'],
      audienceCount: c.audienceCount,
      sentCount: c.sentCount,
      scheduledFor: c.scheduledFor?.toISOString() ?? null,
      sentAt: c.sentAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // Alcance por local y comprobaciones
  // ---------------------------------------------------------------------

  /** Una campaña la ve quien ve todos sus locales (o todo el negocio). */
  private visible(c: { facilityScope: string[] }, scope: FacilityScope): boolean {
    if (!scope) return true;
    return c.facilityScope.length > 0 && c.facilityScope.every((f) => scope.includes(f));
  }

  /** Locales a los que escribe la campaña (los de quien la creó). */
  private campaignScope(c: { facilityScope: string[] }): FacilityScope {
    return c.facilityScope.length > 0 ? c.facilityScope : null;
  }

  private assertSegment(segment: CampaignSegmentInput, scope: FacilityScope): void {
    if (segment.facilityId) assertFacilityAllowed(scope, segment.facilityId);
  }

  private assertTexts(c: CampaignTexts): void {
    const allowed = campaignVariables(c.segment, c.couponCode);
    assertTemplateTexts(
      [
        { label: 'Asunto', text: c.subject },
        { label: 'Mensaje', text: c.bodyText },
        { label: 'Asunto en inglés', text: c.subjectEn },
        { label: 'Mensaje en inglés', text: c.bodyTextEn },
        ...(c.whatsappTemplate?.params ?? []).map((p, i) => ({
          label: `Parámetro {{${i + 1}}} de la plantilla`,
          text: p,
        })),
      ],
      allowed,
    );
    if (!!c.subjectEn !== !!c.bodyTextEn) {
      throw new BadRequestException({
        code: 'english_version_incomplete',
        message: 'La versión en inglés necesita asunto y mensaje',
      });
    }
  }

  /** El cupón tiene que existir y poder usarse; devuelve su código tal cual está guardado. */
  private async assertCoupon(tenantId: string, code: string | null): Promise<string | null> {
    if (!code) return null;
    const coupon = await this.admin.coupon.findFirst({
      where: { tenantId, code: { equals: code, mode: 'insensitive' } },
      select: { code: true, isActive: true, validUntil: true },
    });
    if (!coupon || !coupon.isActive || (coupon.validUntil && coupon.validUntil < new Date())) {
      throw new BadRequestException({
        code: 'coupon_not_found',
        message: 'No hay ningún cupón activo con ese código',
      });
    }
    return coupon.code;
  }

  /** Una campaña por WhatsApp necesita una plantilla y el WhatsApp del negocio activo. */
  private async assertChannel(
    tenantId: string,
    channel: CampaignChannel,
    template: CampaignWhatsappTemplate | null,
  ): Promise<void> {
    if (channel !== 'whatsapp') return;
    if (!template) {
      throw new BadRequestException({
        code: 'whatsapp_template_required',
        message: 'Elige la plantilla aprobada de WhatsApp',
      });
    }
    if (!(await this.whatsapp.ready(tenantId))) {
      throw new BadRequestException({
        code: 'whatsapp_not_configured',
        message: 'Conecta y activa el WhatsApp del negocio en Configuración',
      });
    }
  }

  private assertFuture(scheduledFor: string | null | undefined): void {
    if (scheduledFor && new Date(scheduledFor).getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'scheduled_in_past',
        message: 'La fecha del envío tiene que ser futura',
      });
    }
  }

  // ---------------------------------------------------------------------
  // Resolución de la audiencia
  // ---------------------------------------------------------------------

  /**
   * Destinatarios de la campaña: cada dirección (o móvil) una sola vez y sin
   * quien se haya dado de baja (en cualquiera de sus fichas) ni las direcciones
   * que rebotan o marcaron spam. Con `scope`, solo los de esos locales.
   */
  private async resolveRecipients(
    tenantId: string,
    segment: CampaignSegmentInput,
    tenantName: string,
    scope: FacilityScope,
    channel: CampaignChannel = 'email',
    couponCode: string | null = null,
  ): Promise<Recipient[]> {
    const list =
      segment.audience === 'leads'
        ? await this.leadRecipients(tenantId, segment, tenantName, scope, channel)
        : await this.customerRecipients(tenantId, segment, tenantName, scope, channel);
    if (couponCode) for (const r of list) r.scope.coupon = { code: couponCode };
    const unique = await this.withoutBlocked(tenantId, list, channel);
    const recentDays = segment.excludeRecentDays;
    if (!recentDays) return unique;
    const recent = await this.recentlyContacted(tenantId, unique, recentDays);
    return unique.filter((r) => !recent.has((r.customerId ?? r.leadId)!));
  }

  /** Quiénes de la lista recibieron otra comunicación comercial en esos días. */
  private async recentlyContacted(
    tenantId: string,
    list: Recipient[],
    days: number,
  ): Promise<Set<string>> {
    const customerIds = list.map((r) => r.customerId).filter((v): v is string => !!v);
    const leadIds = list.map((r) => r.leadId).filter((v): v is string => !!v);
    if (customerIds.length === 0 && leadIds.length === 0) return new Set();
    const rows = await this.admin.communication.findMany({
      where: {
        tenantId,
        isMarketing: true,
        createdAt: { gte: new Date(Date.now() - days * DAY_MS) },
        OR: [
          ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
          ...(leadIds.length ? [{ leadId: { in: leadIds } }] : []),
        ],
      },
      select: { customerId: true, leadId: true },
    });
    return new Set(rows.map((r) => (r.customerId ?? r.leadId)!).filter(Boolean));
  }

  private async leadRecipients(
    tenantId: string,
    segment: Extract<CampaignSegmentInput, { audience: 'leads' }>,
    tenantName: string,
    scope: FacilityScope,
    channel: CampaignChannel,
  ): Promise<Recipient[]> {
    const and: Prisma.LeadWhereInput[] = [
      {
        deletedAt: null,
        ...(channel === 'whatsapp' ? { phone: { not: null } } : { email: { not: null } }),
        // Aún no son clientes: solo con consentimiento expreso y sin baja (LSSI art. 21).
        marketingConsentAt: { not: null },
        marketingOptOutAt: null,
      },
    ];
    if (segment.leadStatus) and.push({ status: segment.leadStatus });
    if (segment.leadSource) and.push({ source: segment.leadSource });
    if (segment.facilityId) and.push({ preferredFacilityId: segment.facilityId });
    if (segment.createdWithinDays) {
      and.push({ createdAt: { gte: new Date(Date.now() - segment.createdWithinDays * DAY_MS) } });
    }
    // Quien solo ve unos locales escribe a los contactos de esos locales.
    if (scope) and.push({ preferredFacilityId: { in: scope } });
    const leads = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where: { AND: and },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
          },
        }),
      tenantId,
    );
    return leads.flatMap((l) => {
      const address = channel === 'whatsapp' ? l.phone : l.email;
      if (!address) return [];
      const displayName =
        [l.firstName, l.lastName].filter(Boolean).join(' ').trim() ||
        l.companyName ||
        'Cliente potencial';
      return [
        {
          address,
          name: displayName,
          leadId: l.id,
          english: false,
          scope: {
            lead: { firstName: l.firstName ?? '', displayName },
            tenant: { name: tenantName },
          },
        },
      ];
    });
  }

  private async customerRecipients(
    tenantId: string,
    segment: Extract<CampaignSegmentInput, { audience: 'customers' }>,
    tenantName: string,
    scope: FacilityScope,
    channel: CampaignChannel,
  ): Promise<Recipient[]> {
    const now = Date.now();
    const and: Prisma.CustomerWhereInput[] = [
      // Clientes: mientras no se den de baja.
      {
        deletedAt: null,
        marketingOptOutAt: null,
        ...(channel === 'whatsapp'
          ? { phone: { not: null }, whatsappOptOutAt: null }
          : { email: { not: null } }),
      },
    ];
    const live: Prisma.ContractWhereInput = {
      status: { in: ['active', 'ending'] },
      deletedAt: null,
    };
    // Con un local elegido, el contrato que cuenta es el de ese local.
    const inFacility: Prisma.ContractWhereInput = segment.facilityId
      ? { unit: { facilityId: segment.facilityId } }
      : {};
    if (segment.contractStatus === 'active') {
      and.push({
        contracts: {
          some: { status: { in: ['active', 'ending'] }, deletedAt: null, ...inFacility },
        },
      });
    } else if (segment.contractStatus === 'none') {
      and.push({
        contracts: { none: { status: { in: ['active', 'ending'] }, deletedAt: null } },
      });
    } else if (segment.contractStatus === 'former') {
      // Win-back: terminaron su contrato, no tienen otro y no se fueron debiendo.
      and.push(formerCustomerWhere(inFacility));
    }
    if (
      segment.facilityId &&
      segment.contractStatus !== 'active' &&
      segment.contractStatus !== 'former'
    ) {
      // «Todos» o «sin contrato activo» de un local = quien ha tenido contrato allí.
      and.push({ contracts: { some: { deletedAt: null, ...inFacility } } });
    }
    // Quien solo ve unos locales escribe a quien ha tenido contrato en ellos.
    if (scope) {
      and.push({ contracts: { some: { deletedAt: null, unit: { facilityId: { in: scope } } } } });
    }
    if (segment.overdueOnly) and.push({ invoices: { some: { status: 'overdue' } } });
    if (segment.tag && segment.tag.trim()) and.push({ tags: { has: segment.tag.trim() } });
    if (segment.customerIds) and.push({ id: { in: segment.customerIds } });
    // Antigüedad: desde su primer contrato firmado.
    if (segment.minMonths !== undefined) {
      and.push({
        contracts: {
          some: {
            deletedAt: null,
            signedAt: { lte: new Date(now - segment.minMonths * 30.44 * DAY_MS) },
          },
        },
      });
    }
    if (segment.maxMonths !== undefined) {
      and.push({ contracts: { some: { deletedAt: null, signedAt: { not: null } } } });
      and.push({
        contracts: {
          none: {
            deletedAt: null,
            signedAt: { lt: new Date(now - segment.maxMonths * 30.44 * DAY_MS) },
          },
        },
      });
    }
    if (segment.unitTypeId) {
      and.push({ contracts: { some: { ...live, unit: { unitTypeId: segment.unitTypeId } } } });
    }
    if (segment.withoutInsurance) {
      and.push({ contracts: { some: { ...live, insurancePlanId: null } } });
    }
    if (segment.endingWithinDays) {
      and.push({
        contracts: {
          some: {
            ...live,
            endDate: {
              gte: new Date(now - DAY_MS),
              lte: new Date(now + segment.endingWithinDays * DAY_MS),
            },
          },
        },
      });
    }
    if (segment.locale) and.push({ locale: segment.locale });
    if (segment.excludeDebtors) and.push(noDebtWhere());

    const customers = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: { AND: and },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
            locale: true,
          },
        }),
      tenantId,
    );
    return customers.flatMap((c) => {
      const address = channel === 'whatsapp' ? c.phone : c.email;
      if (!address) return [];
      const displayName = customerName(c);
      return [
        {
          address,
          name: displayName,
          customerId: c.id,
          english: c.locale === 'en',
          scope: {
            customer: {
              firstName: c.firstName ?? '',
              lastName: c.lastName ?? '',
              displayName,
            },
            tenant: { name: tenantName },
          },
        },
      ];
    });
  }

  /**
   * Una dirección (o un móvil) una sola vez; por correo, fuera las direcciones
   * que se dieron de baja en alguna de sus fichas y las que rebotan o marcaron
   * spam.
   */
  private async withoutBlocked(
    tenantId: string,
    list: Recipient[],
    channel: CampaignChannel,
  ): Promise<Recipient[]> {
    const unique = new Map<string, Recipient>();
    for (const r of list) {
      const key = channel === 'whatsapp' ? whatsappId(r.address) : r.address.trim().toLowerCase();
      if (key && !unique.has(key)) unique.set(key, r);
    }
    if (channel === 'whatsapp' || unique.size === 0) return [...unique.values()];
    const blocked = await blockedMarketingEmails(this.admin, tenantId, [...unique.keys()]);
    for (const email of blocked) unique.delete(email);
    return [...unique.values()];
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------

  async preview(
    tenantId: string,
    segment: CampaignSegmentInput,
    scope: FacilityScope = null,
    channel: CampaignChannel = 'email',
  ): Promise<CampaignPreviewDto> {
    this.assertSegment(segment, scope);
    const recipients = await this.resolveRecipients(tenantId, segment, '', scope, channel);
    const recent = await this.recentlyContacted(tenantId, recipients, RECENT_DAYS);
    return {
      audienceCount: recipients.length,
      recentlyContacted: recipients.filter((r) => recent.has((r.customerId ?? r.leadId)!)).length,
      english: recipients.filter((r) => r.english).length,
    };
  }

  /** Nombres de quien creó cada campaña. */
  private async creators(rows: Array<{ createdByUserId: string | null }>) {
    const ids = [...new Set(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v))];
    if (ids.length === 0) return new Map<string, string>();
    const users = await this.admin.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private async dto(row: CampaignRow): Promise<CampaignDto> {
    const names = await this.creators([row]);
    return this.toDto(row, row.createdByUserId ? (names.get(row.createdByUserId) ?? null) : null);
  }

  async list(tenantId: string, scope: FacilityScope = null): Promise<CampaignDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.campaign.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    const visible = rows.filter((r) => this.visible(r, scope));
    const names = await this.creators(visible);
    return visible.map((r) =>
      this.toDto(r, r.createdByUserId ? (names.get(r.createdByUserId) ?? null) : null),
    );
  }

  async detail(tenantId: string, id: string, scope: FacilityScope = null): Promise<CampaignDto> {
    return this.dto(await this.findOrThrow(tenantId, id, scope));
  }

  /** Comprueba los textos, el cupón y el canal; devuelve lo que se guarda. */
  private async prepare(tenantId: string, c: CampaignTexts): Promise<CampaignTexts> {
    const couponCode = await this.assertCoupon(tenantId, c.couponCode);
    const ready = { ...c, couponCode };
    this.assertTexts(ready);
    await this.assertChannel(tenantId, c.channel, c.whatsappTemplate);
    return ready;
  }

  async create(args: {
    tenantId: string;
    actor: CampaignActor;
    input: CreateCampaignInput;
  }): Promise<CampaignDto> {
    const { tenantId, input, actor } = args;
    const texts = await this.prepare(tenantId, {
      channel: input.channel,
      subject: input.subject,
      bodyText: input.bodyText,
      subjectEn: emptyToNull(input.subjectEn),
      bodyTextEn: emptyToNull(input.bodyTextEn),
      couponCode: emptyToNull(input.couponCode),
      whatsappTemplate: input.channel === 'whatsapp' ? (input.whatsappTemplate ?? null) : null,
      segment: input.segment,
    });
    this.assertFuture(input.scheduledFor);
    const audience = await this.preview(tenantId, input.segment, actor.scope, input.channel);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.create({
          data: {
            tenantId,
            name: input.name,
            channel: texts.channel,
            subject: texts.subject,
            bodyText: texts.bodyText,
            subjectEn: texts.subjectEn,
            bodyTextEn: texts.bodyTextEn,
            couponCode: texts.couponCode,
            ...(texts.whatsappTemplate
              ? { whatsappTemplate: texts.whatsappTemplate as Prisma.InputJsonValue }
              : {}),
            segment: input.segment as Prisma.InputJsonValue,
            status: 'draft',
            audienceCount: audience.audienceCount,
            scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
            createdByUserId: actor.userId,
            facilityScope: actor.scope ?? [],
          },
        }),
      tenantId,
    );
    await this.log(tenantId, actor, 'campaign.created', created.id, {
      name: created.name,
      channel: created.channel,
    });
    return this.dto(created);
  }

  /** Cambia un borrador (y recalcula a cuántos va). */
  async update(args: {
    tenantId: string;
    id: string;
    actor: CampaignActor;
    input: UpdateCampaignInput;
  }): Promise<CampaignDto> {
    const { tenantId, id, input, actor } = args;
    const current = await this.findOrThrow(tenantId, id, actor.scope);
    if (current.status !== 'draft') {
      throw new ConflictException({
        code: 'campaign_not_editable',
        message: 'Solo se puede cambiar una campaña en borrador',
      });
    }
    const segment = input.segment ?? (current.segment as CampaignSegmentInput);
    const channel: CampaignChannel = current.channel === 'whatsapp' ? 'whatsapp' : 'email';
    const texts = await this.prepare(tenantId, {
      channel,
      subject: input.subject ?? current.subject,
      bodyText: input.bodyText ?? current.bodyText,
      subjectEn: input.subjectEn !== undefined ? emptyToNull(input.subjectEn) : current.subjectEn,
      bodyTextEn:
        input.bodyTextEn !== undefined ? emptyToNull(input.bodyTextEn) : current.bodyTextEn,
      couponCode:
        input.couponCode !== undefined ? emptyToNull(input.couponCode) : current.couponCode,
      whatsappTemplate:
        input.whatsappTemplate !== undefined
          ? input.whatsappTemplate
          : ((current.whatsappTemplate as CampaignWhatsappTemplate | null) ?? null),
      segment,
    });
    if (input.scheduledFor !== undefined) this.assertFuture(input.scheduledFor);
    const audience = await this.preview(tenantId, segment, actor.scope, channel);
    const claimed = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.updateMany({
          where: { id, status: 'draft' },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            subject: texts.subject,
            bodyText: texts.bodyText,
            subjectEn: texts.subjectEn,
            bodyTextEn: texts.bodyTextEn,
            couponCode: texts.couponCode,
            whatsappTemplate: texts.whatsappTemplate
              ? (texts.whatsappTemplate as Prisma.InputJsonValue)
              : Prisma.DbNull,
            segment: segment as Prisma.InputJsonValue,
            audienceCount: audience.audienceCount,
            ...(input.scheduledFor !== undefined
              ? { scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null }
              : {}),
          },
        }),
      tenantId,
    );
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'campaign_not_editable',
        message: 'La campaña ha cambiado de estado; recarga la página',
      });
    }
    await this.log(tenantId, actor, 'campaign.updated', id, {
      fields: Object.entries(input)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k),
    });
    return this.detail(tenantId, id, actor.scope);
  }

  /** Copia una campaña en un borrador nuevo (sin fecha de envío). */
  async duplicate(tenantId: string, id: string, actor: CampaignActor): Promise<CampaignDto> {
    const source = await this.findOrThrow(tenantId, id, actor.scope);
    const segment = source.segment as CampaignSegmentInput;
    const channel: CampaignChannel = source.channel === 'whatsapp' ? 'whatsapp' : 'email';
    const audience = await this.preview(tenantId, segment, actor.scope, channel);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.create({
          data: {
            tenantId,
            name: `${source.name} (copia)`.slice(0, 120),
            channel: source.channel,
            subject: source.subject,
            bodyText: source.bodyText,
            subjectEn: source.subjectEn,
            bodyTextEn: source.bodyTextEn,
            couponCode: source.couponCode,
            ...(source.whatsappTemplate
              ? { whatsappTemplate: source.whatsappTemplate as Prisma.InputJsonValue }
              : {}),
            segment: source.segment as Prisma.InputJsonValue,
            status: 'draft',
            audienceCount: audience.audienceCount,
            createdByUserId: actor.userId,
            facilityScope: actor.scope ?? source.facilityScope,
          },
        }),
      tenantId,
    );
    await this.log(tenantId, actor, 'campaign.duplicated', created.id, { from: id });
    return this.dto(created);
  }

  /** Borra un borrador o una campaña cancelada. */
  async remove(tenantId: string, id: string, actor: CampaignActor): Promise<void> {
    const current = await this.findOrThrow(tenantId, id, actor.scope);
    if (current.status !== 'draft' && current.status !== 'cancelled') {
      throw new ConflictException({
        code: 'campaign_not_deletable',
        message: 'Solo se puede borrar un borrador o una campaña cancelada',
      });
    }
    const { count } = await this.prisma.withTenant(
      (tx) => tx.campaign.deleteMany({ where: { id, status: { in: ['draft', 'cancelled'] } } }),
      tenantId,
    );
    if (count === 0) {
      throw new ConflictException({
        code: 'campaign_not_deletable',
        message: 'La campaña ha cambiado de estado; recarga la página',
      });
    }
    await this.log(tenantId, actor, 'campaign.deleted', id, { name: current.name });
  }

  private textsOf(c: CampaignRow): CampaignTexts {
    return {
      channel: c.channel === 'whatsapp' ? 'whatsapp' : 'email',
      subject: c.subject,
      bodyText: c.bodyText,
      subjectEn: c.subjectEn,
      bodyTextEn: c.bodyTextEn,
      couponCode: c.couponCode,
      whatsappTemplate: (c.whatsappTemplate as CampaignWhatsappTemplate | null) ?? null,
      segment: c.segment as CampaignSegmentInput,
    };
  }

  /**
   * Envía una campaña o la deja programada. Reclama el borrador de forma
   * atómica (un doble clic no la envía dos veces) y responde ya:
   * - con fecha futura queda «programada» y la audiencia se calcula al salir
   *   (quien deja de cumplir los filtros entretanto no la recibe);
   * - si no, se envía en segundo plano (`deliver`).
   */
  async send(tenantId: string, id: string, actor: CampaignActor): Promise<CampaignDto> {
    const campaign = await this.findOrThrow(tenantId, id, actor.scope);
    const future = !!campaign.scheduledFor && campaign.scheduledFor.getTime() > Date.now();
    if (campaign.status === 'draft') {
      const texts = this.textsOf(campaign);
      // Un borrador de antes de esta comprobación puede tener una variable rota.
      this.assertTexts(texts);
      await this.assertChannel(tenantId, texts.channel, texts.whatsappTemplate);
      const recipients = await this.resolveRecipients(
        tenantId,
        texts.segment,
        '',
        this.campaignScope(campaign),
        texts.channel,
      );
      if (recipients.length === 0) {
        throw new BadRequestException({
          code: 'campaign_no_recipients',
          message: 'Nadie la recibiría: cambia a quién va antes de enviarla',
        });
      }
    }
    const claimed = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.updateMany({
          where: { id, status: 'draft' },
          data: { status: future ? 'scheduled' : 'sending' },
        }),
      tenantId,
    );
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'campaign_not_sendable',
        message: 'Solo se puede enviar una campaña en borrador',
      });
    }
    await this.log(tenantId, actor, future ? 'campaign.scheduled' : 'campaign.sent', id, {
      name: campaign.name,
      scheduledFor: campaign.scheduledFor?.toISOString() ?? null,
    });
    if (!future) respondThenRun(this.logger, `campaign ${id}`, () => this.deliver(tenantId, id));
    return this.detail(tenantId, id, actor.scope);
  }

  /**
   * Las programadas cuya hora llegó: se calcula su audiencia y salen (lo llama
   * el cron). Las que se programaron antes de este cambio ya tienen los correos
   * encolados: solo se marcan como enviadas.
   */
  async dispatchScheduled(): Promise<number> {
    const now = new Date();
    const due = await this.admin.campaign.findMany({
      where: { status: 'scheduled', scheduledFor: { lte: now } },
      select: { id: true, tenantId: true },
      take: 20,
    });
    let started = 0;
    for (const c of due) {
      const queued = await this.admin.communication.count({
        where: { tenantId: c.tenantId, source: `campaign:${c.id}` },
      });
      if (queued > 0) {
        await this.admin.campaign.updateMany({
          where: { id: c.id, status: 'scheduled' },
          data: { status: 'sent', sentAt: now },
        });
        continue;
      }
      const claim = await this.admin.campaign.updateMany({
        where: { id: c.id, status: 'scheduled' },
        data: { status: 'sending' },
      });
      if (claim.count === 0) continue;
      started += 1;
      await this.deliver(c.tenantId, c.id).catch((err: unknown) =>
        this.logger.error(`[campaigns] programada ${c.id} no salió: ${String(err)}`),
      );
    }
    return started;
  }

  /**
   * Prepara y envía un mensaje por destinatario (correo al outbox o WhatsApp).
   * Reanudable: si se cortó (reinicio del API), al retomarla no repite a quien
   * ya lo tiene. Va renovando `updatedAt` para que el cron no la retome
   * mientras avanza.
   */
  async deliver(tenantId: string, id: string): Promise<void> {
    const campaign = await this.findOrThrow(tenantId, id);
    if (campaign.status !== 'sending') return;
    const texts = this.textsOf(campaign);
    const source = `campaign:${id}`;
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, portalBrandColor: true },
    });
    const allowed = campaignVariables(texts.segment, texts.couponCode);
    const recipients = await this.resolveRecipients(
      tenantId,
      texts.segment,
      tenant.name,
      this.campaignScope(campaign),
      texts.channel,
      texts.couponCode,
    );
    await this.touch(tenantId, id, { audienceCount: recipients.length });

    const already = new Set(
      (
        await this.admin.communication.findMany({
          where: { tenantId, source },
          select: { recipient: true },
        })
      ).map((c) => c.recipient.toLowerCase()),
    );
    // Una programada antes de este cambio: los correos salen en su fecha.
    const scheduledFor =
      campaign.scheduledFor && campaign.scheduledFor.getTime() > Date.now()
        ? campaign.scheduledFor
        : undefined;
    const links =
      texts.channel === 'email'
        ? await this.trackedLinks(tenantId, id, `${texts.bodyText}\n${texts.bodyTextEn ?? ''}`)
        : [];
    let processed = 0;
    for (const r of recipients) {
      processed += 1;
      const key = texts.channel === 'whatsapp' ? (whatsappId(r.address) ?? r.address) : r.address;
      if (already.has(key.toLowerCase())) continue;
      try {
        const who = {
          ...(r.customerId ? { customerId: r.customerId } : {}),
          ...(r.leadId ? { leadId: r.leadId } : {}),
        };
        if (texts.channel === 'whatsapp') {
          await this.deliverWhatsapp(tenantId, source, texts, r, key, allowed);
        } else {
          const english = r.english && !!texts.subjectEn && !!texts.bodyTextEn;
          const body = renderText(english ? texts.bodyTextEn! : texts.bodyText, r.scope, allowed);
          await this.communications.enqueue({
            tenantId,
            channel: 'email',
            recipient: r.address,
            subject: renderText(english ? texts.subjectEn! : texts.subject, r.scope, allowed),
            bodyText: campaignMarkupToText(body),
            bodyHtml: campaignMarkupToHtml(body, {
              brandColor: tenant.portalBrandColor,
              hrefFor: this.trackedHref(links, who),
            }),
            ...who,
            source,
            marketing: true,
            ...(scheduledFor ? { scheduledFor } : {}),
          });
        }
        already.add(key.toLowerCase());
      } catch (err) {
        this.logger.warn(
          `[campaigns] destinatario ${r.address} falló: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (processed % 100 === 0) await this.touch(tenantId, id, { sentCount: already.size });
    }

    const sent = await this.admin.communication.count({ where: { tenantId, source } });
    await this.prisma.withTenant(
      (tx) =>
        tx.campaign.updateMany({
          where: { id, status: 'sending' },
          data: scheduledFor
            ? { status: 'scheduled', sentCount: sent }
            : { status: 'sent', sentCount: sent, sentAt: new Date() },
        }),
      tenantId,
    );
    this.logger.log(`[campaigns] ${id} enviada: ${sent}/${recipients.length}`);
  }

  /**
   * Un WhatsApp con la plantilla de la campaña. Queda en Comunicaciones (con su
   * resultado) y en la conversación del número del negocio.
   */
  private async deliverWhatsapp(
    tenantId: string,
    source: string,
    texts: CampaignTexts,
    r: Recipient,
    waId: string,
    allowed: readonly string[],
  ): Promise<void> {
    const template = texts.whatsappTemplate!;
    const params = template.params.map((p) => renderText(p, r.scope, allowed));
    const res = await this.whatsapp.send({
      tenantId,
      phone: r.address,
      contactName: r.name,
      ...(r.customerId ? { customerId: r.customerId } : {}),
      ...(r.leadId ? { leadId: r.leadId } : {}),
      template,
      params,
    });
    const now = new Date();
    await this.admin.communication.create({
      data: {
        tenantId,
        channel: 'whatsapp',
        status: res.ok ? 'sent' : 'failed',
        recipient: waId,
        subject: `WhatsApp: ${template.name}`,
        bodyText: `Plantilla «${template.name}»${params.length ? `: ${params.join(' · ')}` : ''}`,
        customerId: r.customerId ?? null,
        leadId: r.leadId ?? null,
        source,
        isMarketing: true,
        provider: 'whatsapp_business',
        providerMessageId: res.ok ? res.messageId : null,
        ...(res.ok ? { sentAt: now } : { failedAt: now, errorMessage: res.error }),
      },
    });
  }

  /**
   * Retoma las campañas que llevan un rato «enviando» sin avanzar (el API se
   * reinició a medias). Cada una se reclama de forma atómica renovando su
   * `updatedAt`, así que con varias réplicas solo una la retoma.
   */
  async resumeStale(staleMinutes = 10): Promise<number> {
    const cutoff = new Date(Date.now() - staleMinutes * 60_000);
    const stale = await this.admin.campaign.findMany({
      where: { status: 'sending', updatedAt: { lt: cutoff } },
      select: { id: true, tenantId: true },
      take: 20,
    });
    let resumed = 0;
    for (const c of stale) {
      const claim = await this.admin.campaign.updateMany({
        where: { id: c.id, status: 'sending', updatedAt: { lt: cutoff } },
        data: { status: 'sending' },
      });
      if (claim.count === 0) continue;
      resumed += 1;
      this.logger.warn(`[campaigns] retomando ${c.id} (estaba atascada en «enviando»)`);
      await this.deliver(c.tenantId, c.id).catch((err: unknown) =>
        this.logger.error(`[campaigns] ${c.id} no se pudo retomar: ${String(err)}`),
      );
    }
    return resumed;
  }

  /**
   * Cancela un borrador o una campaña programada que aún no ha salido: los
   * correos encolados que no se han enviado quedan omitidos.
   */
  async cancel(tenantId: string, id: string, actor: CampaignActor): Promise<CampaignDto> {
    const campaign = await this.findOrThrow(tenantId, id, actor.scope);
    const scheduledPending =
      campaign.status === 'scheduled' &&
      !!campaign.scheduledFor &&
      campaign.scheduledFor.getTime() > Date.now();
    if (campaign.status !== 'draft' && !scheduledPending) {
      throw new ConflictException({
        code: 'campaign_not_cancellable',
        message: 'Solo se puede cancelar un borrador o una campaña programada que aún no ha salido',
      });
    }
    const claimed = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.updateMany({
          where: { id, status: campaign.status },
          data: { status: 'cancelled' },
        }),
      tenantId,
    );
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'campaign_not_cancellable',
        message: 'La campaña ha cambiado de estado; recarga la página',
      });
    }
    await this.admin.communication.updateMany({
      where: { tenantId, source: `campaign:${id}`, status: 'pending' },
      data: { status: 'skipped', errorMessage: 'Campaña cancelada' },
    });
    await this.log(tenantId, actor, 'campaign.cancelled', id, { name: campaign.name });
    return this.detail(tenantId, id, actor.scope);
  }

  private async touch(
    tenantId: string,
    id: string,
    data: { audienceCount?: number; sentCount?: number },
  ): Promise<void> {
    await this.prisma.withTenant(
      (tx) => tx.campaign.updateMany({ where: { id, status: 'sending' }, data }),
      tenantId,
    );
  }

  private async log(
    tenantId: string,
    actor: CampaignActor,
    action: string,
    entityId: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      tenantId,
      userId: actor.userId,
      action,
      entityType: 'Campaign',
      entityId,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: actor.meta.ipAddress ?? null,
      userAgent: actor.meta.userAgent ?? null,
    });
  }

  async findOrThrow(
    tenantId: string,
    id: string,
    scope: FacilityScope = null,
  ): Promise<CampaignRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.campaign.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row || !this.visible(row, scope)) {
      throw new NotFoundException({ code: 'campaign_not_found', message: 'Campaña no encontrada' });
    }
    return row;
  }
}
