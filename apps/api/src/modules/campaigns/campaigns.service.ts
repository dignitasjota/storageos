import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { respondThenRun } from '../../common/security/respond-then-run';
import { CommunicationsService } from '../communications/communications.service';
import { TEMPLATE_VARIABLES_BY_TRIGGER, renderText } from '../communications/template-engine';
import { PrismaAdminService } from '../database/prisma-admin.service';
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
    private readonly admin: PrismaAdminService,
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
        // Aún no son clientes: solo con consentimiento expreso y sin baja (LSSI art. 21).
        marketingConsentAt: { not: null },
        marketingOptOutAt: null,
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
      // Clientes: mientras no se den de baja.
      marketingOptOutAt: null,
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
  /**
   * Envía una campaña en segundo plano: reclama el borrador (→ `sending`) de
   * forma atómica —un doble clic no la envía dos veces— y responde ya. El
   * envío (resolver la audiencia y encolar un correo por destinatario) sigue
   * en `deliver`; con audiencias grandes, hacerlo dentro de la petición podía
   * cortarse a medias y dejar la campaña en «enviando».
   */
  async send(tenantId: string, id: string): Promise<CampaignDto> {
    await this.findOrThrow(tenantId, id);
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
    respondThenRun(this.logger, `campaign ${id}`, () => this.deliver(tenantId, id));
    return this.toDto(await this.findOrThrow(tenantId, id));
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
    const recipients = await this.resolveRecipients(
      tenantId,
      campaign.segment as CampaignSegmentInput,
      name,
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
    let processed = 0;
    for (const r of recipients) {
      processed += 1;
      if (already.has(r.email.toLowerCase())) continue;
      try {
        await this.communications.enqueue({
          tenantId,
          channel: 'email',
          recipient: r.email,
          subject: renderText(campaign.subject, r.scope, MANUAL_WHITELIST),
          bodyText: renderText(campaign.bodyText, r.scope, MANUAL_WHITELIST),
          ...(r.customerId ? { customerId: r.customerId } : {}),
          ...(r.leadId ? { leadId: r.leadId } : {}),
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
    await this.prisma.withTenant(
      (tx) =>
        tx.campaign.updateMany({
          where: { id, status: 'sending' },
          data: { status: 'sent', sentCount: sent, sentAt: new Date() },
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
