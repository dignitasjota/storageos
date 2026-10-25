import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { clickKey, parseClickToken } from '../../common/marketing/click-token';
import { tenantEmailShell, textToHtml } from '../../common/tenant-email-layout';
import { TEMPLATE_VARIABLES_BY_TRIGGER, renderText } from '../communications/template-engine';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';
import type {
  CampaignEmailPreviewDto,
  CampaignEmailPreviewInput,
  CampaignResultsDto,
  CampaignTemplateDto,
  CreateCampaignTemplateInput,
  UpdateCampaignTemplateInput,
} from '@storageos/shared';

const MANUAL_WHITELIST = TEMPLATE_VARIABLES_BY_TRIGGER.manual;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async results(tenantId: string, campaignId: string): Promise<CampaignResultsDto> {
    return this.prisma.withTenant(async (tx) => {
      const campaign = await tx.campaign.findFirst({
        where: { id: campaignId },
        select: { id: true, sentAt: true, createdAt: true },
      });
      if (!campaign) {
        throw new NotFoundException({
          code: 'campaign_not_found',
          message: 'Campaña no encontrada',
        });
      }
      const source = `campaign:${campaignId}`;
      const comms = await tx.communication.findMany({
        where: { source },
        select: { status: true, customerId: true, leadId: true, createdAt: true },
      });
      const count = (statuses: string[]) => comms.filter((c) => statuses.includes(c.status)).length;
      const sent = count(['sent', 'delivered', 'bounced']);
      const since = campaign.sentAt ?? campaign.createdAt;
      const customerIds = comms.map((c) => c.customerId).filter((v): v is string => !!v);
      const leadIds = comms.map((c) => c.leadId).filter((v): v is string => !!v);
      const [unsubCustomers, unsubLeads, links, clicks] = await Promise.all([
        customerIds.length
          ? tx.customer.count({
              where: { id: { in: customerIds }, marketingOptOutAt: { gte: since } },
            })
          : 0,
        leadIds.length
          ? tx.lead.count({ where: { id: { in: leadIds }, marketingOptOutAt: { gte: since } } })
          : 0,
        tx.campaignLink.findMany({
          where: { campaignId },
          orderBy: { position: 'asc' },
          select: { url: true, _count: { select: { clicks: true } } },
        }),
        tx.campaignClick.findMany({ where: { campaignId }, select: { recipientKey: true } }),
      ]);
      const clickers = new Set(clicks.map((c) => c.recipientKey)).size;
      return {
        campaignId,
        recipients: comms.length,
        sent,
        delivered: count(['delivered']),
        bounced: count(['bounced']),
        failed: count(['failed']),
        skipped: count(['skipped']),
        unsubscribed: unsubCustomers + unsubLeads,
        clickers,
        clickRate: sent ? Math.round((clickers / sent) * 1000) / 10 : null,
        links: links.map((l) => ({ url: l.url, clicks: l._count.clicks })),
      };
    }, tenantId);
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
  ): Promise<CampaignTemplateDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.campaignTemplate.create({ data: { tenantId, ...input } }),
      tenantId,
    );
    return templateDto(row);
  }

  async updateTemplate(
    tenantId: string,
    id: string,
    input: UpdateCampaignTemplateInput,
  ): Promise<CampaignTemplateDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.campaignTemplate.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw this.templateNotFound();
      return tx.campaignTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
        },
      });
    }, tenantId);
    return templateDto(row);
  }

  async removeTemplate(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.campaignTemplate.deleteMany({ where: { id } });
      if (count === 0) throw this.templateNotFound();
    }, tenantId);
  }

  /** Cómo le llegará el correo a un destinatario de ejemplo, con la marca del tenant. */
  async previewEmail(
    tenantId: string,
    input: CampaignEmailPreviewInput,
  ): Promise<CampaignEmailPreviewDto> {
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, portalBrandColor: true, portalLogoUrl: true },
    });
    const sample =
      input.audience === 'leads'
        ? { lead: { firstName: 'Lucía', displayName: 'Lucía Martín' } }
        : {
            customer: { firstName: 'Lucía', lastName: 'Martín', displayName: 'Lucía Martín' },
          };
    const scope = { ...sample, tenant: { name: tenant.name } };
    const subject = renderText(input.subject, scope, MANUAL_WHITELIST);
    const text = renderText(input.bodyText, scope, MANUAL_WHITELIST);
    const html = tenantEmailShell(
      { name: tenant.name, logoUrl: tenant.portalLogoUrl, brandColor: tenant.portalBrandColor },
      textToHtml(text),
    );
    return { subject, html };
  }

  private templateNotFound() {
    return new NotFoundException({
      code: 'campaign_template_not_found',
      message: 'Plantilla no encontrada',
    });
  }
}
