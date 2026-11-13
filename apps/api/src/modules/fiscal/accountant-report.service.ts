import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ACCOUNTANT_REPORT_LINK_DAYS,
  accountantReportKey,
  buildAccountantReportToken,
} from '../../common/accountant-report-token';
import { todayInTimezone } from '../../common/format';
import { escapeHtml, tenantEmailShell } from '../../common/tenant-email-layout';
import { AuditService } from '../auth/audit.service';
import { AccountantExportService } from '../billing-saas/accountant-export.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { FilesService } from '../files/files.service';

import type { Env } from '../../config/env.schema';
import type {
  AccountantReportFrequency,
  AccountantSendResultDto,
  AccountantSettingsDto,
  UpdateAccountantSettingsInput,
} from '@storageos/shared';

interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const QUARTERS = ['primer', 'segundo', 'tercer', 'cuarto'];

/** Día del mes desde el que sale el envío automático (da tiempo a cerrar el periodo). */
export const ACCOUNTANT_REPORT_DAY = 5;

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const ddmmyyyy = (s: string): string => s.split('-').reverse().join('/');

export interface AccountantPeriod {
  /** «2026-10» (mes) o «2026-T3» (trimestre). */
  key: string;
  from: string;
  to: string;
  label: string;
}

/**
 * Periodo que toca enviar hoy: el mes o el trimestre anterior, solo desde el
 * día 5 y dentro del mes siguiente a que termine (si se pasa, no se recupera).
 */
export function duePeriod(
  frequency: AccountantReportFrequency,
  today: Date,
): AccountantPeriod | null {
  if (frequency === 'off' || today.getUTCDate() < ACCOUNTANT_REPORT_DAY) return null;
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  if (frequency === 'monthly') {
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0));
    return {
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      from: iso(start),
      to: iso(end),
      label: `${MONTHS[start.getUTCMonth()]} de ${start.getUTCFullYear()}`,
    };
  }
  if (m % 3 !== 0) return null; // solo en el primer mes del trimestre siguiente
  const start = new Date(Date.UTC(y, m - 3, 1));
  const end = new Date(Date.UTC(y, m, 0));
  const q = Math.floor(start.getUTCMonth() / 3);
  return {
    key: `${start.getUTCFullYear()}-T${q + 1}`,
    from: iso(start),
    to: iso(end),
    label: `${QUARTERS[q]} trimestre de ${start.getUTCFullYear()}`,
  };
}

/**
 * Envío a la asesoría: el mismo Excel que se descarga en Fiscalidad
 * (facturas, cobros, fianzas y gastos), por correo con un enlace de 60 días.
 */
@Injectable()
export class AccountantReportService {
  private readonly logger = new Logger(AccountantReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly exporter: AccountantExportService,
    private readonly files: FilesService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getSettings(tenantId: string): Promise<AccountantSettingsDto> {
    const t = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            accountantEmail: true,
            accountantReportFrequency: true,
            accountantReportLastPeriod: true,
          },
        }),
      tenantId,
    );
    return {
      email: t.accountantEmail,
      frequency: t.accountantReportFrequency as AccountantReportFrequency,
      lastPeriod: t.accountantReportLastPeriod,
    };
  }

  async updateSettings(
    tenantId: string,
    userId: string,
    input: UpdateAccountantSettingsInput,
    meta: RequestMeta,
  ): Promise<AccountantSettingsDto> {
    const email = input.email.trim().toLowerCase() || null;
    if (input.frequency !== 'off' && !email) {
      throw new BadRequestException({
        code: 'accountant_email_required',
        message: 'Indica el email de la asesoría para enviárselo',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.tenant.update({
          where: { id: tenantId },
          data: { accountantEmail: email, accountantReportFrequency: input.frequency },
        }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'fiscal.accountant_settings_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { email, frequency: input.frequency },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.getSettings(tenantId);
  }

  /** Envía ahora el Excel de un periodo a la asesoría. */
  async send(
    tenantId: string,
    from: string,
    to: string,
    label?: string,
  ): Promise<AccountantSendResultDto> {
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        name: true,
        accountantEmail: true,
        portalBrandColor: true,
        portalLogoUrl: true,
      },
    });
    if (!tenant.accountantEmail) {
      throw new BadRequestException({
        code: 'accountant_email_required',
        message: 'Indica el email de la asesoría en Fiscalidad → Asesoría',
      });
    }
    const dto = await this.exporter.buildForTenant(tenantId, from, to);
    const buffer = await this.exporter.toXlsx(dto, true);
    const fileName = `asesoria-${from}-a-${to}-${randomUUID().slice(0, 8)}.xlsx`;
    await this.files.putObject({
      bucket: 'reports',
      key: `${tenantId}/accountant/${fileName}`,
      body: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const expiresAt = new Date(Date.now() + ACCOUNTANT_REPORT_LINK_DAYS * 86_400_000);
    const key = accountantReportKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    const token = buildAccountantReportToken(key, tenantId, fileName, expiresAt);
    const apiBase = this.config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const url = `${apiBase}/v1/public/accountant-reports/${token}`;

    const invoiceNumbers = new Set(dto.invoices.map((r) => r.invoiceNumber));
    const range = `del ${ddmmyyyy(from)} al ${ddmmyyyy(to)}`;
    const period = label ? `de ${label} (${range})` : range;
    const name = tenant.name;
    const lines = [
      `${invoiceNumbers.size} facturas emitidas`,
      `${dto.payments.length} cobros`,
      `${dto.expenses.length} gastos`,
      ...(dto.deposits.length > 0 ? [`${dto.deposits.length} movimientos de fianzas`] : []),
    ];
    const warning =
      dto.warnings.length > 0
        ? `${dto.warnings.length} facturas no tienen todos los datos del cliente (NIF o domicilio).`
        : null;
    const subject = `Documentación contable de ${name}: ${label ?? range}`;
    const html = tenantEmailShell(
      { name, brandColor: tenant.portalBrandColor, logoUrl: tenant.portalLogoUrl },
      `<p style="margin:0 0 12px">Hola:</p>
<p style="margin:0 0 12px">Te enviamos la documentación contable de <strong>${escapeHtml(name)}</strong> ${escapeHtml(period)}.</p>
<ul style="margin:0 0 16px;padding-left:20px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
${warning ? `<p style="margin:0 0 16px;color:#b45309">${escapeHtml(warning)}</p>` : ''}
<p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Descargar el Excel</a></p>
<p style="margin:0;font-size:13px;color:#64748b">Lleva una hoja por tabla: facturas (por tipo de IVA), cobros, fianzas y gastos. El enlace funciona durante ${ACCOUNTANT_REPORT_LINK_DAYS} días.</p>`,
    );
    const text = [
      'Hola:',
      '',
      `Te enviamos la documentación contable de ${name} ${period}:`,
      ...lines.map((l) => `- ${l}`),
      ...(warning ? ['', warning] : []),
      '',
      `Descargar el Excel: ${url}`,
      `El enlace funciona durante ${ACCOUNTANT_REPORT_LINK_DAYS} días.`,
    ].join('\n');
    const result = await this.email.sendRendered({
      to: tenant.accountantEmail,
      tenantId,
      subject,
      html,
      text,
    });
    if (result.suppressed) {
      throw new BadRequestException({
        code: 'email_suppressed',
        message: 'El email de la asesoría está bloqueado (rebotó o lo marcaron como spam)',
      });
    }
    await this.audit.write({
      tenantId,
      action: 'fiscal.accountant_report_sent',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { to: tenant.accountantEmail, from, until: to },
    });
    return { sentTo: tenant.accountantEmail, from, to };
  }

  /** Envío automático: a cada empresa con asesoría y frecuencia, su periodo pendiente. */
  async runDue(): Promise<{ sent: number; failed: number }> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        status: { in: ['active', 'trial'] },
        accountantEmail: { not: null },
        accountantReportFrequency: { in: ['monthly', 'quarterly'] },
      },
      select: {
        id: true,
        timezone: true,
        accountantReportFrequency: true,
        accountantReportLastPeriod: true,
      },
    });
    let sent = 0;
    let failed = 0;
    for (const t of tenants) {
      const period = duePeriod(
        t.accountantReportFrequency as AccountantReportFrequency,
        todayInTimezone(t.timezone),
      );
      if (!period || t.accountantReportLastPeriod === period.key) continue;
      // Se reserva el periodo antes de enviar: dos réplicas no lo mandan dos veces.
      const claimed = await this.admin.tenant.updateMany({
        where: {
          id: t.id,
          OR: [
            { accountantReportLastPeriod: null },
            { accountantReportLastPeriod: { not: period.key } },
          ],
        },
        data: { accountantReportLastPeriod: period.key },
      });
      if (claimed.count === 0) continue;
      try {
        await this.send(t.id, period.from, period.to, period.label);
        sent++;
      } catch (err) {
        failed++;
        await this.admin.tenant.update({
          where: { id: t.id },
          data: { accountantReportLastPeriod: t.accountantReportLastPeriod },
        });
        this.logger.warn(
          `asesoría: no se envió ${period.key} del tenant ${t.id}: ${(err as Error).message}`,
        );
      }
    }
    return { sent, failed };
  }
}
