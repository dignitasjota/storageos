import { ConflictException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

import { AccessCredentialsService } from '../access/access-credentials.service';
import { InvoiceSeriesService } from '../billing/invoice-series.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PaymentsService } from '../payments/payments.service';

import type {
  PortalAccessCredentialDto,
  PortalNightPassDto,
  PortalNightPassInfoDto,
} from '@storageos/shared';

/**
 * Pase nocturno: el inquilino compra desde su portal un código de **un solo
 * uso** que **salta el toque de queda** del local y caduca a la mañana
 * siguiente. Se le **factura** el importe (opt-in por tenant, precio + IVA 21%).
 */
@Injectable()
export class NightPassService {
  private readonly logger = new Logger(NightPassService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly credentials: AccessCredentialsService,
    private readonly invoices: InvoicesService,
    private readonly series: InvoiceSeriesService,
    private readonly payments: PaymentsService,
  ) {}

  async info(tenantId: string): Promise<PortalNightPassInfoDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { nightPassEnabled: true, nightPassPrice: true },
    });
    return {
      enabled: tenant?.nightPassEnabled ?? false,
      price: Number(tenant?.nightPassPrice ?? 0),
    };
  }

  /** Historial de pases nocturnos comprados por el inquilino. */
  async history(tenantId: string, customerId: string): Promise<PortalNightPassDto[]> {
    const rows = await this.admin.accessCredential.findMany({
      where: {
        tenantId,
        customerId,
        metadata: { path: ['source'], equals: 'night_pass' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        usesCount: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    const now = new Date();
    return rows.map((r) => {
      let status: PortalNightPassDto['status'];
      if (r.usesCount >= 1) status = 'used';
      else if (
        r.status === 'revoked' ||
        r.status === 'expired' ||
        (r.expiresAt !== null && r.expiresAt < now)
      ) {
        status = 'expired';
      } else {
        status = 'active';
      }
      return {
        id: r.id,
        status,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Compra un pase nocturno. Decisión de negocio («cobrar en el acto»): el pase
   * es un PIN usable de inmediato, así que si tiene precio se **cobra ya** contra
   * el método de pago por defecto del inquilino; si no hay método o el cobro
   * falla, NO se entrega (se revoca el PIN y se anula la factura).
   *
   * Reglas de dinero:
   *  - Precio 0 (pase gratuito) → se emite sin cobro.
   *  - Precio > 0 sin método cobrable → 400 `no_payment_method` ANTES de emitir
   *    el PIN (no se entrega nada).
   *  - Cobro `succeeded`/`processing` → entrega OK.
   *  - Cobro `failed`/`pending` o error del gateway → se revoca el PIN + se
   *    anula la factura + 402 `payment_failed`.
   */
  async buy(tenantId: string, customerId: string): Promise<PortalAccessCredentialDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt || !tenant.nightPassEnabled) {
      throw new ConflictException({
        code: 'night_pass_disabled',
        message: 'El pase nocturno no está disponible',
      });
    }
    const price = Number(tenant.nightPassPrice);

    // Pase gratuito: nada que cobrar, se emite directamente.
    if (price <= 0) {
      return this.credentials.createNightPassForCustomer(tenantId, customerId);
    }

    // Cobro en el acto: exige método de pago cobrable ANTES de emitir el PIN.
    await this.payments.assertChargeableDefaultMethod(tenantId, customerId);

    const credential = await this.credentials.createNightPassForCustomer(tenantId, customerId);

    // Emitir la factura del pase. Si falla (p. ej. sin serie por defecto), no
    // podemos cobrar → revocamos el PIN y avisamos.
    let invoiceId: string;
    try {
      invoiceId = await this.invoiceNightPass(tenantId, customerId, price);
    } catch (err) {
      await this.revokeCredential(tenantId, credential.id);
      this.logger.warn(
        `[night-pass] no se pudo facturar tenant=${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ConflictException({
        code: 'night_pass_billing_failed',
        message: 'No se pudo emitir la factura del pase. Contacta con tu gestor.',
      });
    }

    // Cobrar en el acto contra el método por defecto.
    let payment;
    try {
      payment = await this.payments.chargeInvoice({
        tenantId,
        userId: null,
        invoiceId,
        input: {},
        meta: {},
      });
    } catch (err) {
      await this.revertNightPass(tenantId, credential.id, invoiceId);
      throw err;
    }
    // succeeded / processing (SEPA/GoCardless liquidan en días) → entregado.
    const delivered = payment.status === 'succeeded' || payment.status === 'processing';
    if (!delivered) {
      await this.revertNightPass(tenantId, credential.id, invoiceId);
      throw new HttpException(
        {
          code: 'payment_failed',
          message: 'No se pudo cobrar tu método de pago. El pase no se ha emitido.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return credential;
  }

  /** Emite la factura del pase (F1, IVA 21%) y devuelve su id. Lanza si no hay serie. */
  private async invoiceNightPass(
    tenantId: string,
    customerId: string,
    price: number,
  ): Promise<string> {
    const series = await this.series.getDefault(tenantId);
    if (!series) {
      throw new ConflictException({
        code: 'default_series_required',
        message: 'No hay serie de facturación por defecto para emitir el pase',
      });
    }
    const due = new Date();
    due.setDate(due.getDate() + 7);
    const invoice = await this.invoices.create({
      tenantId,
      userId: null,
      input: {
        invoiceType: 'F1',
        customerId,
        seriesId: series.id,
        dueDate: due.toISOString().slice(0, 10),
        items: [
          {
            description: 'Pase nocturno (acceso fuera de horario)',
            quantity: 1,
            unitPrice: price,
            taxRate: 21,
          },
        ],
        verifactuMode: 'verifactu',
      },
      meta: {},
    });
    await this.invoices.issue({ tenantId, userId: null, invoiceId: invoice.id, meta: {} });
    return invoice.id;
  }

  /** Revoca el PIN del pase (best-effort, no enmascara el error de cobro). */
  private async revokeCredential(tenantId: string, credentialId: string): Promise<void> {
    try {
      await this.credentials.revoke({ tenantId, userId: 'system', id: credentialId, meta: {} });
    } catch (err) {
      this.logger.error(
        `[night-pass] no se pudo revocar la credencial ${credentialId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Revierte un pase no cobrado: revoca el PIN + anula su factura. */
  private async revertNightPass(
    tenantId: string,
    credentialId: string,
    invoiceId: string,
  ): Promise<void> {
    await this.revokeCredential(tenantId, credentialId);
    try {
      await this.invoices.cancel({
        tenantId,
        userId: null,
        invoiceId,
        input: { reason: 'Pase nocturno no cobrado' },
        meta: {},
      });
    } catch (err) {
      this.logger.error(
        `[night-pass] no se pudo anular la factura ${invoiceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
