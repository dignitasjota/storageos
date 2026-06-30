import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { AccessCredentialsService } from '../access/access-credentials.service';
import { InvoiceSeriesService } from '../billing/invoice-series.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

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

  /** Emite el pase (código single-use) y lo factura (best-effort). */
  async buy(tenantId: string, customerId: string): Promise<PortalAccessCredentialDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt || !tenant.nightPassEnabled) {
      throw new ConflictException({
        code: 'night_pass_disabled',
        message: 'El pase nocturno no está disponible',
      });
    }
    const credential = await this.credentials.createNightPassForCustomer(tenantId, customerId);
    const price = Number(tenant.nightPassPrice);
    if (price > 0) {
      await this.invoiceNightPass(tenantId, customerId, price).catch((err) =>
        this.logger.warn(
          `[night-pass] no se pudo facturar tenant=${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    return credential;
  }

  private async invoiceNightPass(
    tenantId: string,
    customerId: string,
    price: number,
  ): Promise<void> {
    const series = await this.series.getDefault(tenantId);
    if (!series) {
      this.logger.warn(`[night-pass] tenant ${tenantId} sin serie; no se factura`);
      return;
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
  }
}
