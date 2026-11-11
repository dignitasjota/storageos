import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, type CustomerType } from '@storageos/database';
import { Queue } from 'bullmq';

import { emailLocale, formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { subtractAmounts } from '../../common/money';
import { invoiceInActivePlan } from '../../common/payment-plan-guard';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { isUniqueViolation } from '../../common/prisma-errors';
import { hasPaymentInFlight, NO_PAYMENT_IN_FLIGHT } from '../../common/sepa-remittance-guard';
import { tenantHasFeature } from '../../common/tenant-features';
import { AccessIntegrationsService } from '../access/access-integrations.service';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { InvoicesService } from '../billing/invoices.service';
import { buildReminderSummary } from '../billing/reminder-summary';
import { CollectionsService } from '../collections/collections.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import {
  JOB_DUNNING_EXECUTE_ACTION,
  JOB_DUNNING_PROCESS_INVOICE,
  QUEUE_DUNNING,
} from '../queues/queues.module';

import { dunningCalendar } from './dunning-calendar';

import type { Env } from '../../config/env.schema';

const DAY = 86_400_000;
/** Acciones por lote al despachar, y lotes como mucho por repaso. */
const DISPATCH_BATCH = 200;
const DISPATCH_MAX_BATCHES = 25;

/** `code` de una excepción del API (o null). */
function errorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'response' in err) {
    const res = (err as { response?: { code?: unknown } }).response;
    return typeof res?.code === 'string' ? res.code : null;
  }
  return null;
}

export interface ProcessInvoiceJobData {
  tenantId: string;
  invoiceId: string;
  /** Días vencidos al momento del enqueue (para idempotencia). */
  daysOverdue: number;
}

export interface ExecuteActionJobData {
  tenantId: string;
  actionId: string;
}

/**
 * Gestion de impagos. Estrategia:
 *
 * 1. **Cron diario** marca como `overdue` las invoices con
 *    `due_date < now()` que sigan en `issued` (lo dispara `DunningCron`).
 * 2. Encola un job `process-invoice` por cada factura recien overdue.
 * 3. El worker, segun los dias vencidos, programa una o varias
 *    `dunning_actions` en BD (`status = scheduled`, `scheduledFor`).
 *    Calendario por defecto:
 *      - dia +1: email_reminder (cordial)
 *      - dia +7: email_reminder (con recargo)
 *      - dia +14: access_block (bloqueo de acceso al trastero;
 *                 sincroniza con Fase 5)
 *      - dia +30: legal_notice (escalado manual al admin)
 * 4. El mismo cron diario despacha las acciones cuyo `scheduledFor <=
 *    now()` enviando emails/SMS o activando los flags correspondientes.
 *
 * NOTA Sub-bloque 14A.1: el `@Cron` y el `@Processor` se han extraido
 * a `DunningProcessor` (en `dunning.processor.ts`) para registrarlos
 * solo cuando `ENABLE_WORKERS_IN_API=true`. Este service queda como
 * logica pura y NO se registra como provider salvo cuando los workers
 * estan activos (porque no se usa desde ningun controller HTTP).
 */
@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);

  constructor(
    @InjectQueue(QUEUE_DUNNING) private readonly queue: Queue,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly communications: CommunicationsService,
    private readonly events: EventEmitter2,
    private readonly invoices: InvoicesService,
    private readonly config: ConfigService<Env, true>,
    private readonly access: AccessIntegrationsService,
    private readonly collections: CollectionsService,
  ) {}

  /**
   * Marca overdue + encola process-invoice por cada factura recien
   * vencida + ejecuta acciones pendientes. Llamado por `DunningProcessor`
   * desde el cron diario 06:00 UTC.
   */
  async dailyTick(): Promise<void> {
    // Tenant suspendido: el reloj de los impagos de sus inquilinos se para (cada
    // día se aplazan sus acciones un día, conservando el espacio entre ellas).
    // Al reactivarse sigue donde estaba, sin disparar todo de golpe.
    await this.admin.$executeRaw`
      UPDATE dunning_actions
         SET scheduled_for = scheduled_for + interval '1 day'
       WHERE status = 'scheduled'
         AND tenant_id IN (SELECT id FROM tenants WHERE status = 'suspended')`;
    // Candidatas: vencen como muy tarde hoy (UTC). Cada negocio cuenta en su
    // zona: el día del vencimiento aún se puede pagar; vence al día siguiente.
    const candidates = await this.admin.invoice.findMany({
      where: {
        status: 'issued',
        dueDate: { lt: new Date(Date.now() + DAY) },
        // Una rectificativa de abono (importe ≤ 0) no se reclama.
        total: { gt: 0 },
        // Un justificante de fianza no es una factura: se cobra con la suya
        // (reserva online) o en el local; no lleva recordatorios propios.
        kind: 'invoice',
        // Con un cobro en marcha (adeudo que liquida en días o remesa SEPA sin
        // confirmar) no se da por vencida: el inquilino ya está pagando.
        ...NO_PAYMENT_IN_FLIGHT,
      },
      select: {
        id: true,
        tenantId: true,
        dueDate: true,
        customerId: true,
        invoiceNumber: true,
        total: true,
        tenant: { select: { timezone: true } },
      },
    });
    const todayByZone = new Map<string, Date>();
    const todayIn = (tz: string) => {
      let d = todayByZone.get(tz);
      if (!d) {
        d = todayInTimezone(tz);
        todayByZone.set(tz, d);
      }
      return d;
    };
    const justOverdue = candidates.filter(
      (i) => i.dueDate && i.dueDate < todayIn(i.tenant.timezone ?? 'Europe/Madrid'),
    );
    if (justOverdue.length > 0) {
      await this.admin.invoice.updateMany({
        where: { id: { in: justOverdue.map((i) => i.id) } },
        data: { status: 'overdue' },
      });
      for (const inv of justOverdue) {
        const daysOverdue = this.daysBetween(inv.dueDate!, new Date());
        await this.queue.add(JOB_DUNNING_PROCESS_INVOICE, {
          tenantId: inv.tenantId,
          invoiceId: inv.id,
          daysOverdue,
        } satisfies ProcessInvoiceJobData);
        // Evento de dominio: dispara automations y los webhooks salientes
        // `invoice.overdue` (declarados desde Fase 14 pero sin emisor hasta
        // ahora, igual que le pasaba a invoice_issued).
        const payload: DomainEventPayload = {
          tenantId: inv.tenantId,
          entityType: 'invoice',
          entityId: inv.id,
          customerId: inv.customerId,
          recipientEmail: null,
          scope: {
            invoice: {
              number: inv.invoiceNumber,
              total: Number(inv.total).toFixed(2),
              dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
            },
          },
        };
        this.events.emit(DOMAIN_EVENTS.invoice_overdue, payload);
      }
      this.logger.log(`Marcadas ${justOverdue.length} facturas como overdue`);
    }
    // Despachar acciones programadas.
    await this.dispatchDueActions();
  }

  /** Dispatch del job BullMQ desde `DunningProcessor.process`. */
  async handleJob(
    jobName: string,
    data: ProcessInvoiceJobData | ExecuteActionJobData,
  ): Promise<{ ok: boolean }> {
    if (jobName === JOB_DUNNING_PROCESS_INVOICE) {
      await this.scheduleActions(data as ProcessInvoiceJobData);
      return { ok: true };
    }
    if (jobName === JOB_DUNNING_EXECUTE_ACTION) {
      await this.executeAction(data as ExecuteActionJobData);
      return { ok: true };
    }
    return { ok: false };
  }

  private async scheduleActions(data: ProcessInvoiceJobData): Promise<void> {
    const invoice = await this.admin.invoice.findUnique({
      where: { id: data.invoiceId },
      select: { dueDate: true, status: true, lateFeeForInvoiceId: true },
    });
    if (!invoice || (invoice.status !== 'issued' && invoice.status !== 'overdue')) return;
    if (!invoice.dueDate) return;
    const base = invoice.dueDate;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: data.tenantId },
      select: {
        lateFeeEnabled: true,
        lateFeeGraceDays: true,
        accessCutMode: true,
        accessCutDays: true,
        collectionsOpenAfterDays: true,
      },
    });
    const isLateFee = !!invoice.lateFeeForInvoiceId;
    const calendar = dunningCalendar(
      // Un recargo no lleva otro recargo.
      {
        enabled: !!tenant?.lateFeeEnabled && !isLateFee,
        graceDays: tenant?.lateFeeGraceDays ?? 0,
      },
      // Un recargo solo se recuerda: no corta el acceso ni abre un expediente
      // por sí solo (va con la factura de la que sale).
      isLateFee
        ? { mode: 'none', days: 0 }
        : { mode: tenant?.accessCutMode ?? 'all', days: tenant?.accessCutDays ?? 14 },
      tenant?.collectionsOpenAfterDays ?? 30,
    ).filter((step) => !isLateFee || step.type !== 'legal_notice');
    for (const step of calendar) {
      const scheduledFor = new Date(base);
      scheduledFor.setUTCDate(scheduledFor.getUTCDate() + step.daysAfter);
      // Si ya existe una accion del mismo tipo para esta invoice, no duplicar.
      const existing = await this.admin.dunningAction.findFirst({
        where: {
          tenantId: data.tenantId,
          invoiceId: data.invoiceId,
          actionType: step.type,
          status: { in: ['scheduled', 'executed'] },
          supersededAt: null,
        },
      });
      if (existing) continue;
      try {
        await this.admin.dunningAction.create({
          data: {
            tenantId: data.tenantId,
            invoiceId: data.invoiceId,
            actionType: step.type,
            status: 'scheduled',
            scheduledFor,
          },
        });
      } catch (err) {
        // Índice parcial dunning_actions_active_unique: otro run concurrente ya
        // agendó este paso → idempotente, se salta.
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
  }

  /** Acciones que tocan hoy, por lotes y de la más antigua a la más nueva. */
  private async dispatchDueActions(): Promise<void> {
    const now = new Date();
    let cursor: string | null = null;
    for (let batch = 0; batch < DISPATCH_MAX_BATCHES; batch += 1) {
      const due: { id: string; tenantId: string }[] = await this.admin.dunningAction.findMany({
        where: {
          status: 'scheduled',
          scheduledFor: { lte: now },
          tenant: { status: { not: 'suspended' } },
        },
        select: { id: true, tenantId: true },
        orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
        take: DISPATCH_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (due.length > 0) {
        await this.queue.addBulk(
          due.map((action) => ({
            name: JOB_DUNNING_EXECUTE_ACTION,
            data: {
              tenantId: action.tenantId,
              actionId: action.id,
            } satisfies ExecuteActionJobData,
          })),
        );
      }
      if (due.length < DISPATCH_BATCH) return;
      cursor = due[due.length - 1]!.id;
    }
    this.logger.warn('dunning: más acciones pendientes de las que caben en un repaso');
  }

  /** La acción no toca hoy (se está cobrando o hay un plan): mañana se vuelve a mirar. */
  private async postpone(actionId: string): Promise<void> {
    await this.admin.dunningAction.updateMany({
      where: { id: actionId, status: 'scheduled' },
      data: { scheduledFor: new Date(Date.now() + DAY) },
    });
  }

  private async executeAction(data: ExecuteActionJobData): Promise<void> {
    const action = await this.admin.dunningAction.findUnique({
      where: { id: data.actionId },
    });
    if (!action || action.status !== 'scheduled') return;
    const invoice = await this.admin.invoice.findUnique({
      where: { id: action.invoiceId },
      select: {
        status: true,
        customerId: true,
        contractId: true,
        invoiceNumber: true,
        total: true,
        amountPaid: true,
        amountRefunded: true,
        dueDate: true,
        customer: {
          select: {
            email: true,
            billingEmail: true,
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
            locale: true,
          },
        },
      },
    });
    // Solo se reclama lo que sigue pendiente: pagada, anulada con una
    // rectificativa (`rectified`), reembolsada o cancelada → la acción se cancela.
    if (!invoice || (invoice.status !== 'issued' && invoice.status !== 'overdue')) {
      await this.admin.dunningAction.update({
        where: { id: action.id },
        data: { status: 'cancelled', executedAt: new Date() },
      });
      return;
    }
    // Cobro en marcha: no se reclama, ni se recarga, ni se corta el acceso. La
    // acción sigue programada y se vuelve a mirar al día siguiente (si el cobro
    // se confirma, la factura queda pagada y la acción se cancela; si falla, se
    // ejecuta entonces).
    if (await hasPaymentInFlight(this.admin, action.invoiceId)) {
      this.logger.log(
        `dunning.${action.actionType}: ${invoice.invoiceNumber} tiene un cobro en curso; se aplaza`,
      );
      await this.postpone(action.id);
      return;
    }

    // Plan de pago activo y al día: el escalado se pausa (la acción sigue
    // programada; si el plan se rompe o se cancela, se ejecuta entonces).
    if (await invoiceInActivePlan(this.admin, action.invoiceId)) {
      this.logger.log(
        `dunning.${action.actionType}: ${invoice.invoiceNumber} está en un plan de pago; se aplaza`,
      );
      await this.postpone(action.id);
      return;
    }

    // Fase 8D: efectos colaterales segun action_type:
    //   - email_reminder: encolar email via CommunicationsService (outbox).
    //   - access_block: suspender credenciales del customer via
    //     AccessIntegrationsService.suspendForDunning (Fase 7+8).
    //   - legal_notice: alerta al admin via audit; sin efecto automatico.
    let result: Record<string, string | boolean | number> = { action: action.actionType };
    try {
      if (action.actionType === 'email_reminder' || action.actionType === 'email_reminder_final') {
        // Varias facturas del inquilino con recordatorio hoy: un solo correo.
        // Agrupar es una ayuda: si falla, sale el recordatorio de esta sola.
        const merged = await this.sendMergedReminder(action, invoice).catch((err: unknown) => {
          this.logger.warn(
            `dunning.${action.actionType}: no se ha podido agrupar ${invoice.invoiceNumber} (${err instanceof Error ? err.message : String(err)}); va sola`,
          );
          return null;
        });
        if (merged) {
          result = { ...result, emailEnqueued: true, invoicesInEmail: merged };
        } else {
          const sent = await this.sendReminderEmail(
            action.tenantId,
            action.invoiceId,
            invoice,
            action.actionType === 'email_reminder_final' ? 'final' : 'first',
          );
          result = { ...result, emailEnqueued: sent };
        }
      }
      if (action.actionType === 'access_block') {
        // `accessBlocked` dice lo que pasó de verdad: el panel, el área de
        // clientes y la vuelta del acceso al pagar se fían de este dato.
        const cut = invoice.customerId
          ? await this.access.suspendForDunning({
              tenantId: action.tenantId,
              customerId: invoice.customerId,
              invoiceId: action.invoiceId,
            })
          : ({ applied: false, skipped: 'no_customer' } as const);
        result = cut.applied
          ? { ...result, accessBlocked: true, suspended: cut.suspended }
          : { ...result, accessBlocked: false, accessCutSkipped: cut.skipped };
      }
      if (action.actionType === 'legal_notice') {
        // Abre un expediente de impago si el negocio los usa; si no (o el
        // contrato ya terminó), avisa al equipo de que toca decidir qué hacer.
        const outcome = await this.collections.openFromDunning(action.tenantId, action.invoiceId);
        result = {
          ...result,
          collectionsCaseOpened: outcome === 'opened' || outcome === 'exists',
          outcome,
        };
      }
      if (action.actionType === 'late_fee') {
        // Re-chequea el opt-in (pudo desactivarse tras agendar). Idempotente:
        // createLateFee lanza si ya existe un recargo para esta factura.
        const tenant = await this.admin.tenant.findUnique({
          where: { id: action.tenantId },
          select: { lateFeeEnabled: true },
        });
        if (tenant?.lateFeeEnabled) {
          try {
            const fee = await this.invoices.createLateFee({
              tenantId: action.tenantId,
              invoiceId: action.invoiceId,
              userId: null,
            });
            result = { ...result, lateFeeInvoiceId: fee.id };
          } catch (err) {
            // Ya tenía recargo (puesto a mano): el paso está hecho.
            if (errorCode(err) !== 'late_fee_already_applied') throw err;
            result = { ...result, lateFeeSkipped: 'already_applied' };
          }
        } else {
          result = { ...result, lateFeeSkipped: 'disabled' };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Un corte o un recargo que fallan no se dan por hechos: siguen
      // programados y se reintentan en el repaso del día siguiente.
      if (action.actionType === 'access_block' || action.actionType === 'late_fee') {
        this.logger.error(
          `dunning.${action.actionType} sin aplicar en ${action.invoiceId}: ${message}`,
        );
        await this.admin.dunningAction.update({
          where: { id: action.id },
          data: {
            notes: `Último intento fallido: ${message}`.slice(0, 500),
            scheduledFor: new Date(Date.now() + DAY),
          },
        });
        return;
      }
      result = { ...result, error: message };
      this.logger.warn(
        `dunning.${action.actionType} fallo lateral pero marcamos executed: ${message}`,
      );
    }
    await this.admin.dunningAction.update({
      where: { id: action.id },
      data: {
        status: 'executed',
        executedAt: new Date(),
        result,
      },
    });
    await this.audit.write({
      tenantId: action.tenantId,
      action: `dunning.${action.actionType}.executed`,
      entityType: 'DunningAction',
      entityId: action.id,
      changes: { invoiceId: action.invoiceId, invoiceNumber: invoice.invoiceNumber },
    });
    this.logger.log(`Dunning ${action.actionType} ejecutada para invoice ${action.invoiceId}`);
  }

  /**
   * Encola el recordatorio de pago en el outbox de comunicaciones usando la
   * plantilla `invoice_overdue_email` (trigger `invoice_overdue`, que aplica
   * su whitelist de variables). Devuelve `false` sin lanzar cuando no hay
   * customer o email — un impago de una factura simplificada (F2) sin
   * destinatario es valido y no debe romper la ejecucion de la accion.
   */
  private async sendReminderEmail(
    tenantId: string,
    invoiceId: string,
    invoice: {
      invoiceNumber: string;
      total: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
      amountRefunded: Prisma.Decimal;
      dueDate: Date | null;
      customerId: string | null;
      contractId: string | null;
      customer: {
        email: string | null;
        billingEmail?: string | null;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        customerType: CustomerType;
        locale?: string | null;
      } | null;
    },
    stage: 'first' | 'final' = 'first',
  ): Promise<boolean> {
    const customer = invoice.customer;
    const locale = emailLocale(customer?.locale);
    if (!invoice.customerId || !customer?.email) {
      this.logger.warn(
        `dunning.email_reminder: factura ${invoice.invoiceNumber} sin customer/email; no se envia recordatorio`,
      );
      return false;
    }

    const amountPending = subtractAmounts(
      subtractAmounts(invoice.total, invoice.amountPaid),
      invoice.amountRefunded,
    );
    const daysOverdue = invoice.dueDate ? this.daysBetween(invoice.dueDate, new Date()) : 0;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    // El primer aviso lo sustituye una automatización propia de «factura
    // vencida» si el tenant la tiene activa (si no, el inquilino recibiría dos).
    if (stage === 'first' && (await this.hasOverdueAutomation(tenantId))) {
      this.logger.log(
        `dunning.email_reminder: ${invoice.invoiceNumber} lo cubre una automatización del tenant`,
      );
      return false;
    }

    // El segundo aviso solo menciona el corte si de verdad va a llegar.
    const cutAhead = stage === 'final' && (await this.accessCutAhead(tenantId, [invoiceId]));
    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: customer.billingEmail ?? customer.email,
      invoiceId,
      contractId: invoice.contractId,
      templateCode:
        stage === 'final'
          ? cutAhead
            ? 'invoice_overdue_final_email'
            : 'invoice_overdue_final_nocut_email'
          : 'invoice_overdue_email',
      trigger: 'invoice_overdue',
      variables: {
        customer: {
          firstName: customer.firstName ?? '',
          displayName: this.customerDisplayName(customer),
        },
        invoice: {
          number: invoice.invoiceNumber,
          total: formatEur(invoice.total, locale),
          amountPending: formatEur(amountPending, locale),
          dueDate: invoice.dueDate ? formatDateLong(invoice.dueDate, 'Europe/Madrid', locale) : '',
          daysOverdue,
        },
        portal: {
          url: tenant
            ? tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant)
            : '',
        },
        tenant: { name: tenant?.name ?? '' },
      },
      customerId: invoice.customerId,
      source: stage === 'final' ? 'dunning.email_reminder_final' : 'dunning.email_reminder',
    });
    this.logger.log(
      `dunning.email_reminder: recordatorio encolado para invoice ${invoiceId} -> ${customer.email}`,
    );
    return true;
  }

  /**
   * Un inquilino con varias facturas a las que les toca recordatorio en las
   * próximas horas recibe UN correo que las lista; las demás acciones quedan
   * hechas («en el mismo correo»). Devuelve cuántas facturas lleva, o null si
   * no hay otras (sale el recordatorio de siempre).
   */
  private async sendMergedReminder(
    action: { id: string; tenantId: string; invoiceId: string; actionType: string },
    invoice: {
      invoiceNumber: string;
      total: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
      amountRefunded: Prisma.Decimal;
      dueDate: Date | null;
      customerId: string | null;
      customer: {
        email: string | null;
        billingEmail?: string | null;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        customerType: CustomerType;
        locale?: string | null;
      } | null;
    },
  ): Promise<number | null> {
    const email = invoice.customer?.billingEmail ?? invoice.customer?.email;
    if (!invoice.customerId || !email) return null;
    const final = action.actionType === 'email_reminder_final';
    const siblings = await this.admin.dunningAction.findMany({
      where: {
        tenantId: action.tenantId,
        actionType: action.actionType as 'email_reminder' | 'email_reminder_final',
        status: 'scheduled',
        supersededAt: null,
        id: { not: action.id },
        invoiceId: { not: action.invoiceId },
        scheduledFor: { lte: new Date(Date.now() + 18 * 3_600_000) },
        invoice: {
          customerId: invoice.customerId,
          status: { in: ['issued', 'overdue'] },
          deletedAt: null,
          ...NO_PAYMENT_IN_FLIGHT,
        },
      },
      select: {
        id: true,
        invoiceId: true,
        invoice: {
          select: {
            invoiceNumber: true,
            total: true,
            amountPaid: true,
            amountRefunded: true,
            dueDate: true,
          },
        },
      },
    });
    const eligible: typeof siblings = [];
    for (const s of siblings) {
      if (!(await invoiceInActivePlan(this.admin, s.invoiceId))) eligible.push(s);
    }
    if (eligible.length === 0) return null;
    // El primer aviso lo sustituye una automatización propia si la hay.
    if (!final && (await this.hasOverdueAutomation(action.tenantId))) return null;

    const tenant = await this.admin.tenant.findUnique({
      where: { id: action.tenantId },
      select: {
        name: true,
        slug: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        timezone: true,
      },
    });
    if (!tenant) return null;
    const pending = (i: {
      total: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
      amountRefunded: Prisma.Decimal;
    }) => subtractAmounts(subtractAmounts(i.total, i.amountPaid), i.amountRefunded);
    // Se reservan antes de enviar: dos procesos a la vez no mandan dos correos,
    // y si el envío falla vuelven a quedar programadas.
    const claimed: typeof eligible = [];
    for (const s of eligible) {
      const { count } = await this.admin.dunningAction.updateMany({
        where: { id: s.id, status: 'scheduled' },
        data: {
          status: 'executed',
          executedAt: new Date(),
          result: { action: action.actionType, emailEnqueued: true, mergedInto: action.id },
        },
      });
      if (count === 1) claimed.push(s);
    }
    if (claimed.length === 0) return null;
    const list = [
      {
        id: action.invoiceId,
        number: invoice.invoiceNumber,
        pending: pending(invoice),
        dueDate: invoice.dueDate,
      },
      ...claimed.map((s) => ({
        id: s.invoiceId,
        number: s.invoice.invoiceNumber,
        pending: pending(s.invoice),
        dueDate: s.invoice.dueDate,
      })),
    ];
    const summary = buildReminderSummary({
      tenantName: tenant.name,
      customerName:
        (invoice.customer?.customerType === 'business'
          ? invoice.customer.companyName
          : invoice.customer?.firstName) ?? '',
      locale: emailLocale(invoice.customer?.locale),
      invoices: list,
      portalUrl: tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant),
      final,
      accessCutAhead: final
        ? await this.accessCutAhead(
            action.tenantId,
            list.map((i) => i.id),
          )
        : false,
      today: todayInTimezone(tenant.timezone),
    });
    try {
      await this.communications.enqueue({
        tenantId: action.tenantId,
        channel: 'email',
        recipient: email,
        subject: summary.subject,
        bodyText: summary.text,
        customerId: invoice.customerId,
        invoiceId: action.invoiceId,
        variables: { invoiceIds: list.map((i) => i.id) },
        source: 'dunning.reminder_summary',
      });
    } catch (err) {
      await this.admin.dunningAction.updateMany({
        where: { id: { in: claimed.map((s) => s.id) } },
        data: { status: 'scheduled', executedAt: null, result: Prisma.DbNull },
      });
      throw err;
    }
    return list.length;
  }

  /** ¿Queda un corte del acceso programado para alguna de estas facturas? */
  private async accessCutAhead(tenantId: string, invoiceIds: string[]): Promise<boolean> {
    const pending = await this.admin.dunningAction.count({
      where: {
        tenantId,
        invoiceId: { in: invoiceIds },
        actionType: 'access_block',
        status: 'scheduled',
        supersededAt: null,
      },
    });
    return pending > 0;
  }

  private async hasOverdueAutomation(tenantId: string): Promise<boolean> {
    const rules = await this.admin.automationRule.count({
      where: { tenantId, trigger: 'invoice_overdue', isActive: true, actionType: 'send_email' },
    });
    return rules > 0 && (await tenantHasFeature(this.admin, tenantId, 'automations'));
  }

  private customerDisplayName(c: {
    customerType: CustomerType;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  }): string {
    if (c.customerType === 'business') return c.companyName ?? 'Empresa sin nombre';
    return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
  }

  private daysBetween(a: Date, b: Date): number {
    const ms = b.getTime() - a.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }
}
