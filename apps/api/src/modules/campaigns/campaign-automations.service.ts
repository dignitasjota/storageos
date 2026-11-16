import { Injectable, Logger } from '@nestjs/common';
import {
  CAMPAIGN_AUTOMATION_DEFAULTS,
  CAMPAIGN_TEMPLATE_VARIABLES,
  CampaignAutomationKindEnum,
  campaignMarkupToHtml,
  campaignMarkupToText,
  type CampaignAutomationDto,
  type CampaignAutomationKind,
  type UpdateCampaignAutomationInput,
} from '@storageos/shared';

import { noDebtWhere } from '../../common/marketing/audience';
import { blockedMarketingEmails } from '../../common/marketing/opt-out';
import { assertTemplateTexts } from '../../common/marketing/template-check';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { renderText } from '../communications/template-engine';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { CampaignActor } from './campaigns.service';
import type { Prisma } from '@storageos/database';

const DAY_MS = 86_400_000;

interface Target {
  key: string;
  email: string;
  customerId?: string;
  leadId?: string;
  scope: Record<string, unknown>;
}

/** Mes y día de una fecha en una zona horaria («11-16»). */
function monthDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, month: '2-digit', day: '2-digit' }).format(
    date,
  );
}

function yearOf(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(date));
}

/**
 * Campañas automáticas del negocio, además del win-back:
 * - aniversario: el día que un inquilino con contrato en vigor cumple años con
 *   el negocio (desde su primer contrato firmado), una vez al año;
 * - contactos que no avanzan: a los que dieron su consentimiento y llevan N
 *   días sin moverse, una sola vez.
 * Opt-in por negocio; un envío por destinatario y periodo
 * (`campaign_automation_sends`).
 */
@Injectable()
export class CampaignAutomationsService {
  private readonly logger = new Logger(CampaignAutomationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<CampaignAutomationDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.campaignAutomation.findMany({ where: { tenantId } }),
      tenantId,
    );
    const since = new Date(Date.now() - 30 * DAY_MS);
    const sent = await this.prisma.withTenant(
      (tx) =>
        tx.campaignAutomationSend.groupBy({
          by: ['kind'],
          where: { sentAt: { gte: since } },
          _count: { _all: true },
        }),
      tenantId,
    );
    return CampaignAutomationKindEnum.options.map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      return {
        kind,
        enabled: row?.enabled ?? false,
        subject: row?.subject ?? null,
        bodyText: row?.bodyText ?? null,
        days: row?.days ?? CAMPAIGN_AUTOMATION_DEFAULTS[kind].days,
        sentLast30Days: sent.find((s) => s.kind === kind)?._count._all ?? 0,
      };
    });
  }

  private variables(kind: CampaignAutomationKind): readonly string[] {
    return kind === 'cold_leads'
      ? CAMPAIGN_TEMPLATE_VARIABLES.leads
      : CAMPAIGN_TEMPLATE_VARIABLES.customers;
  }

  async update(
    tenantId: string,
    kind: CampaignAutomationKind,
    input: UpdateCampaignAutomationInput,
    actor: CampaignActor,
  ): Promise<CampaignAutomationDto[]> {
    assertTemplateTexts(
      [
        { label: 'Asunto', text: input.subject },
        { label: 'Mensaje', text: input.bodyText },
      ],
      this.variables(kind),
    );
    const data = {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.subject !== undefined ? { subject: input.subject || null } : {}),
      ...(input.bodyText !== undefined ? { bodyText: input.bodyText || null } : {}),
      ...(input.days !== undefined ? { days: input.days } : {}),
    };
    await this.prisma.withTenant(
      (tx) =>
        tx.campaignAutomation.upsert({
          where: { tenantId_kind: { tenantId, kind } },
          create: {
            tenantId,
            kind,
            days: CAMPAIGN_AUTOMATION_DEFAULTS[kind].days,
            ...data,
          },
          update: data,
        }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId: actor.userId,
      action: 'campaign_automation.changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { kind, ...data } as Prisma.InputJsonValue,
      ipAddress: actor.meta.ipAddress ?? null,
      userAgent: actor.meta.userAgent ?? null,
    });
    return this.list(tenantId);
  }

  /** Ejecución diaria (cron): los negocios con alguna automática activa. */
  async runDueAll(now = new Date()): Promise<number> {
    const rows = await this.admin.campaignAutomation.findMany({
      where: { enabled: true, tenant: { deletedAt: null } },
      select: { tenantId: true, kind: true },
    });
    let sent = 0;
    for (const r of rows) {
      try {
        sent += await this.runForTenant(r.tenantId, r.kind as CampaignAutomationKind, now);
      } catch (err) {
        this.logger.warn(
          `[campaigns:auto] ${r.kind} tenant=${r.tenantId}: ${(err as Error).message}`,
        );
      }
    }
    return sent;
  }

  async runForTenant(
    tenantId: string,
    kind: CampaignAutomationKind,
    now = new Date(),
  ): Promise<number> {
    const [row, tenant] = await Promise.all([
      this.admin.campaignAutomation.findUnique({
        where: { tenantId_kind: { tenantId, kind } },
      }),
      this.admin.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, timezone: true, portalBrandColor: true },
      }),
    ]);
    if (!row?.enabled) return 0;
    const timeZone = tenant.timezone || 'Europe/Madrid';
    const targets =
      kind === 'anniversary'
        ? await this.anniversaryTargets(tenantId, tenant.name, timeZone, now)
        : await this.coldLeadTargets(tenantId, tenant.name, row.days, now);
    const period = kind === 'anniversary' ? String(yearOf(now, timeZone)) : 'once';
    const defaults = CAMPAIGN_AUTOMATION_DEFAULTS[kind];
    const allowed = this.variables(kind);
    let sent = 0;
    for (const t of targets) {
      let subject: string;
      let body: string;
      try {
        subject = renderText(row.subject || defaults.subject, t.scope, allowed);
        body = renderText(row.bodyText || defaults.bodyText, t.scope, allowed);
      } catch (err) {
        this.logger.warn(
          `[campaigns:auto] el texto no se puede preparar: ${(err as Error).message}`,
        );
        return sent;
      }
      let reservedId: string;
      try {
        reservedId = (
          await this.prisma.withTenant(
            (tx) =>
              tx.campaignAutomationSend.create({
                data: { tenantId, kind, recipientKey: t.key, period },
              }),
            tenantId,
          )
        ).id;
      } catch {
        continue; // ya enviado en este periodo
      }
      try {
        await this.communications.enqueue({
          tenantId,
          channel: 'email',
          recipient: t.email,
          subject,
          bodyText: campaignMarkupToText(body),
          bodyHtml: campaignMarkupToHtml(body, { brandColor: tenant.portalBrandColor }),
          ...(t.customerId ? { customerId: t.customerId } : {}),
          ...(t.leadId ? { leadId: t.leadId } : {}),
          source: `campaign_auto.${kind}`,
          marketing: true,
        });
        sent += 1;
      } catch (err) {
        await this.prisma
          .withTenant(
            (tx) => tx.campaignAutomationSend.deleteMany({ where: { id: reservedId } }),
            tenantId,
          )
          .catch(() => undefined);
        this.logger.warn(`[campaigns:auto] ${t.email}: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  /** Inquilinos con contrato en vigor que hoy cumplen años con el negocio. */
  private async anniversaryTargets(
    tenantId: string,
    tenantName: string,
    timeZone: string,
    now: Date,
  ): Promise<Target[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: {
            AND: [
              {
                deletedAt: null,
                email: { not: null },
                marketingOptOutAt: null,
                contracts: { some: { status: { in: ['active', 'ending'] }, deletedAt: null } },
              },
              noDebtWhere(now),
            ],
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
            email: true,
            contracts: {
              where: { deletedAt: null, signedAt: { not: null } },
              orderBy: { signedAt: 'asc' },
              take: 1,
              select: { signedAt: true },
            },
          },
        }),
      tenantId,
    );
    const today = monthDay(now, timeZone);
    const year = yearOf(now, timeZone);
    const due = rows.filter((c) => {
      const first = c.contracts[0]?.signedAt;
      return !!first && monthDay(first, timeZone) === today && yearOf(first, timeZone) < year;
    });
    return this.filterBlocked(
      tenantId,
      due.map((c) => {
        const displayName =
          c.customerType === 'business'
            ? (c.companyName ?? 'Cliente')
            : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
        return {
          key: `c:${c.id}`,
          email: c.email!,
          customerId: c.id,
          scope: {
            customer: { firstName: c.firstName ?? '', lastName: c.lastName ?? '', displayName },
            tenant: { name: tenantName },
          },
        };
      }),
    );
  }

  /** Contactos con consentimiento que llevan `days` días sin moverse. */
  private async coldLeadTargets(
    tenantId: string,
    tenantName: string,
    days: number,
    now: Date,
  ): Promise<Target[]> {
    const before = new Date(now.getTime() - days * DAY_MS);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where: {
            deletedAt: null,
            email: { not: null },
            marketingConsentAt: { not: null },
            marketingOptOutAt: null,
            status: { in: ['new', 'contacted', 'qualified'] },
            createdAt: { lte: before },
            updatedAt: { lte: before },
          },
          select: { id: true, firstName: true, lastName: true, companyName: true, email: true },
        }),
      tenantId,
    );
    return this.filterBlocked(
      tenantId,
      rows.map((l) => ({
        key: `l:${l.id}`,
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
      })),
    );
  }

  /** Una dirección una vez y sin las que se dieron de baja, rebotan o marcaron spam. */
  private async filterBlocked(tenantId: string, list: Target[]): Promise<Target[]> {
    const unique = new Map<string, Target>();
    for (const t of list) {
      const key = t.email.trim().toLowerCase();
      if (!unique.has(key)) unique.set(key, t);
    }
    const blocked = await blockedMarketingEmails(this.admin, tenantId, [...unique.keys()]);
    for (const email of blocked) unique.delete(email);
    return [...unique.values()];
  }
}
