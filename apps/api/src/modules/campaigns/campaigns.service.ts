import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { CommunicationsService } from '../communications/communications.service';
import { TEMPLATE_VARIABLES_BY_TRIGGER, renderTemplate } from '../communications/template-engine';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CampaignDto,
  CampaignPreviewDto,
  CampaignSegmentInput,
  CreateCampaignInput,
} from '@storageos/shared';

const MANUAL_WHITELIST = TEMPLATE_VARIABLES_BY_TRIGGER.manual;

interface Recipient {
  email: string;
  customerId?: string;
  leadId?: string;
  scope: Record<string, unknown>;
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

type CampaignRow = Prisma.CampaignGetPayload<object>;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
  ) {}

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
  // Resolución de la audiencia
  // ---------------------------------------------------------------------

  private async resolveRecipients(
    tenantId: string,
    segment: CampaignSegmentInput,
    tenantName: string,
  ): Promise<Recipient[]> {
    if (segment.audience === 'leads') {
      const where: Prisma.LeadWhereInput = {
        tenantId,
        deletedAt: null,
        email: { not: null },
        ...(segment.leadStatus ? { status: segment.leadStatus } : {}),
        ...(segment.leadSource ? { source: segment.leadSource } : {}),
      };
      const leads = await this.prisma.withTenant(
        (tx) =>
          tx.lead.findMany({
            where,
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

    // customers
    const where: Prisma.CustomerWhereInput = {
      tenantId,
      deletedAt: null,
      email: { not: null },
    };
    const activeContract: Prisma.ContractListRelationFilter = {
      some: { status: { in: ['active', 'ending'] }, deletedAt: null },
    };
    if (segment.contractStatus === 'active') where.contracts = activeContract;
    else if (segment.contractStatus === 'none')
      where.contracts = { none: { status: { in: ['active', 'ending'] }, deletedAt: null } };
    else if (segment.contractStatus === 'former')
      // Win-back: tuvieron un contrato finalizado y no tienen ninguno activo.
      where.AND = [
        { contracts: { some: { status: { in: ['ended', 'cancelled'] }, deletedAt: null } } },
        { contracts: { none: { status: { in: ['active', 'ending'] }, deletedAt: null } } },
      ];
    if (segment.overdueOnly) where.invoices = { some: { status: 'overdue' } };
    if (segment.tag && segment.tag.trim()) where.tags = { has: segment.tag.trim() };

    const customers = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where,
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

  async preview(tenantId: string, segment: CampaignSegmentInput): Promise<CampaignPreviewDto> {
    const recipients = await this.resolveRecipients(tenantId, segment, '');
    return { audienceCount: recipients.length };
  }

  async list(tenantId: string): Promise<CampaignDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.campaign.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<CampaignDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateCampaignInput;
  }): Promise<CampaignDto> {
    const { tenantId, input } = args;
    const audience = await this.preview(tenantId, input.segment);
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
            createdByUserId: args.userId,
          },
        }),
      tenantId,
    );
    return this.toDto(created);
  }

  /** Envía la campaña: encola una `communication` por destinatario (outbox). */
  async send(tenantId: string, id: string): Promise<CampaignDto> {
    const campaign = await this.findOrThrow(tenantId, id);
    if (campaign.status !== 'draft') {
      throw new ConflictException({
        code: 'campaign_not_sendable',
        message: 'Solo se puede enviar una campaña en borrador',
      });
    }
    const name = await this.tenantName(tenantId);
    const recipients = await this.resolveRecipients(
      tenantId,
      campaign.segment as CampaignSegmentInput,
      name,
    );

    await this.prisma.withTenant(
      (tx) =>
        tx.campaign.update({
          where: { id },
          data: { status: 'sending', audienceCount: recipients.length },
        }),
      tenantId,
    );

    let sent = 0;
    const scheduledFor = campaign.scheduledFor ?? undefined;
    for (const r of recipients) {
      try {
        const subject = renderTemplate(campaign.subject, r.scope, MANUAL_WHITELIST);
        const bodyText = renderTemplate(campaign.bodyText, r.scope, MANUAL_WHITELIST);
        await this.communications.enqueue({
          tenantId,
          channel: 'email',
          recipient: r.email,
          subject,
          bodyText,
          ...(r.customerId ? { customerId: r.customerId } : {}),
          ...(r.leadId ? { leadId: r.leadId } : {}),
          source: `campaign:${id}`,
          ...(scheduledFor ? { scheduledFor } : {}),
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(
          `[campaigns] destinatario ${r.email} falló: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.campaign.update({
          where: { id },
          data: { status: 'sent', sentCount: sent, sentAt: new Date() },
        }),
      tenantId,
    );
    this.logger.log(`[campaigns] ${id} enviada: ${sent}/${recipients.length}`);
    return this.toDto(updated);
  }

  private async findOrThrow(tenantId: string, id: string): Promise<CampaignRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.campaign.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'campaign_not_found', message: 'Campaña no encontrada' });
    }
    return row;
  }
}
