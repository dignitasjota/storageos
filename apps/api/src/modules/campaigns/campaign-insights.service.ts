import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import {
  CAMPAIGN_SAVED_TEMPLATE_VARIABLES,
  campaignMarkupToHtml,
  campaignMarkupToText,
  campaignTemplateVariables,
} from '@storageos/shared';

import { type FacilityScope } from '../../common/facility-scope';
import { clickKey, parseClickToken } from '../../common/marketing/click-token';
import { assertTemplateTexts } from '../../common/marketing/template-check';
import { tenantEmailShell } from '../../common/tenant-email-layout';
import { AuditService } from '../auth/audit.service';
import { renderText } from '../communications/template-engine';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';

import { CampaignsService, type CampaignActor } from './campaigns.service';

import type { Env } from '../../config/env.schema';
import type {
  CampaignConversionsDto,
  CampaignEmailPreviewDto,
  CampaignEmailPreviewInput,
  CampaignRecipientDto,
  CampaignRecipientFilter,
  CampaignResultsDto,
  CampaignSavedSegmentDto,
  CampaignSegmentInput,
  CampaignTestSendInput,
  CampaignTestSendResultDto,
  SaveCampaignSegmentInput,
  CampaignTemplateDto,
  CreateCampaignTemplateInput,
  UpdateCampaignTemplateInput,
} from '@storageos/shared';

/** Días tras el envío en que un contrato o un contacto ganado cuenta para la campaña. */
const CONVERSION_WINDOW_DAYS = 30;
/** Días antes de la limpieza de envíos en que se guardan los resultados. */
const SNAPSHOT_MARGIN_DAYS = 14;
const DAY_MS = 86_400_000;

function templateDto(t: {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  updatedAt: Date;
}): CampaignTemplateDto {
  return {
    id: t.id,
    name: t.name,
    subject: t.subject,
    bodyText: t.bodyText,
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Resultados de las campañas, plantillas, vista previa y registro de clics. */
@Injectable()
export class CampaignInsightsService {
  private readonly logger = new Logger(CampaignInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
    private readonly campaigns: CampaignsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async results(
    tenantId: string,
    campaignId: string,
    scope: FacilityScope = null,
  ): Promise<CampaignResultsDto> {
    const campaign = await this.campaigns.findOrThrow(tenantId, campaignId, scope);
    const live = await this.computeResults(tenantId, campaignId, campaign);
    // Pasados los días de conservación, la limpieza borra los envíos: quedan
    // los resultados que se guardaron antes.
    const snapshot = campaign.resultsSnapshot as CampaignResultsDto | null;
    if (snapshot && live.recipients < snapshot.recipients) return snapshot;
    return live;
  }

  private async computeResults(
    tenantId: string,
    campaignId: string,
    campaign: { sentAt: Date | null; createdAt: Date; couponCode?: string | null },
  ): Promise<CampaignResultsDto> {
    return this.prisma.withTenant(async (tx) => {
      const source = `campaign:${campaignId}`;
      const comms = await tx.communication.findMany({
        where: { source },
        select: { status: true, customerId: true, leadId: true, createdAt: true },
      });
      const count = (statuses: string[]) => comms.filter((c) => statuses.includes(c.status)).length;
      const sent = count(['sent', 'delivered', 'bounced']);
      const since = campaign.sentAt ?? campaign.createdAt;
      const [unsubscribed, links, clicks] = await Promise.all([
        this.unsubscribedBy(tx, comms, since),
        tx.campaignLink.findMany({
          where: { campaignId },
          orderBy: { position: 'asc' },
          select: { url: true, _count: { select: { clicks: true } } },
        }),
        tx.campaignClick.findMany({ where: { campaignId }, select: { recipientKey: true } }),
      ]);
      const clickers = new Set(clicks.map((c) => c.recipientKey)).size;
      const conversions = await this.conversions(tx, comms, since, campaign.couponCode ?? null);
      return {
        campaignId,
        conversions,
        recipients: comms.length,
        sent,
        delivered: count(['delivered']),
        bounced: count(['bounced']),
        failed: count(['failed']),
        skipped: count(['skipped']),
        unsubscribed,
        clickers,
        clickRate: sent ? Math.round((clickers / sent) * 1000) / 10 : null,
        links: links.map((l) => ({ url: l.url, clicks: l._count.clicks })),
      };
    }, tenantId);
  }

  /**
   * Bajas que vienen de esta campaña: quien se dio de baja después de
   * recibirla y sin haber recibido otra comercial entre medias (antes se
   * contaba la misma baja en todas las campañas anteriores).
   */
  private async unsubscribedBy(
    tx: Prisma.TransactionClient,
    comms: Array<{ customerId: string | null; leadId: string | null; createdAt: Date }>,
    since: Date,
  ): Promise<number> {
    return (await this.unsubscribedIds(tx, comms, since)).length;
  }

  /** Contratos firmados, contactos ganados y usos del cupón tras la campaña. */
  private async conversions(
    tx: Prisma.TransactionClient,
    comms: Array<{ customerId: string | null; leadId: string | null }>,
    since: Date,
    couponCode: string | null,
  ): Promise<CampaignConversionsDto> {
    const until = new Date(since.getTime() + CONVERSION_WINDOW_DAYS * DAY_MS);
    const customerIds = [
      ...new Set(comms.map((c) => c.customerId).filter((v): v is string => !!v)),
    ];
    const leadIds = [...new Set(comms.map((c) => c.leadId).filter((v): v is string => !!v))];
    const [contracts, leadsWon, coupon] = await Promise.all([
      customerIds.length
        ? tx.contract.findMany({
            where: {
              customerId: { in: customerIds },
              deletedAt: null,
              signedAt: { gte: since, lte: until },
            },
            select: { priceMonthly: true },
          })
        : [],
      leadIds.length
        ? tx.lead.count({ where: { id: { in: leadIds }, wonAt: { gte: since, lte: until } } })
        : 0,
      couponCode
        ? tx.coupon.findFirst({ where: { code: couponCode }, select: { id: true } })
        : null,
    ]);
    const couponUses =
      coupon && customerIds.length
        ? await tx.couponRedemption.count({
            where: {
              couponId: coupon.id,
              customerId: { in: customerIds },
              createdAt: { gte: since, lte: until },
            },
          })
        : 0;
    return {
      windowDays: CONVERSION_WINDOW_DAYS,
      contracts: contracts.length,
      monthlyRevenue:
        Math.round(contracts.reduce((sum, k) => sum + Number(k.priceMonthly), 0) * 100) / 100,
      leadsWon,
      couponUses,
    };
  }

  /** Quiénes se dieron de baja por esta campaña (ver `unsubscribedBy`). */
  private async unsubscribedIds(
    tx: Prisma.TransactionClient,
    comms: Array<{ customerId: string | null; leadId: string | null; createdAt: Date }>,
    since: Date,
  ): Promise<string[]> {
    const customerIds = comms.map((c) => c.customerId).filter((v): v is string => !!v);
    const leadIds = comms.map((c) => c.leadId).filter((v): v is string => !!v);
    const [customers, leads] = await Promise.all([
      customerIds.length
        ? tx.customer.findMany({
            where: { id: { in: customerIds }, marketingOptOutAt: { gte: since } },
            select: { id: true, marketingOptOutAt: true },
          })
        : [],
      leadIds.length
        ? tx.lead.findMany({
            where: { id: { in: leadIds }, marketingOptOutAt: { gte: since } },
            select: { id: true, marketingOptOutAt: true },
          })
        : [],
    ]);
    if (customers.length === 0 && leads.length === 0) return [];
    const mine = new Map<string, Date>();
    for (const c of comms) mine.set((c.customerId ?? c.leadId)!, c.createdAt);
    const others = await tx.communication.findMany({
      where: {
        isMarketing: true,
        createdAt: { gt: since },
        OR: [
          ...(customers.length ? [{ customerId: { in: customers.map((c) => c.id) } }] : []),
          ...(leads.length ? [{ leadId: { in: leads.map((l) => l.id) } }] : []),
        ],
      },
      select: { customerId: true, leadId: true, createdAt: true },
    });
    const later = (id: string, received: Date, optOut: Date) =>
      others.some(
        (o) => (o.customerId ?? o.leadId) === id && o.createdAt > received && o.createdAt <= optOut,
      );
    return [...customers, ...leads]
      .filter((p) => {
        const received = mine.get(p.id);
        return !!received && !!p.marketingOptOutAt && !later(p.id, received, p.marketingOptOutAt);
      })
      .map((p) => p.id);
  }

  /**
   * Guarda los resultados de las campañas cuyos envíos va a borrar pronto la
   * limpieza (lo llama un cron diario).
   */
  async snapshotOld(): Promise<number> {
    const keepDays = this.config.get('RETENTION_COMMUNICATIONS_DAYS', { infer: true });
    const before = new Date(Date.now() - Math.max(keepDays - SNAPSHOT_MARGIN_DAYS, 1) * DAY_MS);
    const due = await this.admin.campaign.findMany({
      where: {
        status: 'sent',
        sentAt: { lt: before },
        resultsSnapshot: { equals: Prisma.AnyNull },
      },
      select: { id: true, tenantId: true, sentAt: true, createdAt: true, couponCode: true },
      take: 50,
    });
    for (const c of due) {
      try {
        const results = await this.computeResults(c.tenantId, c.id, c);
        await this.admin.campaign.update({
          where: { id: c.id },
          data: { resultsSnapshot: results as unknown as Prisma.InputJsonValue },
        });
      } catch (err) {
        this.logger.warn(`[campaigns] resultados de ${c.id}: ${(err as Error).message}`);
      }
    }
    return due.length;
  }

  /**
   * Clic en un enlace con seguimiento: lo cuenta (uno por destinatario) y
   * devuelve a dónde redirigir. Un token inválido no redirige a ningún sitio.
   */
  async recordClick(token: string): Promise<string | null> {
    const parsed = parseClickToken(
      clickKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true })),
      token,
    );
    if (!parsed) return null;
    const link = await this.admin.campaignLink.findUnique({
      where: { id: parsed.linkId },
      select: { id: true, url: true, tenantId: true, campaignId: true },
    });
    if (!link) return null;
    await this.admin.campaignClick.createMany({
      data: [
        {
          tenantId: link.tenantId,
          campaignId: link.campaignId,
          linkId: link.id,
          recipientKey: parsed.recipientKey,
        },
      ],
      skipDuplicates: true,
    });
    return link.url;
  }

  // --- Plantillas ------------------------------------------------------------

  async listTemplates(tenantId: string): Promise<CampaignTemplateDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.campaignTemplate.findMany({ orderBy: { name: 'asc' } }),
      tenantId,
    );
    return rows.map(templateDto);
  }

  async createTemplate(
    tenantId: string,
    input: CreateCampaignTemplateInput,
    actor: CampaignActor,
  ): Promise<CampaignTemplateDto> {
    this.assertTemplate(input.subject, input.bodyText);
    const row = await this.prisma.withTenant(async (tx) => {
      await this.assertFreeName(tx, input.name);
      return tx.campaignTemplate.create({ data: { tenantId, ...input } });
    }, tenantId);
    await this.log(tenantId, actor, 'campaign_template.created', row.id, { name: row.name });
    return templateDto(row);
  }

  async updateTemplate(
    tenantId: string,
    id: string,
    input: UpdateCampaignTemplateInput,
    actor: CampaignActor,
  ): Promise<CampaignTemplateDto> {
    this.assertTemplate(input.subject, input.bodyText);
    const row = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.campaignTemplate.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw this.templateNotFound();
      if (input.name !== undefined) await this.assertFreeName(tx, input.name, id);
      return tx.campaignTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
        },
      });
    }, tenantId);
    await this.log(tenantId, actor, 'campaign_template.updated', id, { name: row.name });
    return templateDto(row);
  }

  async removeTemplate(tenantId: string, id: string, actor: CampaignActor): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.campaignTemplate.deleteMany({ where: { id } });
      if (count === 0) throw this.templateNotFound();
    }, tenantId);
    await this.log(tenantId, actor, 'campaign_template.deleted', id, {});
  }

  private assertTemplate(subject?: string, bodyText?: string): void {
    assertTemplateTexts(
      [
        { label: 'Asunto', text: subject },
        { label: 'Mensaje', text: bodyText },
      ],
      CAMPAIGN_SAVED_TEMPLATE_VARIABLES,
    );
  }

  private async assertFreeName(
    tx: Prisma.TransactionClient,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const taken = await tx.campaignTemplate.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        code: 'campaign_template_name_taken',
        message: 'Ya hay una plantilla con ese nombre',
      });
    }
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
      entityType: 'CampaignTemplate',
      entityId,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: actor.meta.ipAddress ?? null,
      userAgent: actor.meta.userAgent ?? null,
    });
  }

  /** El correo de ejemplo (Lucía Martín) con la marca del negocio y el formato. */
  private async renderSample(
    tenantId: string,
    input: {
      subject: string;
      bodyText: string;
      audience: 'customers' | 'leads';
      couponCode?: string | undefined;
    },
  ): Promise<{ subject: string; html: string; text: string }> {
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, portalBrandColor: true, portalLogoUrl: true },
    });
    const coupon = input.couponCode?.trim() || null;
    const sample =
      input.audience === 'leads'
        ? { lead: { firstName: 'Lucía', displayName: 'Lucía Martín' } }
        : {
            customer: { firstName: 'Lucía', lastName: 'Martín', displayName: 'Lucía Martín' },
          };
    const allowed = campaignTemplateVariables(input.audience, !!coupon);
    assertTemplateTexts(
      [
        { label: 'Asunto', text: input.subject },
        { label: 'Mensaje', text: input.bodyText },
      ],
      allowed,
    );
    const scope = {
      ...sample,
      tenant: { name: tenant.name },
      ...(coupon ? { coupon: { code: coupon.toUpperCase() } } : {}),
    };
    const subject = renderText(input.subject, scope, allowed);
    const body = renderText(input.bodyText, scope, allowed);
    const html = tenantEmailShell(
      { name: tenant.name, logoUrl: tenant.portalLogoUrl, brandColor: tenant.portalBrandColor },
      campaignMarkupToHtml(body, { brandColor: tenant.portalBrandColor }),
    );
    return { subject, html, text: campaignMarkupToText(body) };
  }

  /** Cómo le llegará el correo a un destinatario de ejemplo, con la marca del tenant. */
  async previewEmail(
    tenantId: string,
    input: CampaignEmailPreviewInput,
  ): Promise<CampaignEmailPreviewDto> {
    const { subject, html } = await this.renderSample(tenantId, input);
    return { subject, html };
  }

  /** Se envía el correo de ejemplo a uno mismo (no cuenta como campaña). */
  async testSend(
    tenantId: string,
    userId: string,
    input: CampaignTestSendInput,
  ): Promise<CampaignTestSendResultDto> {
    const user = await this.admin.user.findFirstOrThrow({
      where: { id: userId, tenantId },
      select: { email: true },
    });
    const { subject, html, text } = await this.renderSample(tenantId, input);
    const res = await this.email.sendRendered({
      tenantId,
      to: user.email,
      subject: `[Prueba] ${subject}`,
      html,
      text,
    });
    if (res.suppressed) {
      throw new BadRequestException({
        code: 'test_email_blocked',
        message: `No se pudo enviar a ${user.email}: ${res.suppressed}`,
      });
    }
    return { sentTo: user.email };
  }

  // --- Segmentos guardados ----------------------------------------------------

  async listSegments(tenantId: string): Promise<CampaignSavedSegmentDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.campaignSegment.findMany({ orderBy: { name: 'asc' } }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      segment: r.segment as CampaignSegmentInput,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async saveSegment(
    tenantId: string,
    input: SaveCampaignSegmentInput,
    actor: CampaignActor,
  ): Promise<CampaignSavedSegmentDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      const taken = await tx.campaignSegment.findFirst({
        where: { name: { equals: input.name.trim(), mode: 'insensitive' } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException({
          code: 'campaign_segment_name_taken',
          message: 'Ya hay un segmento con ese nombre',
        });
      }
      return tx.campaignSegment.create({
        data: {
          tenantId,
          name: input.name.trim(),
          segment: input.segment as Prisma.InputJsonValue,
          createdByUserId: actor.userId,
        },
      });
    }, tenantId);
    return {
      id: row.id,
      name: row.name,
      segment: row.segment as CampaignSegmentInput,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async removeSegment(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.campaignSegment.deleteMany({ where: { id } });
      if (count === 0) {
        throw new NotFoundException({
          code: 'campaign_segment_not_found',
          message: 'Segmento no encontrado',
        });
      }
    }, tenantId);
  }

  // --- Quién la recibió --------------------------------------------------------

  /** Destinatarios de una campaña según qué pasó (pulsaron, rebotaron, se dieron de baja…). */
  async recipients(
    tenantId: string,
    campaignId: string,
    filter: CampaignRecipientFilter,
    scope: FacilityScope = null,
  ): Promise<CampaignRecipientDto[]> {
    const campaign = await this.campaigns.findOrThrow(tenantId, campaignId, scope);
    return this.prisma.withTenant(async (tx) => {
      const comms = await tx.communication.findMany({
        where: { source: `campaign:${campaignId}` },
        select: {
          recipient: true,
          status: true,
          errorMessage: true,
          customerId: true,
          leadId: true,
          createdAt: true,
          customer: {
            select: { customerType: true, firstName: true, lastName: true, companyName: true },
          },
          lead: { select: { firstName: true, lastName: true, companyName: true } },
        },
        take: 5000,
      });
      const row = (c: (typeof comms)[number], detail: string | null): CampaignRecipientDto => ({
        recipient: c.recipient,
        name: c.customer
          ? c.customer.customerType === 'business'
            ? (c.customer.companyName ?? null)
            : [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ') || null
          : c.lead
            ? [c.lead.firstName, c.lead.lastName].filter(Boolean).join(' ') ||
              c.lead.companyName ||
              null
            : null,
        customerId: c.customerId,
        leadId: c.leadId,
        detail,
      });
      const since = campaign.sentAt ?? campaign.createdAt;
      if (filter === 'bounced' || filter === 'failed') {
        const statuses = filter === 'bounced' ? ['bounced'] : ['failed', 'skipped'];
        return comms.filter((c) => statuses.includes(c.status)).map((c) => row(c, c.errorMessage));
      }
      if (filter === 'clicked') {
        const clicks = await tx.campaignClick.findMany({
          where: { campaignId },
          select: { recipientKey: true },
        });
        const keys = new Set(clicks.map((c) => c.recipientKey));
        return comms
          .filter((c) =>
            keys.has(c.customerId ? `c:${c.customerId}` : c.leadId ? `l:${c.leadId}` : ''),
          )
          .map((c) => row(c, null));
      }
      if (filter === 'unsubscribed') {
        const ids = new Set(await this.unsubscribedIds(tx, comms, since));
        return comms
          .filter((c) => ids.has(c.customerId ?? c.leadId ?? ''))
          .map((c) => row(c, null));
      }
      // Firmaron un contrato o pasaron a ganados después.
      const until = new Date(since.getTime() + CONVERSION_WINDOW_DAYS * DAY_MS);
      const customerIds = comms.map((c) => c.customerId).filter((v): v is string => !!v);
      const leadIds = comms.map((c) => c.leadId).filter((v): v is string => !!v);
      const [contracts, won] = await Promise.all([
        customerIds.length
          ? tx.contract.findMany({
              where: {
                customerId: { in: customerIds },
                deletedAt: null,
                signedAt: { gte: since, lte: until },
              },
              select: { customerId: true, contractNumber: true },
            })
          : [],
        leadIds.length
          ? tx.lead.findMany({
              where: { id: { in: leadIds }, wonAt: { gte: since, lte: until } },
              select: { id: true },
            })
          : [],
      ]);
      const contractOf = new Map(contracts.map((k) => [k.customerId, k.contractNumber]));
      const wonIds = new Set(won.map((l) => l.id));
      return comms
        .filter(
          (c) =>
            (c.customerId && contractOf.has(c.customerId)) || (c.leadId && wonIds.has(c.leadId)),
        )
        .map((c) =>
          row(
            c,
            c.customerId && contractOf.has(c.customerId)
              ? `Firmó el contrato ${contractOf.get(c.customerId)}`
              : 'Pasó a ganado',
          ),
        );
    }, tenantId);
  }

  private templateNotFound() {
    return new NotFoundException({
      code: 'campaign_template_not_found',
      message: 'Plantilla no encontrada',
    });
  }
}
