import { Body, Controller, HttpCode, HttpStatus, Post, VERSION_NEUTRAL } from '@nestjs/common';

import { Public } from '../../../common/decorators/public.decorator';

import { RedsysService } from './redsys.service';

/**
 * Notificación servidor-a-servidor de Redsys (`Ds_Merchant_MerchantURL`).
 * Llega como `application/x-www-form-urlencoded`. Fuera del versioning para
 * que la URL `/webhooks/redsys` sea estable.
 */
@Public()
@Controller({ path: 'webhooks/redsys', version: VERSION_NEUTRAL })
export class RedsysWebhookController {
  constructor(private readonly redsys: RedsysService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Body()
    body: {
      Ds_SignatureVersion?: string;
      Ds_MerchantParameters?: string;
      Ds_Signature?: string;
    },
  ): Promise<{ received: true }> {
    await this.redsys.handleNotification(body);
    return { received: true };
  }
}
