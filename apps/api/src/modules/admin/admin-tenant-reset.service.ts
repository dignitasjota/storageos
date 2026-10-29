import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TENANT_RESET_COUNT_KEYS,
  type TenantResetBlockerCode,
  type TenantResetCountKey,
  type TenantResetFilesDto,
  type TenantResetInput,
  type TenantResetIssueDto,
  type TenantResetPreviewDto,
  type TenantResetResultDto,
  type TenantResetWarningCode,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { type Env } from '../../config/env.schema';
import { DahuaSyncService } from '../access/dahua-sync.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { SuperAdminAuditService } from './super-admin-audit.service';

/**
 * Tablas que se vacían, en un orden que respeta las claves ajenas que no
 * borran en cascada (adeudos antes que mandatos; cobros, facturas y contratos
 * antes que inquilinos). El resto de referencias desde lo que se conserva
 * (contactos, conversaciones de contactos, accesos del equipo…) son SET NULL.
 *
 * Conserva: locales, plantas, tipos, trasteros, productos y su stock,
 * contactos (leads) con sus seguimientos y actividad, usuarios, roles,
 * propietarios y toda la configuración.
 */
/** Un grupo de ficheros del tenant que se borra al vaciar. */
interface FileTarget {
  label: string;
  bucket: 'invoices' | 'uploads' | 'reports';
  prefix: string;
  skip?: (key: string) => boolean;
}

/** Nombres legibles de lo que se borra (resumen por correo). */
const COUNT_LABELS: Record<TenantResetCountKey, string> = {
  customers: 'inquilinos',
  contracts: 'contratos',
  reservations: 'reservas',
  invoices: 'facturas',
  payments: 'cobros',
  communications: 'comunicaciones',
  tasks: 'tareas',
  incidents: 'incidencias',
  productSales: 'ventas',
  accessLogs: 'registros de acceso',
  expenses: 'gastos',
};

const PURGE_STEPS: { table: string; where?: string }[] = [
  { table: 'notification_reads' },
  { table: 'notifications' },
  { table: 'ai_pending_actions' },
  { table: 'ai_messages' },
  { table: 'ai_conversations' },
  { table: 'webhook_deliveries' },
  { table: 'automation_runs' },
  { table: 'campaign_clicks' },
  { table: 'campaign_links' },
  { table: 'campaigns' },
  { table: 'winback_sends' },
  // Los correos a contactos se conservan con el contacto.
  { table: 'communications', where: 'lead_id IS NULL OR customer_id IS NOT NULL' },
  // Las conversaciones de WhatsApp de contactos (sin inquilino) se conservan.
  { table: 'whatsapp_conversations', where: 'customer_id IS NOT NULL' },
  { table: 'access_logs' },
  { table: 'task_comments' },
  { table: 'tasks' },
  { table: 'incident_comments' },
  { table: 'incidents' },
  { table: 'customer_message_reads' },
  { table: 'customer_messages' },
  { table: 'customer_interactions' },
  { table: 'customer_followups' },
  { table: 'customer_interest_events' },
  { table: 'customer_offers' },
  { table: 'customer_authorized_persons' },
  { table: 'customer_documents' },
  { table: 'reviews' },
  { table: 'referrals' },
  { table: 'retention_offers' },
  { table: 'unit_change_requests' },
  { table: 'unit_requests' },
  { table: 'waitlist_entries' },
  { table: 'data_subject_requests' },
  { table: 'consents' },
  { table: 'legal_doc_acceptances' },
  { table: 'delinquency_case_files' },
  { table: 'delinquency_case_events' },
  { table: 'delinquency_cases' },
  { table: 'coupon_redemptions' },
  { table: 'rent_increase_items' },
  { table: 'rent_increases' },
  { table: 'sepa_remittance_items' },
  { table: 'sepa_remittances' },
  { table: 'sepa_mandates' },
  { table: 'bank_statement_transactions' },
  { table: 'bank_statements' },
  { table: 'cash_closures' },
  { table: 'owner_statements' },
  { table: 'payment_plans' },
  { table: 'dunning_actions' },
  { table: 'redsys_orders' },
  // Movimientos de stock de las ventas; los ajustes y recuentos se conservan.
  { table: 'product_stock_movements', where: 'sale_id IS NOT NULL' },
  { table: 'product_sale_items' },
  { table: 'product_sales' },
  { table: 'payments' },
  { table: 'invoice_items' },
  { table: 'invoices' },
  { table: 'contract_inspection_photos' },
  { table: 'contract_signatures' },
  { table: 'contract_events' },
  { table: 'reservations' },
  { table: 'contracts' },
  { table: 'payment_methods' },
  { table: 'push_subscriptions', where: 'customer_id IS NOT NULL' },
  // Todas las credenciales son de inquilinos (ya quitadas de los terminales).
  { table: 'access_credentials' },
  { table: 'customers' },
  { table: 'expenses' },
  { table: 'unit_status_history' },
  { table: 'report_runs' },
  { table: 'web_events' },
  { table: 'promo_landing_visits' },
];

/** Qué tabla se cuenta para cada cifra de la vista previa. */
const COUNT_SOURCES: Record<TenantResetCountKey, { table: string; where?: string }> = {
  customers: { table: 'customers' },
  contracts: { table: 'contracts' },
  reservations: { table: 'reservations' },
  invoices: { table: 'invoices' },
  payments: { table: 'payments' },
  productSales: { table: 'product_sales' },
  expenses: { table: 'expenses' },
  communications: { table: 'communications', where: 'lead_id IS NULL OR customer_id IS NOT NULL' },
  tasks: { table: 'tasks' },
  incidents: { table: 'incidents' },
  accessLogs: { table: 'access_logs' },
};

/** Cualquier factura con un envío a la AEAT (aceptada, pendiente o con error). */
const AEAT_SENT = 'aeat_status IS NOT NULL';

@Injectable()
export class AdminTenantResetService {
  private readonly logger = new Logger(AdminTenantResetService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly audit: SuperAdminAuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly sync: DahuaSyncService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  async preview(tenantId: string): Promise<TenantResetPreviewDto> {
    const tenant = await this.findTenant(tenantId);
    const counts = await this.counts(tenantId);
    const [facilities, units, products, leads, users, series] = await Promise.all([
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.product.count({ where: { tenantId } }),
      this.admin.lead.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
      this.admin.invoiceSeries.findMany({
        where: { tenantId },
        select: { prefix: true, nextNumber: true },
        orderBy: { prefix: 'asc' },
      }),
    ]);
    const [{ blockers, warnings }, files] = await Promise.all([
      this.issues(tenantId),
      this.fileSummary(tenantId),
    ]);
    return {
      tenantId,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      counts,
      kept: { facilities, units, products, leads, users },
      series,
      blockers,
      warnings,
      files,
    };
  }

  async reset(args: {
    tenantId: string;
    superAdminId: string;
    input: TenantResetInput;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<TenantResetResultDto> {
    const { tenantId, input } = args;
    const tenant = await this.findTenant(tenantId);
    if (input.confirmSlug.trim().toLowerCase() !== tenant.slug.toLowerCase()) {
      throw new BadRequestException({
        code: 'confirm_slug_mismatch',
        message: 'El identificador escrito no coincide con el del tenant',
      });
    }
    const { blockers } = await this.issues(tenantId);
    if (blockers.length > 0) {
      throw new ConflictException({
        code: 'tenant_reset_blocked',
        message: blockers.map((b) => b.message).join(' '),
        details: { blockers: blockers.map((b) => b.code) },
      });
    }

    // Las credenciales de los inquilinos que están en un terminal (validan sin
    // red) se quitan de él antes: si no, seguirían abriendo la puerta.
    await this.revokeOnTerminals(tenantId);

    const counts = await this.counts(tenantId);
    // Conversaciones de WhatsApp de inquilinos: sus archivos se borran después.
    const waConversations = await this.waConversationIds(tenantId);
    const customerEmails = (
      await this.admin.customer.findMany({
        where: { tenantId, email: { not: null } },
        select: { email: true },
      })
    )
      .map((c) => c.email!.trim().toLowerCase())
      .filter(Boolean);

    const { unitsFreed, seriesReset } = await this.admin.$transaction(
      async (tx) => {
        for (const step of PURGE_STEPS) {
          await tx.$executeRawUnsafe(
            `DELETE FROM "${step.table}" WHERE tenant_id = $1::uuid${
              step.where ? ` AND (${step.where})` : ''
            }`,
            tenantId,
          );
        }
        // Los trasteros alquilados o reservados quedan libres; los que están
        // en mantenimiento o bloqueados conservan su estado.
        const freed = await tx.unit.updateMany({
          where: { tenantId, status: { in: ['occupied', 'reserved'] } },
          data: { status: 'available' },
        });
        // La numeración vuelve a empezar en 1.
        const series = await tx.invoiceSeries.updateMany({
          where: { tenantId },
          data: { nextNumber: 1, numberingYear: null },
        });
        await tx.coupon.updateMany({ where: { tenantId }, data: { usedCount: 0 } });
        await tx.promotion.updateMany({ where: { tenantId }, data: { usedCount: 0 } });
        await tx.marketingChannel.updateMany({ where: { tenantId }, data: { clickCount: 0 } });
        // Los gastos recurrentes vuelven a generar el mes en curso (sus gastos se han borrado).
        await tx.recurringExpense.updateMany({
          where: { tenantId },
          data: { lastGeneratedMonth: null },
        });
        // Las bajas comerciales de los inquilinos de prueba (las del tenant; los
        // rebotes de toda la plataforma se quedan).
        if (customerEmails.length > 0) {
          await tx.emailSuppression.deleteMany({
            where: { tenantId, email: { in: customerEmails, mode: 'insensitive' } },
          });
        }
        return { unitsFreed: freed.count, seriesReset: series.count };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    const filesDeleted = await this.deleteFiles(tenantId, waConversations);

    const result: TenantResetResultDto = { counts, unitsFreed, seriesReset, filesDeleted };
    await this.audit.record({
      superAdminId: args.superAdminId,
      action: 'admin.tenant.operational_data_reset',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { reason: input.reason, ...result },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    this.logger.warn(
      `Datos de prueba borrados del tenant ${tenant.slug}: ${JSON.stringify(result.counts)}`,
    );
    await this.notifyDone(tenant, input.reason, result).catch((err: unknown) =>
      this.logger.warn(
        `[tenant-reset] resumen no enviado: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return result;
  }

  // ------------------------------------------------------------- internos

  private async findTenant(tenantId: string) {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true, name: true, slug: true },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    return tenant;
  }

  private async countRows(table: string, tenantId: string, where?: string): Promise<number> {
    const rows = await this.admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "${table}" WHERE tenant_id = $1::uuid${
        where ? ` AND (${where})` : ''
      }`,
      tenantId,
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async counts(tenantId: string): Promise<Record<TenantResetCountKey, number>> {
    const entries = await Promise.all(
      TENANT_RESET_COUNT_KEYS.map(async (key) => {
        const src = COUNT_SOURCES[key];
        return [key, await this.countRows(src.table, tenantId, src.where)] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<TenantResetCountKey, number>;
  }

  /** Lo que impide vaciar (datos que ya son reales) y lo que conviene saber. */
  private async issues(tenantId: string): Promise<{
    blockers: TenantResetIssueDto<TenantResetBlockerCode>[];
    warnings: TenantResetIssueDto<TenantResetWarningCode>[];
  }> {
    const blockers: TenantResetIssueDto<TenantResetBlockerCode>[] = [];
    const warnings: TenantResetIssueDto<TenantResetWarningCode>[] = [];
    const aeatMode = this.config.get('AEAT_MODE', { infer: true });

    const [sentAny, holdedIssued, platformInvoices, holded, gateway, ownTenant, synced] =
      await Promise.all([
        this.countRows('invoices', tenantId, AEAT_SENT),
        this.countRows('invoices', tenantId, `issued_by = 'holded'`),
        this.countRows('invoices', tenantId, 'platform_payment_id IS NOT NULL'),
        this.countRows('invoices', tenantId, 'holded_document_id IS NOT NULL'),
        this.countRows(
          'payments',
          tenantId,
          `gateway_payment_id IS NOT NULL AND status IN ('succeeded', 'partially_refunded', 'refunded')`,
        ),
        this.admin.platformBillingSettings.findFirst({
          where: { ownTenantId: tenantId },
          select: { id: true },
        }),
        this.admin.accessCredentialSync.count({
          where: { tenantId },
        }),
      ]);

    if (aeatMode === 'production' && sentAny > 0) {
      blockers.push({
        code: 'aeat_production_invoices',
        count: sentAny,
        message: `Hay ${sentAny} facturas enviadas a la AEAT (aceptadas, pendientes o con error): son documentos fiscales y no se pueden borrar.`,
      });
    } else if (sentAny > 0) {
      warnings.push({
        code: 'aeat_sent_invoices',
        count: sentAny,
        message: `${sentAny} facturas se enviaron al entorno de pruebas de la AEAT (o están pendientes). Se borran igualmente.`,
      });
    }
    if (holdedIssued > 0) {
      blockers.push({
        code: 'holded_issued_invoices',
        count: holdedIssued,
        message: `Hay ${holdedIssued} facturas emitidas en Holded: tienen número y registro fiscal allí y no se pueden borrar desde aquí.`,
      });
    }
    if (ownTenant) {
      blockers.push({
        code: 'platform_own_tenant',
        count: 1,
        message: 'Es el negocio que emite las facturas de las suscripciones de la plataforma.',
      });
    } else if (platformInvoices > 0) {
      blockers.push({
        code: 'platform_invoices',
        count: platformInvoices,
        message: `Tiene ${platformInvoices} facturas de suscripciones de la plataforma.`,
      });
    }
    if (holded > 0) {
      warnings.push({
        code: 'holded_documents',
        count: holded,
        message: `${holded} facturas están copiadas en Holded: bórralas también allí.`,
      });
    }
    if (gateway > 0) {
      warnings.push({
        code: 'gateway_payments',
        count: gateway,
        message: `${gateway} cobros pasaron por una pasarela (Stripe, Redsys o GoCardless). Si alguno fue real, devuélvelo desde la pasarela antes.`,
      });
    }
    if (synced > 0) {
      warnings.push({
        code: 'synced_credentials',
        count: synced,
        message: `${synced} accesos de inquilinos están guardados en terminales de las puertas. Se quitarán de ellos antes de borrar; si algún terminal no responde, no se borrará nada.`,
      });
    }
    return { blockers, warnings };
  }

  /**
   * Quita de los terminales las credenciales de los inquilinos. Si alguna no se
   * puede quitar (terminal sin conexión), no se borra nada: quedaría abriendo.
   */
  private async revokeOnTerminals(tenantId: string): Promise<void> {
    const rows = await this.admin.accessCredentialSync.findMany({
      where: { tenantId },
      select: { credentialId: true },
      distinct: ['credentialId'],
    });
    for (const row of rows) {
      await this.sync.applyState(tenantId, row.credentialId, 'revoked');
    }
    if (rows.length === 0) return;
    const left = await this.admin.accessCredentialSync.findMany({
      where: { tenantId },
      select: { deviceId: true },
    });
    if (left.length > 0) {
      const ids = [...new Set(left.map((r) => r.deviceId))];
      const devices = (
        await this.admin.accessDevice.findMany({
          where: { id: { in: ids } },
          select: { name: true },
        })
      ).map((d) => d.name);
      throw new ConflictException({
        code: 'terminal_revoke_failed',
        message: `No se pudieron quitar ${left.length} accesos de ${devices.join(', ')}. Revisa la conexión del terminal y vuelve a intentarlo; no se ha borrado nada.`,
        details: { devices },
      });
    }
  }

  /**
   * Deja constancia para el super admin: aviso en el panel y resumen por correo
   * al email de alertas (si está configurado).
   */
  private async notifyDone(
    tenant: { id: string; name: string; slug: string },
    reason: string,
    result: TenantResetResultDto,
  ): Promise<void> {
    const lines = TENANT_RESET_COUNT_KEYS.filter((k) => result.counts[k] > 0).map(
      (k) => `- ${result.counts[k]} ${COUNT_LABELS[k]}`,
    );
    const summary = lines.length > 0 ? lines.join('\n') : '- No había nada que borrar.';
    const title = `Datos de prueba borrados: ${tenant.name}`;
    await this.admin.superAdminNotification.create({
      data: {
        type: 'tenant.reset',
        title,
        body: `${reason} — ${lines.length} tipos de datos, ${result.filesDeleted} ficheros`,
        link: `/admin/tenants/${tenant.id}`,
      },
    });
    const settings = await this.admin.platformAlertSettings.findFirst({
      select: { alertEmail: true },
    });
    const to = settings?.alertEmail?.trim();
    if (!to) return;
    const text = [
      `Se han borrado los datos de prueba de ${tenant.name} (${tenant.slug}).`,
      '',
      `Motivo: ${reason}`,
      '',
      summary,
      `- ${result.filesDeleted} ficheros`,
      `- ${result.unitsFreed} trasteros vuelven a estar libres`,
      `- ${result.seriesReset} series de facturación empiezan en 1`,
      '',
      'Se conservan los locales, los trasteros, los productos, los contactos, los usuarios y la configuración.',
    ].join('\n');
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;line-height:1.6">${text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')}</div>`;
    await this.emailQueue.add(JOB_EMAIL_SEND, {
      to,
      kind: 'staff_notice',
      subject: title,
      html,
      text,
    });
  }

  /**
   * Ficheros que se borran: PDF, documentos, fotos, adjuntos e informes; nunca
   * las exportaciones. La misma lista sirve para la vista previa y el borrado.
   */
  private fileTargets(tenantId: string, waConversationIds: string[]): FileTarget[] {
    return [
      { label: 'PDF de facturas', bucket: 'invoices', prefix: `${tenantId}/invoices/` },
      {
        label: 'Documentos de los inquilinos',
        bucket: 'uploads',
        prefix: `${tenantId}/customers/`,
      },
      {
        label: 'Contratos y fotos de inspección',
        bucket: 'uploads',
        prefix: `${tenantId}/contracts/`,
      },
      { label: 'Expedientes de impago', bucket: 'uploads', prefix: `${tenantId}/collections/` },
      { label: 'Adjuntos de los mensajes', bucket: 'uploads', prefix: `${tenantId}/chat/` },
      {
        label: 'Informes',
        bucket: 'reports',
        prefix: `${tenantId}/`,
        skip: (key) => key.startsWith(`${tenantId}/exports/`),
      },
      ...waConversationIds.map(
        (id): FileTarget => ({
          label: 'Archivos de WhatsApp',
          bucket: 'uploads',
          prefix: `${tenantId}/whatsapp/${id}/`,
        }),
      ),
    ];
  }

  private async waConversationIds(tenantId: string): Promise<string[]> {
    const rows = await this.admin.whatsappConversation.findMany({
      where: { tenantId, customerId: { not: null } },
      select: { id: true },
    });
    return rows.map((c) => c.id);
  }

  /** Cuántos ficheros se borrarían, agrupados por tipo. */
  private async fileSummary(tenantId: string): Promise<TenantResetFilesDto[]> {
    const targets = this.fileTargets(tenantId, await this.waConversationIds(tenantId));
    const sizes = await Promise.allSettled(
      targets.map((t) => this.files.sizeByPrefix(t.bucket, t.prefix, t.skip)),
    );
    const byLabel = new Map<string, TenantResetFilesDto>();
    sizes.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const label = targets[i]!.label;
      const row = byLabel.get(label) ?? { label, objects: 0, bytes: 0 };
      row.objects += r.value.objects;
      row.bytes += r.value.bytes;
      byLabel.set(label, row);
    });
    return [...byLabel.values()].filter((r) => r.objects > 0);
  }

  private async deleteFiles(tenantId: string, waConversationIds: string[]): Promise<number> {
    const results = await Promise.allSettled(
      this.fileTargets(tenantId, waConversationIds).map((t) =>
        this.files.deleteByPrefix(t.bucket, t.prefix, t.skip),
      ),
    );
    let total = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') total += r.value;
      else
        this.logger.warn(
          `No se pudo borrar un fichero del tenant ${tenantId}: ${String(r.reason)}`,
        );
    }
    return total;
  }
}
