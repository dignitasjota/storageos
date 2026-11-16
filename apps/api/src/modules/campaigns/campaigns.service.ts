import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CAMPAIGN_TEMPLATE_VARIABLES } from '@storageos/shared';

import { type FacilityScope, assertFacilityAllowed } from '../../common/facility-scope';
import { formerCustomerWhere } from '../../common/marketing/audience';
import { buildClickToken, clickKey, extractLinks } from '../../common/marketing/click-token';
import { assertTemplateTexts } from '../../common/marketing/template-check';
import { respondThenRun } from '../../common/security/respond-then-run';
import { textToHtmlWithLinks } from '../../common/tenant-email-layout';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { renderText } from '../communications/template-engine';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  CampaignDto,
  CampaignPreviewDto,
  CampaignSegmentInput,
  CreateCampaignInput,
  UpdateCampaignInput,
} from '@storageos/shared';

interface Recipient {
  email: string;
  customerId?: string;
  leadId?: string;
  scope: Record<string, unknown>;
}

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

/** Variables que se pueden usar según a quién va la campaña. */
export function campaignVariables(segment: CampaignSegmentInput): readonly string[] {
  return CAMPAIGN_TEMPLATE_VARIABLES[segment.audience];
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
   * El HTML del correo: cada enlace muestra la dirección que escribió el
   * negocio y lleva a su versión con seguimiento. El texto plano y el
   * historial guardan la dirección original.
   */
  private trackedHtml(
    text: string,
    links: Array<{ id: string; url: string }>,
    recipient: { customerId?: string; leadId?: string },
  ): string {
    const kind = recipient.customerId ? 'c' : recipient.leadId ? 'l' : null;
    const id = recipient.customerId ?? recipient.leadId;
    const byUrl = new Map(links.map((l) => [l.url, l.id]));
    const key = clickKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    const api = this.config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    return textToHtmlWithLinks(text, (url) => {
      const linkId = byUrl.get(url);
      return linkId && kind && id
        ? `${api}/v1/public/campaign-click/${buildClickToken(key, linkId, kind, id)}`
        : url;
    });
  }

  private toDto(c: CampaignRow): CampaignDto {
    return {
      id: c.id,
      name: c.name,
      channel: c.channel,
      subject: c.subject,
      bodyText: c.bodyText,
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

  private assertTexts(subject: string, bodyText: string, segment: CampaignSegmentInput): void {
    assertTemplateTexts(
      [
        { label: 'Asunto', text: subject },
        { label: 'Mensaje', text: bodyText },
      ],
      campaignVariables(segment),
    );
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
   * Destinatarios de la campaña: cada dirección una sola vez y sin quien se
   * haya dado de baja (en cualquiera de sus fichas) ni las direcciones que
   * rebotan o marcaron spam. Con `scope`, solo los de esos locales.
   */
  private async resolveRecipients(
    tenantId: string,
    segment: CampaignSegmentInput,
    tenantName: string,
    scope: FacilityScope,
  ): Promise<Recipient[]> {
    const list =
      segment.audience === 'leads'
        ? await this.leadRecipients(tenantId, segment, tenantName, scope)
        : await this.customerRecipients(tenantId, segment, tenantName, scope);
    return this.withoutBlocked(tenantId, list);
  }

  private async leadRecipients(
    tenantId: string,
    segment: Extract<CampaignSegmentInput, { audience: 'leads' }>,
    tenantName: string,
    scope: FacilityScope,
  ): Promise<Recipient[]> {
    const and: Prisma.LeadWhereInput[] = [
      {
        deletedAt: null,
        email: { not: null },
        // Aún no son clientes: solo con consentimiento expreso y sin baja (LSSI art. 21).
        marketingConsentAt: { not: null },
        marketingOptOutAt: null,
      },
    ];
    if (segment.leadStatus) and.push({ status: segment.leadStatus });
    if (segment.leadSource) and.push({ source: segment.leadSource });
    if (segment.facilityId) and.push({ preferredFacilityId: segment.facilityId });
    // Quien solo ve unos locales escribe a los contactos de esos locales.
    if (scope) and.push({ preferredFacilityId: { in: scope } });
    const leads = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where: { AND: and },
          orderBy: { createdAt: 'asc' },
          select: { id: true, firstName: true, lastName: true, companyName: true, email: true },
        }),
      tenantId,
    );
    return leads
      .filter((l) => !!l.email)
      .map((l) => ({
        email: l.email!,
        leadId: l.id,
        scope: {
          lead: {
            firstName: l.firstName ?? '',
            displayName:
              [l.firstName, l.lastName].filter(Boolean).join(' ').trim() ||
              l.companyName ||
              'Cliente potencial',
          },
          tenant: { name: tenantName },
        },
      }));
  }

  private async customerRecipients(
    tenantId: string,
    segment: Extract<CampaignSegmentInput, { audience: 'customers' }>,
    tenantName: string,
    scope: FacilityScope,
  ): Promise<Recipient[]> {
    const and: Prisma.CustomerWhereInput[] = [
      // Clientes: mientras no se den de baja.
      { deletedAt: null, email: { not: null }, marketingOptOutAt: null },
    ];
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
          },
        }),
      tenantId,
    );
    return customers
      .filter((c) => !!c.email)
      .map((c) => ({
        email: c.email!,
        customerId: c.id,
        scope: {
          customer: {
            firstName: c.firstName ?? '',
            lastName: c.lastName ?? '',
            displayName: customerName(c),
          },
          tenant: { name: tenantName },
        },
      }));
  }

  /**
   * Una dirección una sola vez; fuera las que se dieron de baja en alguna de
   * sus fichas (dos inquilinos o un contacto con el mismo email) y las que
   * rebotan o marcaron spam.
   */
  private async withoutBlocked(tenantId: string, list: Recipient[]): Promise<Recipient[]> {
    const unique = new Map<string, Recipient>();
    for (const r of list) {
      const key = r.email.trim().toLowerCase();
      if (!unique.has(key)) unique.set(key, r);
    }
    if (unique.size === 0) return [];
    const emails = [...unique.keys()];
    const [optedCustomers, optedLeads, suppressed] = await Promise.all([
      this.admin.customer.findMany({
        where: {
          tenantId,
          deletedAt: null,
          marketingOptOutAt: { not: null },
          email: { in: emails, mode: 'insensitive' },
        },
        select: { email: true },
      }),
      this.admin.lead.findMany({
        where: {
          tenantId,
          marketingOptOutAt: { not: null },
          email: { in: emails, mode: 'insensitive' },
        },
        select: { email: true },
      }),
      this.admin.emailSuppression.findMany({
        where: { email: { in: emails }, OR: [{ tenantId }, { tenantId: null }] },
        select: { email: true },
      }),
    ]);
    for (const row of [...optedCustomers, ...optedLeads, ...suppressed]) {
      if (row.email) unique.delete(row.email.trim().toLowerCase());
    }
    return [...unique.values()];
  }

  private async tenantName(tenantId: string): Promise<string> {
    const t = await this.prisma.withTenant(
      (tx) => tx.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
      tenantId,
    );
    return t?.name ?? '';
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------

  async preview(
    tenantId: string,
    segment: CampaignSegmentInput,
    scope: FacilityScope = null,
  ): Promise<CampaignPreviewDto> {
    this.assertSegment(segment, scope);
    const recipients = await this.resolveRecipients(tenantId, segment, '', scope);
    return { audienceCount: recipients.length };
  }

  async list(tenantId: string, scope: FacilityScope = null): Promise<CampaignDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.campaign.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    return rows.filter((r) => this.visible(r, scope)).map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string, scope: FacilityScope = null): Promise<CampaignDto> {
    return this.toDto(await this.findOrThrow(tenantId, id, scope));
  }

  async create(args: {
    tenantId: string;
    actor: CampaignActor;
    input: CreateCampaignInput;
  }): Promise<CampaignDto> {
    const { tenantId, input, actor } = args;
    this.assertTexts(input.subject, input.bodyText, input.segment);
    this.assertFuture(input.scheduledFor);
    const audience = await this.preview(tenantId, input.segment, actor.scope);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.create({
          data: {
            tenantId,
            name: input.name,
            channel: 'email',
            subject: input.subject,
            bodyText: input.bodyText,
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
    await this.log(tenantId, actor, 'campaign.created', created.id, { name: created.name });
    return this.toDto(created);
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
    const subject = input.subject ?? current.subject;
    const bodyText = input.bodyText ?? current.bodyText;
    this.assertTexts(subject, bodyText, segment);
    if (input.scheduledFor !== undefined) this.assertFuture(input.scheduledFor);
    const audience = await this.preview(tenantId, segment, actor.scope);
    const claimed = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.updateMany({
          where: { id, status: 'draft' },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            subject,
            bodyText,
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
    const audience = await this.preview(tenantId, segment, actor.scope);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.create({
          data: {
            tenantId,
            name: `${source.name} (copia)`.slice(0, 120),
            channel: source.channel,
            subject: source.subject,
            bodyText: source.bodyText,
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
    return this.toDto(created);
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

  /**
   * Envía una campaña en segundo plano: reclama el borrador (→ `sending`) de
   * forma atómica —un doble clic no la envía dos veces— y responde ya. El
   * envío (resolver la audiencia y encolar un correo por destinatario) sigue
   * en `deliver`; con audiencias grandes, hacerlo dentro de la petición podía
   * cortarse a medias y dejar la campaña en «enviando».
   */
  async send(tenantId: string, id: string, actor: CampaignActor): Promise<CampaignDto> {
    const campaign = await this.findOrThrow(tenantId, id, actor.scope);
    if (campaign.status === 'draft') {
      const segment = campaign.segment as CampaignSegmentInput;
      // Un borrador de antes de esta comprobación puede tener una variable rota.
      this.assertTexts(campaign.subject, campaign.bodyText, segment);
      const recipients = await this.resolveRecipients(
        tenantId,
        segment,
        '',
        this.campaignScope(campaign),
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
        tx.campaign.updateMany({ where: { id, status: 'draft' }, data: { status: 'sending' } }),
      tenantId,
    );
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'campaign_not_sendable',
        message: 'Solo se puede enviar una campaña en borrador',
      });
    }
    await this.log(tenantId, actor, 'campaign.sent', id, {
      name: campaign.name,
      scheduledFor: campaign.scheduledFor?.toISOString() ?? null,
    });
    respondThenRun(this.logger, `campaign ${id}`, () => this.deliver(tenantId, id));
    return this.toDto(await this.findOrThrow(tenantId, id, actor.scope));
  }

  /**
   * Encola un correo por destinatario. Reanudable: si se cortó (reinicio del
   * API), al retomarla no repite a quien ya tiene su correo encolado. Va
   * renovando `updatedAt` para que el cron no la retome mientras avanza.
   */
  async deliver(tenantId: string, id: string): Promise<void> {
    const campaign = await this.findOrThrow(tenantId, id);
    if (campaign.status !== 'sending') return;
    const source = `campaign:${id}`;
    const name = await this.tenantName(tenantId);
    const segment = campaign.segment as CampaignSegmentInput;
    const allowed = campaignVariables(segment);
    const recipients = await this.resolveRecipients(
      tenantId,
      segment,
      name,
      this.campaignScope(campaign),
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
    const scheduledFor = campaign.scheduledFor ?? undefined;
    const links = await this.trackedLinks(tenantId, id, campaign.bodyText);
    let processed = 0;
    for (const r of recipients) {
      processed += 1;
      if (already.has(r.email.toLowerCase())) continue;
      try {
        const text = renderText(campaign.bodyText, r.scope, allowed);
        const who = {
          ...(r.customerId ? { customerId: r.customerId } : {}),
          ...(r.leadId ? { leadId: r.leadId } : {}),
        };
        await this.communications.enqueue({
          tenantId,
          channel: 'email',
          recipient: r.email,
          subject: renderText(campaign.subject, r.scope, allowed),
          bodyText: text,
          bodyHtml: this.trackedHtml(text, links, who),
          ...who,
          source,
          marketing: true,
          ...(scheduledFor ? { scheduledFor } : {}),
        });
        already.add(r.email.toLowerCase());
      } catch (err) {
        this.logger.warn(
          `[campaigns] destinatario ${r.email} falló: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (processed % 100 === 0) await this.touch(tenantId, id, { sentCount: already.size });
    }

    const sent = await this.admin.communication.count({ where: { tenantId, source } });
    // Programada a futuro: los correos salen en su fecha; hasta entonces queda
    // «programada» (se puede cancelar) y el cron la pasa a «enviada».
    const future = !!scheduledFor && scheduledFor.getTime() > Date.now();
    await this.prisma.withTenant(
      (tx) =>
        tx.campaign.updateMany({
          where: { id, status: 'sending' },
          data: future
            ? { status: 'scheduled', sentCount: sent }
            : { status: 'sent', sentCount: sent, sentAt: new Date() },
        }),
      tenantId,
    );
    this.logger.log(`[campaigns] ${id} enviada: ${sent}/${recipients.length}`);
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
    return this.toDto(await this.findOrThrow(tenantId, id, actor.scope));
  }

  /** Las programadas cuya fecha ya pasó pasan a «enviada» (lo llama el cron). */
  async completeScheduled(): Promise<number> {
    const now = new Date();
    const res = await this.admin.campaign.updateMany({
      where: { status: 'scheduled', scheduledFor: { lte: now } },
      data: { status: 'sent', sentAt: now },
    });
    return res.count;
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
