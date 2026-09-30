import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { AccessCredentialsService } from './access-credentials.service';

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
    const { facilityIds, unitIds, unitCode, facilityName } = await this.resolveCustomerScope(
      args.tenantId,
      args.customerId,
    );
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
      meta: {},
    });
    if (!args.recipientEmail || !created.revealedSecret) {
      this.logger.warn(
        `${args.source}: credencial creada pero no se envia email (sin recipient o sin secret) tenant=${args.tenantId}`,
      );
      return;
    }
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
        tenant: { name: await this.tenantName(args.tenantId) },
      },
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
  }> {
    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: { customerId, status: { in: ['active', 'ending'] }, deletedAt: null },
          orderBy: { startDate: 'desc' },
          select: {
            unitId: true,
            unit: {
              select: { code: true, facilityId: true, facility: { select: { name: true } } },
            },
          },
        }),
      tenantId,
    );
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
    };
  }

  private async tenantName(tenantId: string): Promise<string> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return t?.name ?? '';
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

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(payload: DomainEventPayload): Promise<void> {
    if (!payload.customerId) return;
    const customerId = payload.customerId;
    try {
      // 1. Reactiva SOLO las credenciales suspendidas por impago (no las que el
      //    staff suspendió por seguridad). Idempotente si no hay ninguna.
      await this.credentials.resume({
        tenantId: payload.tenantId,
        userId: null,
        customerId,
        onlyIfReasonStartsWith: 'dunning:',
        meta: {},
      });
      // 2. Auto-emisión al primer pago: solo si el inquilino aún no tiene
      //    NINGÚN acceso propio (p. ej. reserva online «pago primero»). Un
      //    acceso suspendido por el staff, una tarjeta o una cara cuentan: no se
      //    le da un PIN nuevo en cada factura pagada. Sin contratos vivos
      //    tampoco se emite (lo comprueba issueCredential).
      if (!(await this.hasOwnCredential(payload.tenantId, customerId))) {
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
      this.logger.log(
        `invoice.paid: credenciales reactivadas/emitidas (si procede) tenant=${payload.tenantId} customer=${customerId}`,
      );
    } catch (err) {
      this.logger.warn(
        `invoice.paid resume fallo tenant=${payload.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Llamado desde `DunningService.executeAction` cuando el `action_type`
   * es `access_block`. No usa EventEmitter porque el dunning quiere saber
   * si la suspension tuvo exito antes de marcar la action como executed.
   */
  async suspendForDunning(args: {
    tenantId: string;
    customerId: string;
    invoiceId: string;
  }): Promise<void> {
    await this.credentials.suspend({
      tenantId: args.tenantId,
      userId: null,
      customerId: args.customerId,
      input: { reason: `dunning:invoice-${args.invoiceId}` },
      meta: {},
    } as Parameters<AccessCredentialsService['suspend']>[0]);
    this.logger.log(
      `access_block ejecutado tenant=${args.tenantId} customer=${args.customerId} invoice=${args.invoiceId}`,
    );
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
    const active = await this.credentials.listForCustomer(payload.tenantId, customerId);
    for (const cred of active) {
      try {
        await this.credentials.revoke({
          tenantId: payload.tenantId,
          userId: null,
          id: cred.id,
          meta: {},
        });
      } catch (err) {
        // Best-effort: no romper el fin de contrato si una credencial falla.
        this.logger.warn(
          `contract_ended: no se pudo revocar credential ${cred.id}: ${String(err)}`,
        );
      }
    }
    if (active.length > 0) {
      this.logger.log(
        `contract_ended: revocadas ${active.length} credencial(es) del customer=${customerId} (sin contratos vivos)`,
      );
    }
  }
}
