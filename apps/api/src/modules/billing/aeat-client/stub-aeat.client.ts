import { Injectable, Logger } from '@nestjs/common';

import {
  AeatClient,
  type GetStatusArgs,
  type GetStatusResult,
  type SendInvoiceArgs,
  type SendInvoiceResult,
} from './aeat-client';

/**
 * Cliente de pruebas que NO envia nada. Marca `accepted` con CSV
 * sintético. Usado en dev/test/CI mientras no se dispone de certificado
 * AEAT real.
 */
@Injectable()
export class StubAeatClient extends AeatClient {
  private readonly logger = new Logger(StubAeatClient.name);

  get mode(): 'stub' {
    return 'stub';
  }

  async sendInvoice(args: SendInvoiceArgs): Promise<SendInvoiceResult> {
    const csv = `STUB-${args.invoiceId.slice(0, 8).toUpperCase()}`;
    this.logger.debug(`[aeat_stub] invoice=${args.invoiceNumber} accepted con CSV=${csv}`);
    return {
      status: 'accepted',
      csv,
      message: 'Stub: AEAT_MODE=stub, sin envio real',
      raw: { mode: 'stub', emitterTaxId: args.emitterTaxId, hash: args.hash },
    };
  }

  async getStatus(_args: GetStatusArgs): Promise<GetStatusResult> {
    return { status: 'accepted', message: 'Stub mode' };
  }
}
