import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isValidSpanishTaxId, normalizeTaxId } from '@storageos/shared';

import { formatDateLong, todayInTimezone } from '../../common/format';
import { tenantFiscalDataMissing } from '../../common/tenant-readiness';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { verifactuInstallationNumber } from './verifactu-installation';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { VerifactuBlockerDto, VerifactuSettingsDto } from '@storageos/shared';

/** Último día en que no se puede apagar: el 31 de diciembre del año en que se activó. */
export function verifactuLockedUntil(enabledAt: Date, timeZone: string): string {
  const year = todayInTimezone(timeZone, enabledAt).getUTCFullYear();
  return `${year}-12-31`;
}

/**
 * Veri*Factu por negocio. Apagado (por defecto), sus facturas se emiten sin
 * huella, sin QR y sin envío a la AEAT: así nadie se queda sin facturar por no
 * tener aún el certificado. Cada negocio lo activa cuando le toque (o antes);
 * desde entonces se envía todo y su primera factura abre la cadena.
 *
 * Activado, no se apaga hasta el 31 de diciembre de ese año: quien remite sus
 * registros a la AEAT debe hacerlo todo el año natural (art. 17 de la Orden
 * HAC/1177/2024).
 */
@Injectable()
export class VerifactuSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  private get platformMode(): 'stub' | 'sandbox' | 'production' {
    return this.config.get('AEAT_MODE', { infer: true });
  }

  /**
   * En producción con la plataforma sin conectar a la AEAT no se puede activar:
   * «activado» tiene que querer decir que las facturas llegan de verdad. En
   * desarrollo y en los tests se activa con el envío simulado.
   */
  private get platformReady(): boolean {
    return !(
      this.platformMode === 'stub' && this.config.get('NODE_ENV', { infer: true }) === 'production'
    );
  }

  async get(tenantId: string): Promise<VerifactuSettingsDto> {
    return (await this.snapshot(tenantId)).dto;
  }

  private async snapshot(
    tenantId: string,
  ): Promise<{ dto: VerifactuSettingsDto; timezone: string }> {
    const d = await this.prisma.withTenant(async (tx) => {
      const [tenant, cert, pending, rejected] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            verifactuEnabled: true,
            verifactuEnabledAt: true,
            timezone: true,
            invoicingMode: true,
            taxId: true,
            billingLegalName: true,
            billingAddress: true,
            billingPostalCode: true,
            billingCity: true,
          },
        }),
        tx.tenantAeatCredential.findFirst({
          where: { tenantId, ownerId: null, revokedAt: null, certValidTo: { gt: new Date() } },
          select: { id: true },
        }),
        tx.invoice.count({
          where: { tenantId, hash: { not: null }, aeatStatus: { in: ['pending', 'error'] } },
        }),
        tx.invoice.count({ where: { tenantId, hash: { not: null }, aeatStatus: 'rejected' } }),
      ]);
      return { tenant, cert, pending, rejected };
    }, tenantId);
    const t = d.tenant;
    const realMode = this.platformMode !== 'stub';

    const blockers: VerifactuBlockerDto[] = [];
    if (!this.platformReady) {
      blockers.push({
        code: 'verifactu_platform_not_ready',
        message:
          'TrasterOS aún no está conectado con la AEAT. Te avisaremos en cuanto puedas activarlo.',
        href: null,
      });
    }
    const missing = tenantFiscalDataMissing(t);
    if (missing.length > 0) {
      blockers.push({
        code: 'issuer_fiscal_data_required',
        message: `Faltan datos fiscales de tu empresa: ${missing.join(', ')}.`,
        href: '/settings/company',
      });
    } else if (realMode && !(t.taxId && isValidSpanishTaxId(normalizeTaxId(t.taxId)))) {
      blockers.push({
        code: 'tenant_tax_id_required',
        message: 'El NIF de tu empresa no es válido: corrígelo en los datos de tu empresa.',
        href: '/settings/company',
      });
    }
    if (realMode && !d.cert) {
      blockers.push({
        code: 'aeat_certificate_required',
        message:
          'Sube un certificado digital vigente: el de tu empresa o el de quien la representa.',
        href: null,
      });
    }

    const dto: VerifactuSettingsDto = {
      enabled: t.verifactuEnabled,
      enabledAt: t.verifactuEnabledAt?.toISOString() ?? null,
      lockedUntil:
        t.verifactuEnabled && t.verifactuEnabledAt
          ? verifactuLockedUntil(t.verifactuEnabledAt, t.timezone)
          : null,
      platformMode: this.platformMode,
      blockers,
      pendingCount: d.pending,
      rejectedCount: d.rejected,
      invoicingInHolded: t.invoicingMode === 'holded',
    };
    return { dto, timezone: t.timezone };
  }

  async set(args: {
    tenantId: string;
    userId: string;
    enabled: boolean;
    meta: RequestMeta;
  }): Promise<VerifactuSettingsDto> {
    const { dto: current, timezone: tz } = await this.snapshot(args.tenantId);
    if (args.enabled === current.enabled) return current;

    if (args.enabled) {
      const blocker = current.blockers[0];
      if (blocker) {
        const body = { code: blocker.code, message: blocker.message };
        throw blocker.code === 'verifactu_platform_not_ready'
          ? new ConflictException(body)
          : new BadRequestException(body);
      }
    } else if (current.lockedUntil) {
      const today = todayInTimezone(tz).toISOString().slice(0, 10);
      if (today <= current.lockedUntil) {
        const since = current.enabledAt
          ? ` desde el ${formatDateLong(new Date(current.enabledAt), tz)}`
          : '';
        throw new ConflictException({
          code: 'verifactu_locked',
          message: `Veri*Factu está activado${since}: no se puede desactivar hasta el 31 de diciembre de ${current.lockedUntil.slice(0, 4)}. Quien envía sus facturas a la AEAT tiene que hacerlo durante todo el año (art. 17 de la Orden HAC/1177/2024).`,
          details: { lockedUntil: current.lockedUntil },
        });
      }
    }

    const now = new Date();
    await this.prisma.withTenant(
      (tx) =>
        tx.tenant.update({
          where: { id: args.tenantId },
          // Cada activación es un sistema nuevo con su número de instalación.
          // Al apagarlo se conserva: lo usan los registros que queden por enviar.
          data: args.enabled
            ? {
                verifactuEnabled: true,
                verifactuEnabledAt: now,
                verifactuInstallation: verifactuInstallationNumber(now, args.tenantId),
              }
            : { verifactuEnabled: false, verifactuEnabledAt: null },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.enabled ? 'tenant.verifactu_enabled' : 'tenant.verifactu_disabled',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { platformMode: this.platformMode },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.get(args.tenantId);
  }
}
