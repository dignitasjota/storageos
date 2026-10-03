import { BadRequestException, Injectable } from '@nestjs/common';

import { todayInTimezone } from '../../common/format';
import { HoldedSettingsService } from '../accounting/holded-settings.service';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { VerifactuService } from './verifactu.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type { InvoicingModeDto, InvoicingModeValue } from '@storageos/shared';

const asMode = (v: string | null | undefined): InvoicingModeValue =>
  v === 'holded' ? 'holded' : 'app';

/**
 * Dónde se emiten las facturas del tenant: en la app (numeración propia y
 * registro en Veri*Factu con su certificado) o en Holded (Holded numera y
 * registra). No se cambia en mitad del año: la numeración y la cadena de
 * registros en la AEAT no pueden partirse entre dos sistemas. El cambio queda
 * programado para el 1 de enero, salvo que aún no haya emitido ninguna factura
 * en el año (entonces es inmediato).
 */
@Injectable()
export class InvoicingModeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holded: HoldedSettingsService,
    private readonly verifactu: VerifactuService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Modo vigente hoy. Si había un cambio programado y ya llegó su fecha, lo
   * aplica (no hace falta un cron: se resuelve al emitir o al consultar).
   */
  async current(tx: Prisma.TransactionClient, tenantId: string): Promise<InvoicingModeValue> {
    const t = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        invoicingMode: true,
        invoicingModePending: true,
        invoicingModePendingFrom: true,
        timezone: true,
      },
    });
    if (
      t.invoicingModePending &&
      t.invoicingModePendingFrom &&
      t.invoicingModePendingFrom <= todayInTimezone(t.timezone)
    ) {
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          invoicingMode: t.invoicingModePending,
          invoicingModePending: null,
          invoicingModePendingFrom: null,
        },
      });
      return asMode(t.invoicingModePending);
    }
    return asMode(t.invoicingMode);
  }

  async get(tenantId: string): Promise<InvoicingModeDto> {
    const { mode, pending, pendingFrom, canChangeNow, hasCertificate } =
      await this.prisma.withTenant(async (tx) => {
        const m = await this.current(tx, tenantId);
        const t = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { invoicingModePending: true, invoicingModePendingFrom: true, timezone: true },
        });
        const cert = await tx.tenantAeatCredential.findFirst({
          where: { tenantId, revokedAt: null, certValidTo: { gt: new Date() } },
          select: { id: true },
        });
        return {
          mode: m,
          pending: t.invoicingModePending,
          pendingFrom: t.invoicingModePendingFrom,
          canChangeNow: !(await this.issuedThisYear(tx, tenantId, t.timezone)),
          hasCertificate: !!cert,
        };
      }, tenantId);
    const holded = await this.holded.resolveIssuing(tenantId);
    return {
      mode,
      pendingMode: pending ? asMode(pending) : null,
      pendingFrom: pendingFrom ? pendingFrom.toISOString().slice(0, 10) : null,
      canChangeNow,
      holdedReady: !('reason' in holded),
      certificateMissing: this.verifactu.realMode && !hasCertificate,
    };
  }

  async set(args: {
    tenantId: string;
    userId: string;
    mode: InvoicingModeValue;
    meta: RequestMeta;
  }): Promise<InvoicingModeDto> {
    if (args.mode === 'holded') {
      const holded = await this.holded.resolveIssuing(args.tenantId);
      if ('reason' in holded) {
        throw new BadRequestException({ code: 'holded_issuing_not_ready', message: holded.reason });
      }
    }
    const result = await this.prisma.withTenant(async (tx) => {
      const mode = await this.current(tx, args.tenantId);
      const t = await tx.tenant.findUniqueOrThrow({
        where: { id: args.tenantId },
        select: { timezone: true },
      });
      if (mode === args.mode) {
        // Vuelve al modo actual: se anula el cambio programado.
        await tx.tenant.update({
          where: { id: args.tenantId },
          data: { invoicingModePending: null, invoicingModePendingFrom: null },
        });
        return { from: mode, effective: 'now' as const };
      }
      if (!(await this.issuedThisYear(tx, args.tenantId, t.timezone))) {
        await tx.tenant.update({
          where: { id: args.tenantId },
          data: {
            invoicingMode: args.mode,
            invoicingModePending: null,
            invoicingModePendingFrom: null,
          },
        });
        return { from: mode, effective: 'now' as const };
      }
      const year = todayInTimezone(t.timezone).getUTCFullYear();
      const from = new Date(Date.UTC(year + 1, 0, 1));
      await tx.tenant.update({
        where: { id: args.tenantId },
        data: { invoicingModePending: args.mode, invoicingModePendingFrom: from },
      });
      return { from: mode, effective: from.toISOString().slice(0, 10) };
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'tenant.invoicing_mode_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { from: result.from, to: args.mode, effective: result.effective },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.get(args.tenantId);
  }

  /** ¿Ha emitido ya alguna factura este año natural (en su zona horaria)? */
  private async issuedThisYear(
    tx: Prisma.TransactionClient,
    tenantId: string,
    timezone: string,
  ): Promise<boolean> {
    const year = todayInTimezone(timezone).getUTCFullYear();
    const n = await tx.invoice.count({
      where: {
        tenantId,
        kind: 'invoice',
        status: { not: 'draft' },
        issueDate: { gte: new Date(Date.UTC(year, 0, 1)) },
      },
    });
    return n > 0;
  }
}
