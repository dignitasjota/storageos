import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';

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
  ) {}

  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onContractSigned(payload: DomainEventPayload): Promise<void> {
    if (!payload.customerId) return;
    const scope = (payload.scope ?? {}) as {
      customer?: { firstName?: string };
      contract?: { number?: string };
      unit?: { code?: string };
      facility?: { name?: string };
      tenant?: { name?: string };
    };
    try {
      const created = await this.credentials.create({
        tenantId: payload.tenantId,
        userId: 'system',
        input: {
          customerId: payload.customerId,
          method: 'pin',
          label: scope.contract?.number ? `Contrato ${scope.contract.number}` : null,
          allowedFacilityIds: [],
          allowedUnitIds: [],
          allowedHours: {},
          metadata: { source: 'contract_signed', entityId: payload.entityId },
        } as Parameters<AccessCredentialsService['create']>[0]['input'],
        meta: {},
      });
      if (!payload.recipientEmail || !created.revealedSecret) {
        this.logger.warn(
          `contract.signed: credencial creada pero no se envia email (sin recipient o sin secret) tenant=${payload.tenantId}`,
        );
        return;
      }
      await this.communications.enqueue({
        tenantId: payload.tenantId,
        channel: 'email',
        recipient: payload.recipientEmail,
        templateCode: 'access_credential_issued_email',
        variables: {
          customer: scope.customer ?? {},
          credential: { secret: created.revealedSecret },
          unit: scope.unit ?? {},
          facility: scope.facility ?? {},
          tenant: scope.tenant ?? {},
        },
        customerId: payload.customerId,
        source: 'access.contract_signed',
      });
      this.logger.log(
        `contract.signed: credencial PIN emitida + email encolado tenant=${payload.tenantId} customer=${payload.customerId}`,
      );
    } catch (err) {
      this.logger.error(
        `contract.signed: fallo en integracion access tenant=${payload.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(payload: DomainEventPayload): Promise<void> {
    if (!payload.customerId) return;
    try {
      await this.credentials.resume({
        tenantId: payload.tenantId,
        userId: 'system',
        customerId: payload.customerId,
        onlyIfReasonStartsWith: 'dunning:',
        meta: {},
      } as Parameters<AccessCredentialsService['resume']>[0]);
      this.logger.log(
        `invoice.paid: credenciales reactivadas (si las habia) tenant=${payload.tenantId} customer=${payload.customerId}`,
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
}
