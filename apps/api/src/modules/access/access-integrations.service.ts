import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';

import { ACCESS_CUT_APPLIED_WHERE } from '../../common/access-cut';
import { CryptoService } from '../../common/crypto/crypto.service';
import { todayInTimezone, zonedDayStart } from '../../common/format';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';
import { PAYABLE_INVOICE_WHERE } from '../../common/sepa-remittance-guard';
import {
  type ContractPreOpeningStartedPayload,
  ContractUnitChangedPayload,
  DOMAIN_EVENTS,
  type DomainEventPayload,
  type InvoiceVoidedPayload,
} from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { AccessCredentialsService } from './access-credentials.service';

import type { Env } from '../../config/env.schema';

/** Qué ha hecho el corte por impago de una factura. */
export type AccessCutOutcome =
  | { applied: true; suspended: number }
  | { applied: false; skipped: string };

/**
 * Fase 8D: integraciones del modulo de accesos con el dominio.
 *
 *   - `contract.signed` -> emitir PIN para el inquilino y enviar email
 *     usando la plantilla `access_credential_issued_email`.
 *   - `invoice.overdue / dunning access_block` -> suspender credenciales
 *     del customer (entry point lo invoca DunningService).
 *   - `invoice.paid` -> reanudar credenciales suspendidas por dunning.
 */
@Injectable()
export class AccessIntegrationsService {
  private readonly logger = new Logger(AccessIntegrationsService.name);

  constructor(
    private readonly credentials: AccessCredentialsService,
    private readonly communications: CommunicationsService,
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Emite un PIN para el inquilino y le manda el email con el código. Lo usan
   * tanto el alta por firma de contrato como la auto-emisión al primer pago.
   */
  private async issueCredential(args: {
    tenantId: string;
    customerId: string;
    source: string;
    label: string | null;
    recipientEmail: string | null;
    scope: {
      customer?: Record<string, unknown>;
      unit?: Record<string, unknown>;
      facility?: Record<string, unknown>;
      tenant?: Record<string, unknown>;
    };
    entityId?: string;
  }): Promise<void> {
    // Scope de la credencial = los locales y trasteros de los contratos VIVOS
    // del inquilino (sin esto un PIN abría CUALQUIER cerradura del tenant). Si
    // no tiene ningún contrato vivo NO se emite: un scope vacío significaría
    // «sin restricción», y un ex-inquilino que paga una deuda antigua recibiría
    // un PIN que abre todas las puertas.
    const { facilityIds, unitIds, unitCode, facilityName, validFrom } =
      await this.resolveCustomerScope(args.tenantId, args.customerId);
    if (facilityIds.length === 0) {
      this.logger.warn(
        `${args.source}: el inquilino ${args.customerId} no tiene contratos vivos; no se emite acceso (tenant=${args.tenantId})`,
      );
      return;
    }
    const created = await this.credentials.create({
      tenantId: args.tenantId,
      userId: null,
      input: {
        customerId: args.customerId,
        method: 'pin',
        label: args.label,
        allowedFacilityIds: facilityIds,
        allowedUnitIds: unitIds,
        allowedHours: { windows: [] },
        bypassCurfew: false,
        metadata: { source: args.source, entityId: args.entityId },
      } as Parameters<AccessCredentialsService['create']>[0]['input'],
      validFrom,
      meta: {},
    });
    if (!args.recipientEmail || !created.revealedSecret) {
      this.logger.warn(
        `${args.source}: credencial creada pero no se envia email (sin recipient o sin secret) tenant=${args.tenantId}`,
      );
      return;
    }
    const tenant = await this.admin.tenant.findUnique({
      where: { id: args.tenantId },
      select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    await this.communications.enqueue({
      tenantId: args.tenantId,
      channel: 'email',
      recipient: args.recipientEmail,
      templateCode: 'access_credential_issued_email',
      variables: {
        customer: args.scope.customer ?? {},
        credential: { secret: created.revealedSecret },
        // Los eventos no siempre traen trastero/local/tenant (el del primer
        // pago no los trae): se completan con el contrato vivo y el tenant.
        unit: args.scope.unit?.code ? args.scope.unit : { code: unitCode ?? '' },
        facility: args.scope.facility?.name ? args.scope.facility : { name: facilityName ?? '' },
        tenant: { name: tenant?.name ?? '' },
        // El área de clientes muestra siempre el PIN y el QR.
        portal: {
          url: tenant
            ? tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant)
            : '',
        },
      },
      // El correo lleva el PIN, pero el historial guarda «••••».
      secretVariables: ['credential.secret'],
      customerId: args.customerId,
      // El PIN se emite al firmar (entityId = contrato) o al pagar la 1ª factura
      // (entityId = factura): se enlaza el recurso que lo originó.
      ...(args.source === 'contract_signed' ? { contractId: args.entityId } : {}),
      ...(args.source === 'invoice_paid' ? { invoiceId: args.entityId } : {}),
      source: `access.${args.source}`,
    });
    this.logger.log(
      `${args.source}: credencial PIN emitida + email encolado tenant=${args.tenantId} customer=${args.customerId}`,
    );
  }

  /**
   * Locales (facilities) y trasteros (units) de los contratos `active`/`ending`
   * del inquilino — el alcance físico al que su credencial debe dar acceso.
   */
  private async resolveCustomerScope(
    tenantId: string,
    customerId: string,
  ): Promise<{
    facilityIds: string[];
    unitIds: string[];
    unitCode: string | null;
    facilityName: string | null;
    /** Si todos sus contratos empiezan más adelante, desde cuándo vale el acceso. */
    validFrom: Date | null;
  }> {
    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            customerId,
            status: { in: ['active', 'ending'] },
            ...STARTED_CONTRACT_WHERE,
            deletedAt: null,
          },
          orderBy: { startDate: 'desc' },
          select: {
            unitId: true,
            startDate: true,
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true, timezone: true } },
              },
            },
          },
        }),
      tenantId,
    );
    // Firmado con entrada futura: el acceso empieza ese día, no al firmar.
    const earliest = contracts[contracts.length - 1];
    const tz = earliest?.unit.facility.timezone ?? 'Europe/Madrid';
    const validFrom =
      earliest && earliest.startDate > todayInTimezone(tz)
        ? zonedDayStart(earliest.startDate.toISOString().slice(0, 10), tz)
        : null;
    const facilityIds = [
      ...new Set(contracts.map((c) => c.unit?.facilityId).filter((x): x is string => !!x)),
    ];
    const unitIds = [...new Set(contracts.map((c) => c.unitId).filter((x): x is string => !!x))];
    const latest = contracts[0]?.unit;
    return {
      facilityIds,
      unitIds,
      unitCode: latest?.code ?? null,
      facilityName: latest?.facility?.name ?? null,
      validFrom,
    };
  }

  /**
   * ¿Tiene el inquilino ya un acceso propio (de cualquier tipo) que no esté
   * revocado ni caducado? Cuenta también los suspendidos (el staff pudo
   * cortarlo por seguridad) y las tarjetas/caras; excluye los pases de un
   * solo uso (pase nocturno).
   */
  private async hasOwnCredential(tenantId: string, customerId: string): Promise<boolean> {
    const count = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.count({
          where: {
            customerId,
            status: { in: ['pending', 'active', 'suspended'] },
            maxUses: null,
          },
        }),
      tenantId,
    );
    return count > 0;
  }

  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onContractSigned(payload: DomainEventPayload): Promise<void> {
    if (!payload.customerId) return;
    const scope = (payload.scope ?? {}) as {
      customer?: { firstName?: string };
      contract?: { number?: string };
      unit?: { code?: string };
      facility?: { name?: string };
      tenant?: { name?: string };
      deferAccess?: boolean;
    };
    // Reserva online con pago obligatorio: el acceso NO se emite al firmar; se
    // emite al pagar la 1ª factura (listener invoice_paid → issueCredential).
    if (scope.deferAccess) {
      this.logger.log(
        `contract.signed: emisión de acceso diferida al primer pago tenant=${payload.tenantId} customer=${payload.customerId}`,
      );
      return;
    }
    try {
      await this.issueCredential({
        tenantId: payload.tenantId,
        customerId: payload.customerId,
        source: 'contract_signed',
        label: scope.contract?.number ? `Contrato ${scope.contract.number}` : null,
        recipientEmail: payload.recipientEmail ?? null,
        scope: scope as Parameters<typeof this.issueCredential>[0]['scope'],
        entityId: payload.entityId,
      });
    } catch (err) {
      this.logger.error(
        `contract.signed: fallo en integracion access tenant=${payload.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Cola por inquilino (en este proceso): los avisos se atienden de uno en uno. */
  private readonly queues = new Map<string, Promise<void>>();

  private async serialized(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    try {
      await next;
    } finally {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  /**
   * Factura y justificante de fianza que se cobran juntos (reserva online):
   * el acceso no se emite hasta que estén pagados los dos.
   */
  private async bundleSettled(tenantId: string, invoiceId: string): Promise<boolean> {
    const doc = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id: invoiceId },
          select: { id: true, bundledWithInvoiceId: true },
        }),
      tenantId,
    );
    if (!doc) return true;
    const rootId = doc.bundledWithInvoiceId ?? doc.id;
    const unpaid = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.count({
          where: {
            AND: [
              { OR: [{ id: rootId }, { bundledWithInvoiceId: rootId }] },
              PAYABLE_INVOICE_WHERE,
            ],
            deletedAt: null,
          },
        }),
      tenantId,
    );
    return unpaid === 0;
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(payload: DomainEventPayload): Promise<void> {
    if (!payload.customerId) return;
    const customerId = payload.customerId;
    try {
      // 1. Devuelve el acceso cortado por impago, si ya no queda deuda por él.
      await this.restoreIfDebtCleared(payload.tenantId, customerId);
      // 2. Auto-emisión al primer pago: solo si el inquilino aún no tiene
      //    NINGÚN acceso propio (p. ej. reserva online «pago primero»). Un
      //    acceso suspendido por el staff, una tarjeta o una cara cuentan: no se
      //    le da un PIN nuevo en cada factura pagada. Sin contratos vivos
      //    tampoco se emite (lo comprueba issueCredential).
      // Serializado por inquilino: dos «pagada» casi a la vez (factura y su
      // justificante de fianza cobrados juntos) no emiten dos accesos.
      await this.serialized(customerId, async () => {
        if (
          (await this.bundleSettled(payload.tenantId, payload.entityId)) &&
          !(await this.hasOwnCredential(payload.tenantId, customerId))
        ) {
          const customer = await this.prisma.withTenant(
            (tx) =>
              tx.customer.findFirst({
                where: { id: customerId, tenantId: payload.tenantId, deletedAt: null },
                select: { email: true, firstName: true, lastName: true, companyName: true },
              }),
            payload.tenantId,
          );
          if (customer) {
            await this.issueCredential({
              tenantId: payload.tenantId,
              customerId,
              source: 'invoice_paid',
              label: 'Acceso',
              recipientEmail: customer.email ?? null,
              scope: { customer: { firstName: customer.firstName ?? '' } },
            });
          }
        }
      });
      this.logger.log(
        `invoice.paid: credenciales reactivadas/emitidas (si procede) tenant=${payload.tenantId} customer=${customerId}`,
      );
    } catch (err) {
      this.logger.warn(
        `invoice.paid resume fallo tenant=${payload.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Anulada o sustituida: esa factura ya no se debe. */
  @OnEvent(DOMAIN_EVENTS.invoice_voided, { async: true, promisify: true })
  async onInvoiceVoided(payload: InvoiceVoidedPayload): Promise<void> {
    try {
      const invoice = await this.admin.invoice.findFirst({
        where: { id: payload.invoiceId, tenantId: payload.tenantId },
        select: { customerId: true },
      });
      if (invoice?.customerId) {
        await this.restoreIfDebtCleared(payload.tenantId, invoice.customerId);
      }
    } catch (err) {
      this.logger.warn(
        `invoice.voided tenant=${payload.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Reactiva SOLO las credenciales suspendidas por impago (no las que el staff
   * suspendió por seguridad), y solo si ya no queda ninguna otra factura sin
   * pagar por la que se le cortó el acceso. Idempotente.
   */
  private async restoreIfDebtCleared(tenantId: string, customerId: string): Promise<void> {
    const stillBlocked = await this.prisma.withTenant(
      (tx) =>
        tx.dunningAction.count({
          where: {
            ...ACCESS_CUT_APPLIED_WHERE,
            invoice: { customerId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
          },
        }),
      tenantId,
    );
    if (stillBlocked > 0) return;
    // Sin contratos vivos no se reactiva nada: quien paga una deuda antigua ya
    // no tiene trastero (el repaso periódico le retira lo que quede).
    const liveContracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.count({
          where: {
            customerId,
            status: { in: ['active', 'ending'] },
            ...STARTED_CONTRACT_WHERE,
            deletedAt: null,
          },
        }),
      tenantId,
    );
    if (liveContracts === 0) return;
    await this.credentials.resume({
      tenantId,
      userId: null,
      customerId,
      onlyIfReasonStartsWith: 'dunning:',
      meta: {},
    });
  }

  /**
   * Llamado desde `DunningService.executeAction` cuando el `action_type`
   * es `access_block`. No usa EventEmitter porque el dunning quiere saber
   * si el corte se aplicó antes de marcar la acción como ejecutada. Si falla,
   * lanza: la acción sigue programada y se reintenta.
   */
  async suspendForDunning(args: {
    tenantId: string;
    customerId: string;
    invoiceId: string;
  }): Promise<AccessCutOutcome> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: args.tenantId },
      select: { accessCutMode: true },
    });
    if (tenant?.accessCutMode === 'none') return { applied: false, skipped: 'mode_none' };
    const reason = `dunning:invoice-${args.invoiceId}`;
    const suspended =
      tenant?.accessCutMode === 'extras'
        ? await this.credentials.suspendExtras(args.tenantId, args.customerId, reason)
        : (
            await this.credentials.suspend({
              tenantId: args.tenantId,
              userId: null,
              customerId: args.customerId,
              input: { reason },
              meta: {},
              // Sin nada que cortar el corte vale igual: no podrá darse otro acceso.
              allowNone: true,
            } as Parameters<AccessCredentialsService['suspend']>[0])
          ).length;
    this.logger.log(
      `access_block ejecutado tenant=${args.tenantId} customer=${args.customerId} invoice=${args.invoiceId}`,
    );
    return { applied: true, suspended };
  }

  /** Vuelve a mandar al inquilino su código por correo. */
  async resendCode(
    tenantId: string,
    customerId: string,
    facilityScope: string[] | null,
  ): Promise<{ sentTo: string }> {
    await this.credentials.assertCustomerAllowed(tenantId, customerId, facilityScope);
    const data = await this.prisma.withTenant(async (tx) => {
      const [customer, credential] = await Promise.all([
        tx.customer.findFirst({
          where: { id: customerId },
          select: { firstName: true, lastName: true, companyName: true, email: true },
        }),
        tx.accessCredential.findFirst({
          where: {
            customerId,
            status: 'active',
            method: 'pin',
            secretEncrypted: { not: null },
            maxUses: null,
          },
          orderBy: { createdAt: 'desc' },
          select: { secretEncrypted: true },
        }),
      ]);
      return { customer, credential };
    }, tenantId);
    if (!data.customer?.email) {
      throw new BadRequestException({
        code: 'customer_without_email',
        message: 'Este inquilino no tiene correo',
      });
    }
    if (!data.credential?.secretEncrypted) {
      throw new BadRequestException({
        code: 'no_code_to_resend',
        message: 'No tiene ningún PIN activo que se pueda reenviar',
      });
    }
    const { unitCode, facilityName } = await this.resolveCustomerScope(tenantId, customerId);
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: data.customer.email,
      templateCode: 'access_credential_issued_email',
      variables: {
        customer: data.customer,
        credential: {
          secret: this.crypto.decryptString(data.credential.secretEncrypted, tenantId),
        },
        unit: { code: unitCode ?? '' },
        facility: { name: facilityName ?? '' },
        tenant: { name: tenant?.name ?? '' },
        portal: {
          url: tenant
            ? tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant)
            : '',
        },
      },
      secretVariables: ['credential.secret'],
      customerId,
      source: 'access.code_resent',
    });
    return { sentTo: data.customer.email };
  }

  /**
   * Abre el local de una reserva anticipada: el inquilino que ya pagó la reserva
   * recibe su acceso (o el que ya tenía pasa a abrir también este trastero).
   * Si aún no la pagó, el acceso llegará al pagarla (listener invoice_paid).
   */
  @OnEvent(DOMAIN_EVENTS.contract_pre_opening_started, { async: true, promisify: true })
  async onPreOpeningStarted(payload: ContractPreOpeningStartedPayload): Promise<void> {
    try {
      const unpaid = await this.prisma.withTenant(
        (tx) =>
          tx.invoice.count({
            where: {
              contractId: payload.contractId,
              // La fianza en efectivo se cobra en el local: no retrasa el acceso
              // (como en un alta normal, basta con la mensualidad pagada).
              kind: 'invoice',
              status: { in: ['draft', 'issued', 'overdue'] },
              deletedAt: null,
            },
          }),
        payload.tenantId,
      );
      if (unpaid > 0) return;
      await this.serialized(payload.customerId, async () => {
        if (await this.hasOwnCredential(payload.tenantId, payload.customerId)) {
          await this.credentials.rescopeForCustomer(payload.tenantId, payload.customerId);
          return;
        }
        const customer = await this.prisma.withTenant(
          (tx) =>
            tx.customer.findFirst({
              where: { id: payload.customerId, deletedAt: null },
              select: { email: true, firstName: true },
            }),
          payload.tenantId,
        );
        if (!customer) return;
        await this.issueCredential({
          tenantId: payload.tenantId,
          customerId: payload.customerId,
          source: 'contract_signed',
          label: 'Acceso',
          recipientEmail: customer.email ?? null,
          scope: { customer: { firstName: customer.firstName ?? '' } },
          entityId: payload.contractId,
        });
      });
    } catch (err) {
      this.logger.warn(`contract_pre_opening_started: ${String(err)}`);
    }
  }

  /** Traslado de trastero: el acceso del inquilino pasa a abrir el trastero nuevo. */
  @OnEvent(DOMAIN_EVENTS.contract_unit_changed, { async: true, promisify: true })
  async onContractUnitChanged(payload: ContractUnitChangedPayload): Promise<void> {
    try {
      const changed = await this.credentials.rescopeForCustomer(
        payload.tenantId,
        payload.customerId,
      );
      if (changed > 0)
        this.logger.log(
          `contract_unit_changed: ${changed} credencial(es) del customer=${payload.customerId} con el trastero nuevo`,
        );
    } catch (err) {
      this.logger.warn(`contract_unit_changed: ${String(err)}`);
    }
  }

  /**
   * Al finalizar/cancelar un contrato, revoca las credenciales de acceso del
   * inquilino SI no le queda ningún contrato `active`/`ending`. Las credenciales
   * son por-customer (no por-contrato): si tiene un segundo trastero vigente,
   * NO se le corta el acceso. Cierra el agujero de un ex-inquilino con PIN vivo.
   */
  @OnEvent(DOMAIN_EVENTS.contract_ended, { async: true, promisify: true })
  async onContractEnded(payload: DomainEventPayload): Promise<void> {
    const customerId = payload.customerId;
    if (!customerId) return;
    // ¿Le queda algún contrato vivo? El que acaba de terminar ya está en BD como
    // ended/cancelled, así que un count de active/ending lo excluye.
    const liveContracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.count({
          where: {
            customerId,
            status: { in: ['active', 'ending'] },
            ...STARTED_CONTRACT_WHERE,
            deletedAt: null,
          },
        }),
      payload.tenantId,
    );
    if (liveContracts > 0) {
      this.logger.log(
        `contract_ended: customer=${customerId} conserva ${liveContracts} contrato(s) vivo(s); no se revoca el acceso`,
      );
      return;
    }
    try {
      const revoked = await this.credentials.revokeAllForCustomer(payload.tenantId, customerId);
      if (revoked > 0) {
        this.logger.log(
          `contract_ended: revocadas ${revoked} credencial(es) del customer=${customerId} (sin contratos vivos)`,
        );
      }
    } catch (err) {
      // Best-effort: no romper el fin de contrato; el repaso periódico lo completa.
      this.logger.warn(`contract_ended: no se pudo revocar todo: ${String(err)}`);
    }
  }
}
