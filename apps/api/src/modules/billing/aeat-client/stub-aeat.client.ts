import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../../database/prisma-admin.service';

import {
  AeatClient,
  type GetStatusArgs,
  type GetStatusResult,
  type SendBatchArgs,
  type SendBatchResult,
  type SendInvoiceResult,
} from './aeat-client';

/**
 * Cliente de pruebas que NO envía nada: da por registrado todo el envío, con
 * un CSV sintético (`STUB-…`), y no pide esperar entre envíos. Usado en
 * dev/test/CI mientras no se dispone de certificado AEAT real.
 */
@Injectable()
export class StubAeatClient extends AeatClient {
  private readonly logger = new Logger(StubAeatClient.name);

  constructor(private readonly admin: PrismaAdminService) {
    super();
  }

  get mode(): 'stub' {
    return 'stub';
  }

  async sendBatch(args: SendBatchArgs): Promise<SendBatchResult> {
    const csv = `STUB-${randomBytes(4).toString('hex').toUpperCase()}`;
    const results: Record<string, SendInvoiceResult> = {};
    for (const id of args.invoiceIds) {
      results[id] = { status: 'accepted', csv, message: 'Stub: AEAT_MODE=stub, sin envio real' };
    }
    this.logger.debug(`[aeat_stub] ${args.invoiceIds.length} registros aceptados con CSV=${csv}`);
    return {
      outcome: 'sent',
      emitterTaxId: await this.emitterTaxId(args),
      recordCount: args.invoiceIds.length,
      status: 'accepted',
      csv,
      waitSeconds: 0,
      message: 'Stub: AEAT_MODE=stub, sin envio real',
      results,
      raw: { mode: 'stub' },
    };
  }

  async getStatus(_args: GetStatusArgs): Promise<GetStatusResult> {
    return { status: 'accepted', message: 'Stub mode' };
  }

  private async emitterTaxId(args: SendBatchArgs): Promise<string> {
    if (args.ownerId) {
      const owner = await this.admin.owner.findUnique({
        where: { id: args.ownerId },
        select: { taxId: true },
      });
      return owner?.taxId ?? '';
    }
    const tenant = await this.admin.tenant.findUnique({
      where: { id: args.tenantId },
      select: { taxId: true },
    });
    return tenant?.taxId ?? '';
  }
}
