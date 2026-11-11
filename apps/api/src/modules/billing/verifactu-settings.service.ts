import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isValidSpanishTaxId, normalizeTaxId } from '@storageos/shared';

import { formatDateLong, todayInTimezone } from '../../common/format';
import { tenantFiscalDataMissing } from '../../common/tenant-readiness';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { PENDING_RECORD_WHERE } from './verifactu-dispatcher.service';
import { sendableAt } from './verifactu-flow';
import { verifactuInstallationNumber } from './verifactu-installation';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, VerifactuSubmission } from '@storageos/database';
import type {
  VerifactuAlertDto,
  VerifactuBlockerDto,
  VerifactuRenunciaDto,
  VerifactuSettingsDto,
  VerifactuSubmissionDto,
} from '@storageos/shared';

type SubmissionRow = VerifactuSubmission & { owner: { legalName: string } | null };

const SUBMISSION_INCLUDE = { owner: { select: { legalName: true } } } as const;

/** Un envío con la renuncia cuenta como comunicada si la AEAT lo procesó. */
const PROCESSED_SUBMISSION = ['accepted', 'partially_accepted'];

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toSubmissionDto(row: SubmissionRow): VerifactuSubmissionDto {
  return {
    id: row.id,
    sentAt: row.sentAt.toISOString(),
    ownerName: row.owner?.legalName ?? null,
    status: row.status as VerifactuSubmissionDto['status'],
    csv: row.csv,
    recordCount: row.recordCount,
    acceptedCount: row.acceptedCount,
    rejectedCount: row.rejectedCount,
    waitSeconds: row.waitSeconds,
    message: row.message,
    mode: row.mode as VerifactuSubmissionDto['mode'],
    fechaFinVerifactu: row.fechaFinVerifactu ? dateOnly(row.fechaFinVerifactu) : null,
    incident: row.incident,
  };
}

/**
 * Hasta cuándo sigue en VERI*FACTU quien generó un registro en esta fecha: el
 * 31 de diciembre de ese año, en la zona del negocio (art. 17.2 de la Orden).
 */
export function verifactuLockedUntil(recordAt: Date, timeZone: string): string {
  const year = todayInTimezone(timeZone, recordAt).getUTCFullYear();
  return `${year}-12-31`;
}

/**
 * El último fallo al enviar, en palabras (lo que se guarda es el código o el
 * texto de la AEAT).
 */
export function verifactuErrorText(message: string | null | undefined): string | null {
  if (!message) return null;
  const known: Record<string, string> = {
    tenant_no_aeat_credential: 'Falta el certificado digital: súbelo en esta página.',
    certificate_expired: 'El certificado digital ha caducado: sube uno vigente.',
    invalid_certificate: 'No se ha podido leer el certificado digital: vuelve a subirlo.',
    aeat_server_error: 'La AEAT no responde (error en su servidor). Se vuelve a intentar.',
    unrecognized_aeat_response:
      'La AEAT ha dado una respuesta que no se entiende. Se vuelve a intentar.',
    tenant_not_found: 'No se encuentra el negocio.',
    owner_not_found: 'No se encuentra el propietario que emite.',
  };
  if (known[message]) return known[message];
  if (message.startsWith('aeat_fault:')) {
    const text = message.slice('aeat_fault:'.length).trim();
    const code = text.match(/Codigo\[(\d+)\]\.?\s*/i);
    const rest = code ? text.replace(code[0], '').trim() : text;
    return `La AEAT ha rechazado el envío${code ? ` (${code[1]})` : ''}: ${rest || 'sin detalle'}`;
  }
  if (/timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) {
    return 'No se ha podido conectar con la AEAT. Se vuelve a intentar.';
  }
  return message;
}

/**
 * Veri*Factu por negocio. Apagado (por defecto), sus facturas se emiten sin
 * huella, sin QR y sin envío a la AEAT: así nadie se queda sin facturar por no
 * tener aún el certificado. Cada negocio lo activa cuando le toque (o antes);
 * desde entonces se envía todo y su primera factura abre la cadena.
 *
 * Quien ha generado registros en un año sigue en VERI*FACTU hasta el 31 de
 * diciembre de ese año (art. 17.2 de la Orden HAC/1177/2024): desactivarlo
 * programa la baja para ese día y los envíos que salgan hasta entonces llevan
 * la renuncia (`FechaFinVeriFactu`, art. 17.3). El 1 de enero se apaga si ha
 * llegado a la AEAT; si no (no salió ningún envío más ese año), sigue activado
 * y se avisa. Quien aún no ha generado nada lo apaga en el momento.
 */
@Injectable()
export class VerifactuSettingsService {
  private readonly logger = new Logger(VerifactuSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
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

  /** Los últimos envíos a la AEAT, con el CSV que acredita cada uno. */
  async submissions(tenantId: string, limit = 50): Promise<VerifactuSubmissionDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.verifactuSubmission.findMany({
          where: { tenantId },
          orderBy: { sentAt: 'desc' },
          take: Math.min(Math.max(limit, 1), 200),
          include: SUBMISSION_INCLUDE,
        }),
      tenantId,
    );
    return rows.map(toSubmissionDto);
  }

  /**
   * Lo que no ha podido salir hacia la AEAT por una incidencia técnica: el
   * panel lo avisa con el número mientras quede algo (art. 16.4 de la Orden).
   */
  async alert(tenantId: string): Promise<VerifactuAlertDto> {
    const where: Prisma.VerifactuRecordWhereInput = {
      tenantId,
      ...PENDING_RECORD_WHERE,
      incident: true,
    };
    const [unsentCount, oldest, failing] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.verifactuRecord.count({ where }),
          tx.verifactuRecord.findFirst({
            where,
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          }),
          tx.verifactuEmitter.findFirst({
            where: { tenantId, consecutiveFailures: { gt: 0 } },
            orderBy: { updatedAt: 'desc' },
            select: { lastError: true },
          }),
        ]),
      tenantId,
    );
    return {
      unsentCount,
      since: oldest?.createdAt.toISOString() ?? null,
      lastError: unsentCount > 0 ? verifactuErrorText(failing?.lastError) : null,
    };
  }

  private async snapshot(
    tenantId: string,
  ): Promise<{ dto: VerifactuSettingsDto; timezone: string }> {
    const d = await this.prisma.withTenant(async (tx) => {
      const [
        tenant,
        cert,
        pending,
        rejected,
        incident,
        lastSubmission,
        emitters,
        pendingByEmitter,
        lastRecord,
      ] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            verifactuEnabled: true,
            verifactuEnabledAt: true,
            verifactuEndDate: true,
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
        tx.verifactuRecord.count({ where: { tenantId, ...PENDING_RECORD_WHERE } }),
        tx.invoice.count({ where: { tenantId, hash: { not: null }, aeatStatus: 'rejected' } }),
        tx.verifactuRecord.count({ where: { tenantId, ...PENDING_RECORD_WHERE, incident: true } }),
        tx.verifactuSubmission.findFirst({
          where: { tenantId },
          orderBy: { sentAt: 'desc' },
          include: SUBMISSION_INCLUDE,
        }),
        tx.verifactuEmitter.findMany({ where: { tenantId } }),
        tx.verifactuRecord.groupBy({
          by: ['ownerId'],
          where: { tenantId, ...PENDING_RECORD_WHERE },
          _count: { _all: true },
          orderBy: { ownerId: 'asc' },
        }),
        tx.verifactuRecord.findFirst({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);
      const renuncia =
        tenant.verifactuEnabled && tenant.verifactuEndDate
          ? await this.renunciaState(tx, tenantId, tenant.verifactuEndDate)
          : null;
      return {
        tenant,
        cert,
        pending,
        rejected,
        incident,
        lastSubmission,
        emitters,
        pendingByEmitter,
        lastRecord,
        renuncia,
      };
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

    // Con registros generados este año (en la zona del negocio), sigue hasta
    // el 31 de diciembre.
    const thisYear = todayInTimezone(t.timezone).getUTCFullYear();
    const recordLock = d.lastRecord
      ? verifactuLockedUntil(d.lastRecord.createdAt, t.timezone)
      : null;
    const lockedUntil =
      t.verifactuEnabled && recordLock && Number(recordLock.slice(0, 4)) >= thisYear
        ? recordLock
        : null;
    const failing = d.emitters.find((e) => e.consecutiveFailures > 0);

    const dto: VerifactuSettingsDto = {
      enabled: t.verifactuEnabled,
      enabledAt: t.verifactuEnabledAt?.toISOString() ?? null,
      lockedUntil,
      renuncia: d.renuncia,
      platformMode: this.platformMode,
      blockers,
      pendingCount: d.pending,
      rejectedCount: d.rejected,
      incidentCount: d.incident,
      lastError: failing ? verifactuErrorText(failing.lastError) : null,
      invoicingInHolded: t.invoicingMode === 'holded',
      lastSubmission: d.lastSubmission ? toSubmissionDto(d.lastSubmission) : null,
      nextSendAt: this.nextSendAt(d.emitters, d.pendingByEmitter),
    };
    return { dto, timezone: t.timezone };
  }

  /**
   * La baja programada: si la AEAT ya la ha recibido (un envío con la
   * renuncia que procesó) y cuántos emisores con facturas ese año no la han
   * mandado aún.
   */
  private async renunciaState(
    db: Prisma.TransactionClient,
    tenantId: string,
    endDate: Date,
  ): Promise<VerifactuRenunciaDto> {
    const yearStart = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
    const [withRecords, sent] = await Promise.all([
      db.verifactuRecord.findMany({
        where: { tenantId, createdAt: { gte: yearStart } },
        distinct: ['ownerId'],
        select: { ownerId: true },
      }),
      db.verifactuSubmission.findMany({
        where: {
          tenantId,
          fechaFinVerifactu: endDate,
          status: { in: PROCESSED_SUBMISSION },
        },
        orderBy: { sentAt: 'asc' },
        select: { ownerId: true, sentAt: true },
      }),
    ]);
    const communicated = new Set(sent.map((s) => s.ownerId ?? 'self'));
    return {
      endDate: dateOnly(endDate),
      communicatedAt: sent[0]?.sentAt.toISOString() ?? null,
      pendingEmitters: withRecords.filter((e) => !communicated.has(e.ownerId ?? 'self')).length,
    };
  }

  /**
   * El siguiente envío de lo pendiente: el más próximo entre los emisores que
   * aún esperan (la espera de la AEAT o el reintento tras un fallo). Null si no
   * hay nada pendiente o alguno puede salir ya.
   */
  private nextSendAt(
    emitters: { ownerId: string | null; nextSendAt: Date | null; retryAt: Date | null }[],
    pending: { ownerId: string | null; _count: { _all: number } | true | undefined }[],
  ): string | null {
    const now = Date.now();
    let next: number | null = null;
    for (const group of pending) {
      const count = typeof group._count === 'object' ? group._count._all : 0;
      const state = emitters.find((e) => e.ownerId === group.ownerId);
      const at = state ? sendableAt(state, count) : null;
      if (!at || at.getTime() <= now) return null;
      next = next === null ? at.getTime() : Math.min(next, at.getTime());
    }
    return next === null ? null : new Date(next).toISOString();
  }

  async set(args: {
    tenantId: string;
    userId: string;
    enabled: boolean;
    meta: RequestMeta;
  }): Promise<VerifactuSettingsDto> {
    const { dto: current, timezone: tz } = await this.snapshot(args.tenantId);

    if (args.enabled) {
      if (current.enabled) {
        // Activado con la baja programada: se anula si aún no salió.
        if (!current.renuncia) return current;
        if (current.renuncia.communicatedAt) {
          throw new ConflictException({
            code: 'verifactu_renuncia_sent',
            message: `La baja ya se comunicó a la AEAT el ${formatDateLong(new Date(current.renuncia.communicatedAt), tz)}: dejarás Veri*Factu el 1 de enero.`,
          });
        }
        await this.prisma.withTenant(
          (tx) =>
            tx.tenant.update({ where: { id: args.tenantId }, data: { verifactuEndDate: null } }),
          args.tenantId,
        );
        await this.writeAudit(args, 'tenant.verifactu_renuncia_cancelled', {
          endDate: current.renuncia.endDate,
        });
        return this.get(args.tenantId);
      }
      const blocker = current.blockers[0];
      if (blocker) {
        const body = { code: blocker.code, message: blocker.message };
        throw blocker.code === 'verifactu_platform_not_ready'
          ? new ConflictException(body)
          : new BadRequestException(body);
      }
      const now = new Date();
      await this.prisma.withTenant(
        (tx) =>
          tx.tenant.update({
            where: { id: args.tenantId },
            // Cada activación es un sistema nuevo con su número de instalación.
            data: {
              verifactuEnabled: true,
              verifactuEnabledAt: now,
              verifactuEndDate: null,
              verifactuInstallation: verifactuInstallationNumber(now, args.tenantId),
            },
          }),
        args.tenantId,
      );
      await this.writeAudit(args, 'tenant.verifactu_enabled', {});
      return this.get(args.tenantId);
    }

    if (!current.enabled || current.renuncia) return current;
    if (current.lockedUntil) {
      // Con registros este año: baja al 31 de diciembre, con la renuncia en
      // los envíos que salgan hasta entonces.
      await this.prisma.withTenant(
        (tx) =>
          tx.tenant.update({
            where: { id: args.tenantId },
            data: { verifactuEndDate: new Date(`${current.lockedUntil}T00:00:00Z`) },
          }),
        args.tenantId,
      );
      await this.writeAudit(args, 'tenant.verifactu_renuncia_scheduled', {
        endDate: current.lockedUntil,
      });
      return this.get(args.tenantId);
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.tenant.update({
          where: { id: args.tenantId },
          // El número de instalación se conserva: lo usan los registros que
          // queden por enviar.
          data: { verifactuEnabled: false, verifactuEnabledAt: null, verifactuEndDate: null },
        }),
      args.tenantId,
    );
    await this.writeAudit(args, 'tenant.verifactu_disabled', {});
    return this.get(args.tenantId);
  }

  /**
   * El 1 de enero (en la zona de cada negocio) se aplica la baja programada:
   * se apaga si la renuncia llegó a la AEAT desde todos sus emisores con
   * facturas ese año; si no, sigue activado y se le avisa. Lo llama el cron
   * diario `verifactu.renuncia`.
   */
  async applyDueRenuncias(): Promise<{ disabled: number; kept: number }> {
    const tenants = await this.admin.tenant.findMany({
      where: { verifactuEnabled: true, verifactuEndDate: { not: null } },
      select: { id: true, timezone: true, verifactuEndDate: true },
    });
    let disabled = 0;
    let kept = 0;
    for (const t of tenants) {
      const end = t.verifactuEndDate!;
      if (dateOnly(todayInTimezone(t.timezone)) <= dateOnly(end)) continue;
      const state = await this.renunciaState(this.admin, t.id, end);
      if (state.pendingEmitters === 0) {
        // Se conserva la fecha: lo de diciembre que salga en enero la lleva.
        await this.admin.tenant.update({
          where: { id: t.id },
          data: { verifactuEnabled: false, verifactuEnabledAt: null },
        });
        await this.audit.write({
          tenantId: t.id,
          userId: null,
          action: 'tenant.verifactu_disabled',
          entityType: 'Tenant',
          entityId: t.id,
          changes: { renuncia: dateOnly(end) },
          ipAddress: null,
          userAgent: null,
        });
        disabled += 1;
        continue;
      }
      await this.admin.tenant.update({ where: { id: t.id }, data: { verifactuEndDate: null } });
      await this.admin.notification.create({
        data: {
          tenantId: t.id,
          type: 'verifactu.renuncia_not_sent',
          title: 'Sigues en Veri*Factu',
          body: `No se pudo comunicar a la AEAT tu baja de Veri*Factu del ${formatDateLong(end, t.timezone)}: ningún envío la llevó antes de acabar el año (no se emitió ninguna factura más). Sigues enviando tus facturas. Si quieres dejarlo, vuelve a programar la baja.`,
          link: '/settings/billing/verifactu',
        },
      });
      this.logger.warn(`[verifactu] renuncia del tenant ${t.id} sin comunicar: sigue activado`);
      kept += 1;
    }
    return { disabled, kept };
  }

  private async writeAudit(
    args: { tenantId: string; userId: string; meta: RequestMeta },
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action,
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { platformMode: this.platformMode, ...changes },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }
}
