import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
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
    const created = await this.credentials.create({
      tenantId: args.tenantId,
      userId: 'system',
      input: {
        customerId: args.customerId,
        method: 'pin',
        label: args.label,
        allowedFacilityIds: [],
        allowedUnitIds: [],
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
        unit: args.scope.unit ?? {},
        facility: args.scope.facility ?? {},
        tenant: args.scope.tenant ?? {},
      },
      customerId: args.customerId,
      source: `access.${args.source}`,
    });
    this.logger.log(
      `${args.source}: credencial PIN emitida + email encolado tenant=${args.tenantId} customer=${args.customerId}`,
    );
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
      // 1. Reactiva credenciales suspendidas por impago.
      await this.credentials.resume({
        tenantId: payload.tenantId,
        userId: 'system',
        customerId,
        onlyIfReasonStartsWith: 'dunning:',
        meta: {},
      } as Parameters<AccessCredentialsService['resume']>[0]);
      // 2. Auto-emisión al primer pago: si el inquilino aún no tiene ninguna
      //    credencial activa (p. ej. modelo "pago primero"), le emite un PIN.
      const active = await this.credentials.listForCustomer(payload.tenantId, customerId);
      if (active.length === 0) {
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
      userId: 'system',
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
          userId: 'system',
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
